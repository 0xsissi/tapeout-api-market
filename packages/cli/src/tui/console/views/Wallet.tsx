import { PAYMENT_TOKEN, PAYMENT_NATIVE_SYMBOL, PAYMENT_NETWORK_NAME, PAYMENT_FUNDING_HELP } from '@clawmarket/shared';
import { Box, useInput } from 'ink';
import { Text } from '../../../i18n/Text.js';
import { useEffect, useRef, useState } from 'react';

import type { CliDefaults } from '../../../config/store.js';
import {
  executePurchase,
  executeWithdrawCancel,
  executeWithdrawComplete,
  executeWithdrawRequest,
} from '../../../services/buyer.js';
import { theme } from '../../../theme.js';
import { parseMicroUsdc, shortenAddress } from '../../../utils.js';
import { checkWalletGas } from '../../../wallet/gas-check.js';
import { ensureStoredWallet, importStoredWallet } from '../../../wallet/store.js';
import { copyToClipboard } from '../../helpers/clipboard.js';
import { formatTxLink } from '../../helpers/tx-link.js';
import { FocusedSelectInput } from '../components/FocusedSelectInput.js';
import type { ModalState, PromptModalState, ConsoleSnapshot } from '../types.js';

export function WalletView({
  config,
  snapshot,
  isFocused,
  onOpenPrompt,
  onOpenModal,
  onActionError,
  onPushEvent,
  onRefresh,
}: {
  config: CliDefaults;
  snapshot: ConsoleSnapshot;
  isFocused: boolean;
  onOpenPrompt: (modal: PromptModalState) => void;
  onOpenModal: (modal: ModalState) => void;
  onActionError: (message: string | null) => void;
  onPushEvent: (scope: string, message: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const runWalletAction = async (task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await task(); } finally { busyRef.current = false; setBusy(false); }
  };
  const [localWalletAddress, setLocalWalletAddress] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const buyerSummary = snapshot.buyerSummary;
  const pendingWithdraw = buyerSummary?.pendingWithdraw ?? null;
  const minGasWei = parseMinGasWei(config.buyer.minGasWei);
  const currentAddress = buyerSummary?.address ?? localWalletAddress ?? null;
  const runningBuyerMismatch = Boolean(
    buyerSummary?.address
      && localWalletAddress
      && buyerSummary.address.toLowerCase() !== localWalletAddress.toLowerCase(),
  );
  const gasLow = buyerSummary?.nativeBalanceWei
    ? BigInt(buyerSummary.nativeBalanceWei) < minGasWei
    : false;

  useEffect(() => {
    void ensureStoredWallet({
      walletPath: config.paths.walletPath,
      legacyWalletPath: config.paths.legacySellerWalletPath,
    })
      .then((result) => {
        setLocalWalletAddress(result.wallet.address);
      })
      .catch(() => {
        setLocalWalletAddress(null);
      });
  }, [config.paths.legacySellerWalletPath, config.paths.walletPath]);

  useInput((input) => {
    const key = input.toLowerCase();
    if (!isFocused || busyRef.current) {
      return;
    }

    if (key === 'c') {
      void copyAddress();
      return;
    }
    if (key === 'e') {
      void openExport();
      return;
    }
    if (key === 'i') {
      openImport();
      return;
    }
    if (key === '1') {
      onPushEvent('钱包', '打开充值表单。');
      openDeposit();
      return;
    }
    if (key === '2') {
      onPushEvent('钱包', '打开提现请求表单。');
      openWithdrawRequest();
      return;
    }
    if (key === '3') {
      onPushEvent('钱包', '尝试完成提现。');
      void completeWithdraw().catch(error => onActionError(error instanceof Error ? error.message : String(error)));
      return;
    }
    if (key === '4') {
      onPushEvent('钱包', '尝试取消提现请求。');
      void cancelWithdraw().catch(error => onActionError(error instanceof Error ? error.message : String(error)));
    }
  });

  const copyAddress = async () => {
    if (!currentAddress) {
      setCopyMessage('还没有可复制的钱包地址。');
      return;
    }

    const copied = await copyToClipboard(currentAddress);
    const message = copied ? '已复制到剪贴板。' : '复制失败，请手动复制上面的地址。';
    setCopyMessage(message);
    onPushEvent('钱包', message);
  };

  const withBuyerSummary = <T,>(task: (summary: NonNullable<typeof buyerSummary>) => Promise<T> | T) => {
    if (!buyerSummary) {
      throw new Error('请先在总览启动买家服务，再查看余额或充值。');
    }
    return task(buyerSummary);
  };

  const withGasCheck = async (task: () => Promise<void>) => {
    if (!localWalletAddress) {
      throw new Error('本地钱包还没准备好。');
    }
    if (runningBuyerMismatch) throw new Error('钱包已切换，请先重启买家服务，让新钱包生效后再操作资金。');

    const gas = await checkWalletGas(localWalletAddress as `0x${string}`, minGasWei);
    if (gas.ok) {
      await task();
      return;
    }

    onOpenModal({
      type: 'confirm',
      title: ('ETH gas 不足').replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL),
      description: [
        (`当前余额：${gas.currentEth} ETH`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL),
        (`预计需要：${gas.minEth} ETH`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL),
        `钱包地址：${gas.address}`,
        PAYMENT_FUNDING_HELP,
      ].join('\n'),
      confirmLabel: '我已充值，继续',
      cancelLabel: '取消',
      onConfirm: async () => {
        const next = await checkWalletGas(localWalletAddress as `0x${string}`, minGasWei);
        if (!next.ok) throw new Error(`${PAYMENT_NATIVE_SYMBOL} 手续费余额仍不足，请补充后重试。`);
        await task();
      },
    });
  };

  const openDeposit = () => {
    onActionError(null);
    onOpenPrompt({
      type: 'prompt',
      title: '充值可用预算',
      description: (`钱包 USDC：${buyerSummary?.usdcBalance ?? '--'}。输入要充值为可用预算的 USDC 数量。`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL),
      placeholder: '5',
      initialValue: '',
      onSubmit: async (value) => {
        const amount = value.trim();
        await withBuyerSummary(async (summary) => {
          validatePositiveAmount(amount, '请输入大于 0 的充值金额。');
          if (parseMicroUsdc(amount) > parseMicroUsdc(summary.usdcBalance)) {
            throw new Error((`充值金额不能超过钱包 USDC 余额 ${summary.usdcBalance}。`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL));
          }

          onPushEvent('钱包', (`收到充值请求：${amount} USDC。`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL));
          await withGasCheck(async () => {
            onPushEvent('钱包', '⏳ 上链中...');
            const result = await executePurchase(config.buyer.url, amount);
            if (result.approvalTx) {
              onPushEvent('钱包', `步骤 1/2：代币授权已确认 ${formatTxLink(result.approvalTx)}`);
            }
            onPushEvent('钱包', `步骤 ${result.approvalTx ? '2/2' : '1/1'}：充值已确认 ${formatTxLink(result.depositTx)}`);
            await onRefresh();
            onPushEvent('钱包', `充值成功：${amount} ${PAYMENT_TOKEN.symbol} 已成为 API 可用预算。`);
          });
        });
      },
    });
  };

  const openWithdrawRequest = () => {
    onActionError(null);
    onOpenPrompt({
      type: 'prompt',
      title: '退回钱包',
      description: [
        (`API 可用预算：${buyerSummary?.escrowAvailable ?? '--'} USDC`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL),
        '发起后需要等待 48 小时才能完成提现。等待期间可以取消。',
      ].join('\n'),
      placeholder: '5',
      initialValue: '',
      onSubmit: async (value) => {
        const amount = value.trim();
        await withBuyerSummary(async (summary) => {
          validatePositiveAmount(amount, '请输入大于 0 的提现金额。');
          if (parseMicroUsdc(amount) > parseMicroUsdc(summary.escrowAvailable)) {
            throw new Error(`提现金额不能超过 API 可用预算余额 ${summary.escrowAvailable}。`);
          }

          await withGasCheck(async () => {
            onPushEvent('钱包', '⏳ 提现请求上链中...');
            const result = await executeWithdrawRequest(config.buyer.url, amount);
            onPushEvent('钱包', `提现请求已提交：${formatTxLink(result.tx)}`);
            await onRefresh();
          });
        });
      },
    });
  };

  const completeWithdraw = () => runWalletAction(async () => {
    onActionError(null);
    if (!pendingWithdraw) {
      onActionError('当前没有进行中的提现请求。');
      return;
    }
    if (pendingWithdraw.unlocksAt > Date.now()) {
      onActionError(`提现还没到期，${formatRemainingTime(pendingWithdraw.unlocksAt - Date.now())} 后可完成。`);
      return;
    }

    await withGasCheck(async () => {
      onPushEvent('钱包', '⏳ 正在完成提现...');
      const result = await executeWithdrawComplete(config.buyer.url);
      onPushEvent('钱包', `提现完成：${formatTxLink(result.tx)}`);
      await onRefresh();
    });
  });

  const cancelWithdraw = () => runWalletAction(async () => {
    onActionError(null);
    if (!pendingWithdraw) {
      onActionError('当前没有进行中的提现请求。');
      return;
    }

    await withGasCheck(async () => {
      onPushEvent('钱包', '⏳ 正在取消提现请求...');
      const result = await executeWithdrawCancel(config.buyer.url);
      onPushEvent('钱包', `提现请求已取消：${formatTxLink(result.tx)}`);
      await onRefresh();
    });
  });

  const openExport = async () => {
    const wallet = await ensureStoredWallet({
      walletPath: config.paths.walletPath,
      legacyWalletPath: config.paths.legacySellerWalletPath,
    });
    onOpenModal({
      type: 'wallet-export',
      address: wallet.wallet.address,
      privateKey: wallet.wallet.privateKey,
    });
  };

  const openImport = () => {
    onOpenModal({
      type: 'wallet-import',
      currentAddress: localWalletAddress,
      onSubmit: async (value) => {
        const result = await importStoredWallet(value, {
          walletPath: config.paths.walletPath,
          backupExisting: true,
        });
        setLocalWalletAddress(result.wallet.address);
        onPushEvent('钱包', `已导入新钱包：${result.wallet.address}`);
        onPushEvent('钱包', '如果 buyer / seller 正在运行，请重启后让新钱包生效。');
        await onRefresh();
      },
    });
  };

  const actionItems = [
    { label: '[1] 充值可用预算', value: 'deposit' },
    { label: '[2] 退回钱包', value: 'withdraw-request' },
    { label: '[3] 完成提现（到期后可用）', value: 'withdraw-complete' },
    { label: '[4] 取消提现请求', value: 'withdraw-cancel' },
    { label: '[E] 导出私钥', value: 'export' },
    { label: '[I] 导入私钥', value: 'import' },
  ];

  return (
    <Box flexDirection="column">
      <Text>地址：{currentAddress ?? '准备中…'}  [C] 复制</Text>
      <Text>网络：{PAYMENT_NETWORK_NAME}</Text>
      <Text color={theme.muted}>{PAYMENT_FUNDING_HELP}</Text>
      {runningBuyerMismatch ? (
        <Box marginTop={1}>
          <Text color={theme.accent}>当前本地钱包与运行中的 buyer 地址不同，重启 buyer / seller 后才会切换到新钱包。</Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text>余额</Text>
        <Text color={theme.muted}>钱包余额需要充值后才成为 API 可用预算；未使用的预算可申请退回钱包。</Text>
        <Text>钱包余额 {PAYMENT_TOKEN.symbol}： {buyerSummary?.usdcBalance ?? '--'}</Text>
        <Text>
          钱包 {PAYMENT_NATIVE_SYMBOL}：  {buyerSummary?.nativeBalance ?? '--'}
          {gasLow ? '  手续费余额不足' : ''}
        </Text>
        <Text>API 可用预算：{buyerSummary?.escrowAvailable ?? '--'}</Text>
        <Text>
          正在退回钱包：{pendingWithdraw?.amount ?? '0'}
          {pendingWithdraw ? `  ${pendingWithdraw.unlocksAt > Date.now() ? `⏳ 还剩 ${formatRemainingTime(pendingWithdraw.unlocksAt - Date.now())}` : '✓ 可完成提现'}` : ''}
        </Text>
      </Box>
      {copyMessage ? (
        <Box marginTop={1}>
          <Text color={copyMessage.startsWith('已复制') ? theme.primary : theme.accent}>{copyMessage}</Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text>操作</Text>
        <FocusedSelectInput
          isFocused={isFocused && !busy}
          items={actionItems}
          onSelect={async (item) => {
            if (busyRef.current) return;
            try {
              switch (item.value) {
                case 'deposit':
                  openDeposit();
                  return;
                case 'withdraw-request':
                  openWithdrawRequest();
                  return;
                case 'withdraw-complete':
                  await completeWithdraw();
                  return;
                case 'withdraw-cancel':
                  await cancelWithdraw();
                  return;
                case 'export':
                  await openExport();
                  return;
                case 'import':
                  openImport();
              }
            } catch (error) {
              onActionError(error instanceof Error ? error.message : String(error));
            }
          }}
        />
      </Box>
      {busy ? <Text color={theme.accent}>正在处理，请等待交易确认…</Text> : null}
      <Box marginTop={1}>
        <Text color={theme.muted}>
          {currentAddress ? `本地钱包：${shortenAddress(currentAddress)}。` : '正在准备本地钱包。'}
        </Text>
      </Box>
    </Box>
  );
}

function validatePositiveAmount(amount: string, message: string): void {
  if (!amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    throw new Error(message);
  }
  const fraction = amount.split('.')[1] ?? '';
  if (!/^\d+(\.\d+)?$/.test(amount) || fraction.length > PAYMENT_TOKEN.decimals) throw new Error(`金额最多 ${PAYMENT_TOKEN.decimals} 位小数。`);
}

function parseMinGasWei(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function formatRemainingTime(remainingMs: number): string {
  const totalMinutes = Math.max(0, Math.ceil(remainingMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

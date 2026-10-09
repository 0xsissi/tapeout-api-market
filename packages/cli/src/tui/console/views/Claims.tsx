import { PAYMENT_TOKEN, PAYMENT_NATIVE_SYMBOL, PAYMENT_NETWORK_NAME, PAYMENT_FUNDING_HELP } from '@clawmarket/shared';
import { Box } from 'ink';
import { Text, getUiLocale } from '../../../i18n/Text.js';
import { useRef, useState } from 'react';

import type { CliDefaults } from '../../../config/store.js';
import { addressFromPrivateKey } from '../../../services/chain.js';
import { executeFlushClaims } from '../../../services/seller.js';
import { shortenAddress, readPrivateKeyFromWallet } from '../../../utils.js';
import { checkWalletGas } from '../../../wallet/gas-check.js';
import { theme } from '../../../theme.js';
import { formatTxLink } from '../../helpers/tx-link.js';
import { FocusedSelectInput } from '../components/FocusedSelectInput.js';
import type { ConsoleSnapshot, ModalState } from '../types.js';

export function ClaimsView({
  config,
  snapshot,
  isFocused,
  onOpenModal,
  onPushEvent,
  onRefresh,
}: {
  config: CliDefaults;
  snapshot: ConsoleSnapshot;
  isFocused: boolean;
  onOpenModal: (modal: ModalState) => void;
  onPushEvent: (scope: string, message: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const preview = snapshot.sellerSummary?.claims.preview ?? [];
  const claims = snapshot.sellerSummary?.claims;
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);

  const flushClaims = async () => {
    const privateKey = await readPrivateKeyFromWallet(config.seller.walletPath, 'seller wallet');
    const gas = await checkWalletGas(addressFromPrivateKey(privateKey), BigInt(config.seller.minGasWei));
    if (!gas.ok) {
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
          const refreshed = await checkWalletGas(gas.address, BigInt(config.seller.minGasWei));
          if (!refreshed.ok) throw new Error(`${PAYMENT_NETWORK_NAME} 手续费余额仍不足，请到账后再收款。`);
          const result = await executeFlushClaims(config.seller.url);
          onPushEvent('卖家', result.flushed && result.txHash ? `收款已确认： ${formatTxLink(result.txHash)}` : result.claims.queuedCount > 0 ? '尚有待收款收入，但本次未确认结算。请查看手续费余额与链上记录。' : '当前没有可结算收入。');
          await onRefresh();
        },
      });
      return;
    }

    const result = await executeFlushClaims(config.seller.url);
    onPushEvent('卖家', result.flushed && result.txHash ? `收款已确认： ${formatTxLink(result.txHash)}` : result.claims.queuedCount > 0 ? '尚有待收款收入，但本次未确认结算。请查看手续费余额与链上记录。' : '当前没有可结算收入。');
    await onRefresh();
  };

  return (
    <Box flexDirection="column">
      <Text>
        {snapshot.sellerSummary
          ? (`待收款：${snapshot.sellerSummary.claims.queuedCount} 笔 / ${snapshot.sellerSummary.claims.queuedAmountUsdc} USDC`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL)
          : '请先在总览启动卖家服务。'}
      </Text>
      {snapshot.sellerSummary?.wallet ? (
        <Box marginTop={1} flexDirection="column">
          <Text>累计结算金额（含协议手续费）：{claims?.settledAmountUsdc ?? '--'} {PAYMENT_TOKEN.symbol} / {claims?.settledCount ?? 0} 笔</Text>
          <Text>卖家钱包 {PAYMENT_TOKEN.symbol}：{snapshot.sellerSummary.wallet.usdcBalance}</Text>
          <Text color={theme.muted}>结算金额包含协议手续费；实际到账以钱包余额和链上交易为准。</Text>
          <Text>自动收款已开启；检查间隔：每 {formatInterval(claims?.autoFlushIntervalMs)} 一次</Text>
          <Text>自动上链：满 {claims?.autoFlushMinAmountUsdc ?? '--'} {PAYMENT_TOKEN.symbol} 或临近过期</Text>
          <Text>
            最近提交收款：
            {snapshot.sellerSummary.claims.lastFlushTxHash
              ? ` ${formatTxLink(snapshot.sellerSummary.claims.lastFlushTxHash)}`
              : ' 暂无'}
          </Text>
          <Text>
            最近确认结算：
            {claims?.lastClaimTxHash
              ? ` ${formatTxLink(claims.lastClaimTxHash)}`
              : ' 暂无'}
          </Text>
          <Text>
            最近结算金额（含手续费）：
            {claims?.lastClaimedAmountUsdc ?? '0'} {PAYMENT_TOKEN.symbol}
            {claims?.lastClaimedAt ? ` · ${formatTimestamp(claims.lastClaimedAt)}` : ''}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text>{preview.length > 0 ? preview.slice(0, 8).map((claim) => (`${claim.amountUsdc} USDC <- ${shortenAddress(claim.buyer)} 订单编号=${claim.nonce}`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL)).join('\n') : '暂无待收款订单。'}</Text>
      </Box>
      <Box marginTop={1}>
        <FocusedSelectInput
          isFocused={isFocused && !busy}
          items={[
            { label: '立即收款', value: 'flush' },
            { label: '刷新', value: 'refresh' },
          ]}
          onSelect={async (item) => {
            if (busyRef.current) return;
            busyRef.current = true; setBusy(true); setError(null);
            try {
            if (item.value === 'refresh') {
              await onRefresh();
              return;
            }

            await flushClaims();
            } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
            finally { busyRef.current = false; setBusy(false); }
          }}
        />
      </Box>
      {busy ? <Text color={theme.accent}>正在结算，请等待链上确认…</Text> : null}
      {error ? <Text color={theme.danger}>{error}</Text> : null}
    </Box>
  );
}

function formatInterval(intervalMs?: number): string {
  if (!intervalMs || intervalMs <= 0) {
    return '--';
  }
  if (intervalMs % 60_000 === 0) {
    return `${intervalMs / 60_000} 分钟`;
  }
  return `${(intervalMs / 1000).toFixed(0)} 秒`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(getUiLocale(), { hour12: false });
}

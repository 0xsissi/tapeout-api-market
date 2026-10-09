import { normalizeModelPricing, PAYMENT_TOKEN, PAYMENT_NATIVE_SYMBOL, PAYMENT_NETWORK_NAME, PAYMENT_FUNDING_HELP, PAYMENT_FUNDING_LINKS } from '@clawmarket/shared';
import { useEffect, useState } from 'react';
import { Box, useInput } from 'ink';
import { Text, getUiLocale } from '../../../i18n/Text.js';

import { defaultSellerModels, type ClawMarketConfig, type SellerUpstream } from '../../../config/schema.js';
import type { CliDefaults } from '../../../config/store.js';
import { inspectAuthDir, type AuthInspection } from '../../../runtime/auth-inspector.js';
import { stopSellerRuntime } from '../../../runtime/seller-runtime.js';
import { addressFromPrivateKey } from '../../../services/chain.js';
import { executeFlushClaims } from '../../../services/seller.js';
import { readPrivateKeyFromWallet } from '../../../utils.js';
import { checkWalletGas } from '../../../wallet/gas-check.js';
import { formatTxLink } from '../../helpers/tx-link.js';
import { FocusedSelectInput } from '../components/FocusedSelectInput.js';
import type { ConsoleSnapshot, ModalState, PromptModalState } from '../types.js';
import type { ConsoleViewId } from '../lib.js';

export function SellerView({
  config,
  snapshot,
  isFocused,
  onPushEvent,
  onRefresh,
  onSetView,
  onOpenPrompt,
  onOpenModal,
  onUpdateConfig,
  onRequestSellerLogin,
  onActionError,
  sellerStarting,
  onStartSeller,
}: {
  config: CliDefaults;
  snapshot: ConsoleSnapshot;
  isFocused: boolean;
  onPushEvent: (scope: string, message: string) => void;
  onRefresh: () => Promise<void>;
  onSetView: (viewId: ConsoleViewId) => void;
  onOpenPrompt: (modal: PromptModalState) => void;
  onOpenModal: (modal: ModalState) => void;
  onUpdateConfig: (config: ClawMarketConfig) => Promise<void>;
  onRequestSellerLogin: (request: { upstream: SellerUpstream; replaceAuth: boolean; restartSeller: boolean; forceFreshLogin?: boolean }) => void;
  onActionError: (message: string | null) => void;
  sellerStarting: boolean;
  onStartSeller: (config?: CliDefaults) => Promise<void>;
}) {
  const status = snapshot.sellerSummary;
  const models = config.seller.models.join(', ') || 'none';
  const baseRates = normalizeModelPricing({ model: 'seller', inputPer1m: config.seller.pricing.input, outputPer1m: config.seller.pricing.output, p0: config.seller.pricing.p0 });
  const pendingRates = status?.backend.models.some(model => Math.abs(model.inputPer1m - baseRates.inputPer1m) > 0.00000001 || Math.abs(model.outputPer1m - baseRates.outputPer1m) > 0.00000001);
  const [currentAuth, setCurrentAuth] = useState<AuthInspection | null>(null);

  useEffect(() => {
    let cancelled = false;
    void inspectAuthDir(config.seller.cliproxyAuthDir)
      .then((inspection) => {
        if (!cancelled) {
          setCurrentAuth(inspection);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCurrentAuth(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [config.seller.cliproxyAuthDir]);

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
          ...PAYMENT_FUNDING_LINKS,
        ].join('\n'),
        confirmLabel: '我已充值，继续',
        cancelLabel: '取消',
        onConfirm: async () => {
          const result = await executeFlushClaims(config.seller.url);
          onPushEvent('卖家', result.flushed && result.txHash ? `已提交 claim: ${formatTxLink(result.txHash)}` : '当前没有待提交 claims。');
          await onRefresh();
        },
      });
      return;
    }

    const result = await executeFlushClaims(config.seller.url);
    onPushEvent('卖家', result.flushed && result.txHash ? `已提交 claim: ${formatTxLink(result.txHash)}` : '当前没有待提交 claims。');
  };

  const openPricingPrompts = () => {
    onOpenPrompt({
      type: 'prompt',
      title: 'Edit seller p0',
      initialValue: String(config.seller.pricing.p0 ?? config.seller.pricing.input),
      description: (`底价，将对 ${models} 共享生效。单位：USDC / 1M tokens。`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL),
      onSubmit: (p0Value) => {
        const p0 = parsePositivePrice(p0Value, config.seller.pricing.p0 ?? config.seller.pricing.input, 'p0');
        onOpenPrompt({
          type: 'prompt',
          title: 'Edit seller alpha',
          initialValue: String(config.seller.pricing.alpha ?? 1),
          description: 'CUC 价格曲线斜率。0 = 固定价，1 = 默认，>1 = 更陡。',
          onSubmit: (alphaValue) => {
            const alpha = parseNonNegativeNumber(alphaValue, config.seller.pricing.alpha ?? 1, 'alpha');
            onOpenPrompt({
              type: 'prompt',
              title: 'Edit seller maxConcurrent',
              initialValue: String(config.seller.pricing.maxConcurrent ?? 5),
              description: '本地 admission 上限；超过后会限流。',
              onSubmit: async (maxConcurrentValue) => {
                const maxConcurrent = parsePositiveInteger(
                  maxConcurrentValue,
                  config.seller.pricing.maxConcurrent ?? 5,
                  'maxConcurrent',
                );
                const { paths, ...configBody } = config;
                const rates = normalizeModelPricing({ model: 'seller', inputPer1m: config.seller.pricing.input, outputPer1m: config.seller.pricing.output, p0 });
                const nextConfig: ClawMarketConfig = {
                  ...configBody,
                  seller: {
                    ...configBody.seller,
                    pricing: {
                      ...configBody.seller.pricing,
                      input: rates.inputPer1m,
                      output: rates.outputPer1m,
                      p0,
                      alpha,
                      maxConcurrent,
                    },
                  },
                };
                await onUpdateConfig(nextConfig);
                if (!snapshot.sellerService.online) {
                  onPushEvent('设置', `AIMM 参数已保存：p0=${p0} alpha=${alpha} maxConcurrent=${maxConcurrent}，下次启动 seller 时生效。`);
                  return;
                }
                onPushEvent('设置', `AIMM 参数已更新为 p0=${p0} alpha=${alpha} maxConcurrent=${maxConcurrent}，需要重启 seller 才会生效。`);
                onOpenModal({
                  type: 'confirm',
                  title: '现在重启 seller 应用新的 AIMM 参数？',
                  description: '运行中的 seller 只在启动时读取定价与容量参数；重启后 /v1/seller/status 才会显示新值。',
                  confirmLabel: '重启',
                  cancelLabel: '稍后',
                  onConfirm: async () => {
                    const nextRuntimeConfig = { ...config, ...nextConfig };
                    const stopped = await stopSellerRuntime((line) => onPushEvent('卖家', line));
                    if (!stopped) throw new Error('价格已保存；当前 seller 由其他进程运行，请在启动它的终端重启。');
                    await onStartSeller(nextRuntimeConfig);
                    onPushEvent('卖家', '已重启，应用新的 AIMM 参数。');
                  },
                });
              },
            });
          },
        });
      },
    });
  };

  const openLoginConfirm = (upstream: SellerUpstream) => {
    const presets = upstream === config.seller.upstream && config.seller.models.length ? config.seller.models : defaultSellerModels(upstream);
    onOpenModal({
      type: 'confirm',
      title: `切换并登录 ${upstreamLabel(upstream)}？`,
      description: [
        `这会把 seller 切到 ${upstreamLabel(upstream)}，模型改为：${presets.join(', ')}。`,
        '当前登录文件会自动备份，然后打开新的登录流程；登录完成后会自动重启 seller。',
      ].join('\n'),
      confirmLabel: '开始登录',
      cancelLabel: '取消',
      onConfirm: async () => {
        onRequestSellerLogin({
          upstream,
          replaceAuth: true,
          restartSeller: true,
          forceFreshLogin: upstream === 'codex',
        });
      },
    });
  };

  useInput((input) => {
    if (isFocused && input.toLowerCase() === 'p') {
      openPricingPrompts();
    }
  });

  return (
    <Box flexDirection="column">
      <Text>报价与收款：{PAYMENT_TOKEN.symbol} · {PAYMENT_NETWORK_NAME}；在“设置”里选择 USDC 或 BEM。</Text>
      <Text>额度：单次 {config.settlement.maxRequestCostToken} / 未确认 {config.settlement.maxUnconfirmedCreditToken} / 每日 {config.settlement.dailyLimitToken} {PAYMENT_TOKEN.symbol}</Text>
      <Box borderStyle="single" paddingX={1} flexDirection="column">
        <Text>AIMM 定价</Text>
        <Text>输入 / 输出底价: {baseRates.inputPer1m} / {baseRates.outputPer1m} {PAYMENT_TOKEN.symbol} / 1M tokens</Text>
        <Text>p0      : {config.seller.pricing.p0 ?? config.seller.pricing.input} {PAYMENT_TOKEN.symbol} / 1M tokens   [p] 修改</Text>
        <Text>alpha   : {config.seller.pricing.alpha ?? 1}</Text>
        <Text>max conc: {config.seller.pricing.maxConcurrent ?? 5}</Text>
        <Text>生效范围: {models}</Text>
        {pendingRates ? <Text color="yellow">运行中的卖家还未应用底价，请重启卖家。</Text> : null}
      </Box>
      {status ? (
        <Box marginTop={1} borderStyle="single" paddingX={1} flexDirection="column">
          <Text>收益概览</Text>
          <Text>待 claim : {status.claims.queuedAmountUsdc} {PAYMENT_TOKEN.symbol} / {status.claims.queuedCount} 笔</Text>
          <Text>已 claim : {status.claims.settledAmountUsdc} {PAYMENT_TOKEN.symbol} / {status.claims.settledCount} 笔</Text>
          <Text>钱包到账 : {status.wallet?.usdcBalance ?? '--'} {PAYMENT_TOKEN.symbol}</Text>
          <Text>自动检查: 每 {formatInterval(status.claims.autoFlushIntervalMs)} 一次</Text>
          <Text>自动上链: 满 {status.claims.autoFlushMinAmountUsdc ?? '--'} {PAYMENT_TOKEN.symbol} 或临近过期</Text>
          <Text>
            最近 claim: {status.claims.lastClaimedAmountUsdc ?? '0'} {PAYMENT_TOKEN.symbol}
            {status.claims.lastClaimedAt ? ` · ${formatTimestamp(status.claims.lastClaimedAt)}` : ''}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
      <Text>{status ? `Wallet: ${status.seller.walletAddress}` : 'Seller 尚未启动。'}</Text>
      <Text>{status ? `Reachability: ${status.reachability?.label ?? 'checking'}` : snapshot.sellerService.message}</Text>
      <Text>{status ? `Models: ${status.backend.models.map((item) => item.model).join(', ') || 'none'}` : ''}</Text>
      <Text>
        当前账号：{currentAuth?.upstream ? upstreamLabel(currentAuth.upstream) : upstreamLabel(config.seller.upstream)} · {currentAuth?.identity ?? (currentAuth?.hasAuth ? 'unknown' : '未登录')}
      </Text>
      </Box>
      <Box marginTop={1}>
        <FocusedSelectInput
          isFocused={isFocused}
          items={[
            { label: sellerStarting ? 'seller 正在启动…' : snapshot.sellerService.online ? 'Flush claims' : '启动 seller', value: 'primary' },
            { label: '修改当前定价', value: 'pricing' },
            { label: '换 Codex 账号 / 卖 ChatGPT', value: 'login-codex' },
            { label: '登录 Claude / 卖 Claude', value: 'login-claude' },
            { label: '登录 Gemini / 卖 Gemini', value: 'login-gemini' },
            { label: '查看 API 使用说明', value: 'usage' },
          ]}
          onSelect={async (item) => {
            if (item.value === 'pricing') {
              openPricingPrompts();
              return;
            }

            if (item.value === 'primary') {
              if (!snapshot.sellerService.online) {
                if (sellerStarting) return;
                onActionError(null);
                try {
                  await onStartSeller();
                } catch (error) {
                  if (error instanceof Error && error.name === 'AbortError') return;
                  const message = error instanceof Error ? error.message : String(error);
                  onActionError(message);
                  onPushEvent('卖家', message.split('\n')[0]!);
                }
                return;
              }

              await flushClaims();
              return;
            }

            if (item.value === 'login-codex') {
              openLoginConfirm('codex');
              return;
            }

            if (item.value === 'login-claude') {
              openLoginConfirm('claude');
              return;
            }

            if (item.value === 'login-gemini') {
              openLoginConfirm('gemini');
              return;
            }

            onSetView('usage');
          }}
        />
      </Box>
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

function upstreamLabel(upstream: SellerUpstream): string {
  switch (upstream) {
    case 'codex':
      return 'Codex / ChatGPT';
    case 'claude':
      return 'Claude';
    case 'gemini':
      return 'Gemini';
  }
}

function parsePrice(value: string, fallback: number, label: string): number {
  const trimmed = value.trim();
  const parsed = trimmed ? Number(trimmed) : fallback;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} 必须是合法非负数字。`);
  }
  return parsed;
}

function parsePositivePrice(value: string, fallback: number, label: string): number {
  const parsed = parsePrice(value, fallback, label);
  if (parsed <= 0) {
    throw new Error(`${label} 必须大于 0。`);
  }
  return parsed;
}

function parseNonNegativeNumber(value: string, fallback: number, label: string): number {
  const trimmed = value.trim();
  const parsed = trimmed ? Number(trimmed) : fallback;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} 必须是合法且大于等于 0 的数字。`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, fallback: number, label: string): number {
  const trimmed = value.trim();
  const parsed = trimmed ? Number(trimmed) : fallback;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} 必须是正整数。`);
  }
  return parsed;
}

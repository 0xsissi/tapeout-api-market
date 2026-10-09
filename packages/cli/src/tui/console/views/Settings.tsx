import { Box } from 'ink';
import { Text } from '../../../i18n/Text.js';
import { useEffect, useState } from 'react';
import { PAYMENT_TOKEN, PAYMENT_NETWORK_NAME } from '@clawmarket/shared';
import { readPaymentChoice, savePaymentChoice, type PaymentSymbol } from '../../../payment/selection.js';

import type { ClawMarketConfig } from '../../../config/schema.js';
import type { CliDefaults } from '../../../config/store.js';
import { getDefaultSellerRuntimeOptions, startSellerRuntime, stopSellerRuntime } from '../../../runtime/seller-runtime.js';
import { theme } from '../../../theme.js';
import { FocusedSelectInput } from '../components/FocusedSelectInput.js';
import { applySetting, getSettingValue, getSettingsItems, type ConsoleSettingKey } from '../settings.js';
import type { ConsoleSnapshot, ModalState, PromptModalState } from '../types.js';
import { useUiLanguage } from '../../../i18n/Text.js';
import { saveUiLanguage } from '../../../i18n/language.js';

export function SettingsView({
  config,
  snapshot,
  settingsError,
  isFocused,
  onOpenPrompt,
  onOpenModal,
  onSettingsError,
  onPushEvent,
  onUpdateConfig,
  onSelectModel,
}: {
  config: CliDefaults;
  snapshot: ConsoleSnapshot;
  settingsError: string | null;
  isFocused: boolean;
  onOpenPrompt: (modal: PromptModalState) => void;
  onOpenModal: (modal: ModalState) => void;
  onSettingsError: (message: string | null) => void;
  onPushEvent: (scope: string, message: string) => void;
  onUpdateConfig: (config: ClawMarketConfig) => Promise<void>;
  onSelectModel: (model: string) => Promise<void>;
}) {
  const language = useUiLanguage();
  const [nextSymbol, setNextSymbol] = useState<PaymentSymbol | null>(null);
  useEffect(() => { void readPaymentChoice(config.paths.homeDir).then(setNextSymbol).catch(error => onSettingsError(error instanceof Error ? error.message : String(error))); }, [config.paths.homeDir]);
  const items = [
    { label: language === 'zh' ? '界面语言：中文（切换到 English）' : 'Language: English (switch to Chinese)', value: 'ui:language' },
    { label: '选择 USDC 报价和收款（下次启动）', value: 'payment:USDC' },
    { label: '选择 BEM 报价和收款（下次启动）', value: 'payment:BEM' },
    ...getSettingsItems(config, snapshot.selectedModel),
  ];

  return (
    <Box flexDirection="column">
      <Text>当前报价与收款：{PAYMENT_TOKEN.symbol} · {PAYMENT_NETWORK_NAME}</Text>
      <Text>已保存的下次启动币种：{nextSymbol ?? '未选择（默认 USDC）'}</Text>
      <Text color={theme.muted}>配置保存到 {config.paths.configPath}。</Text>
      <Text color={theme.muted}>切换币种在下次启动生效；两种币的价格、额度与余额独立，不自动兑换。</Text>
      <Text color={theme.muted}>seller.cliproxyAuthDir = {config.seller.cliproxyAuthDir}</Text>
      <Box marginTop={1}>
        <FocusedSelectInput
          isFocused={isFocused}
          limit={8}
          items={items}
          onSelect={async (item) => {
            if (item.value === 'ui:language') {
              try { await saveUiLanguage(language === 'en' ? 'zh' : 'en', config.paths.homeDir); onSettingsError(null); }
              catch (error) { onSettingsError(error instanceof Error ? error.message : String(error)); }
              return;
            }
            if (item.value.startsWith('payment:')) {
              try {
                const symbol = item.value.slice(8) as PaymentSymbol;
                await savePaymentChoice(symbol, config.paths.homeDir);
                setNextSymbol(symbol);
                onPushEvent('币种', `已选择 ${symbol}，退出后重新启动 TAM 生效；现有请求和待收款继续使用原币种。显式 --payment-token 参数优先。`);
                onSettingsError(null);
              } catch (error) { onSettingsError(error instanceof Error ? error.message : String(error)); }
              return;
            }
            const key = item.value as ConsoleSettingKey;
            const initialValue = getSettingValue(config, key);
            onOpenPrompt({
              type: 'prompt',
              title: `Edit ${key}`,
              initialValue,
              onSubmit: async (nextValue) => {
                onSettingsError(null);
                const nextConfig = applySetting(config, key, nextValue, snapshot.selectedModel);
                await onUpdateConfig(nextConfig);
                if (key === 'buyer.selectedModel') {
                  await onSelectModel(nextValue);
                }
                onPushEvent('设置', `${key} 已更新`);
                if (key.startsWith('settlement.')) onPushEvent('结算', '结算配置已保存，重新启动 TAM 后生效。启动前会核对链、币种与合约；不会转移旧余额或待收款。');
                if (
                  key === 'seller.pricing.input' ||
                  key === 'seller.pricing.output' ||
                  key === 'seller.pricing.p0' ||
                  key === 'seller.pricing.alpha' ||
                  key === 'seller.pricing.maxConcurrent'
                ) {
                  onPushEvent('设置', `${key} 已更新为 ${nextValue}，需要重启 seller 才会生效。`);
                  onOpenModal({
                    type: 'confirm',
                    title: '现在重启 seller 应用新的 AIMM 参数？',
                    description: '运行中的 seller 只在启动时读取定价与容量参数；重启后 /v1/seller/status 才会显示新值。',
                    confirmLabel: '重启',
                    cancelLabel: '稍后',
                    onConfirm: async () => {
                      const nextRuntimeConfig = { ...config, ...nextConfig };
                      await stopSellerRuntime((line) => onPushEvent('卖家', line));
                      await startSellerRuntime({
                        ...getDefaultSellerRuntimeOptions(nextRuntimeConfig),
                        report: (line) => onPushEvent('卖家', line),
                      });
                      onPushEvent('卖家', '已重启，应用新价格。');
                    },
                  });
                }
              },
            });
          }}
        />
      </Box>
      {settingsError ? (
        <Box marginTop={1}>
          <Text color={theme.danger}>错误: {settingsError}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

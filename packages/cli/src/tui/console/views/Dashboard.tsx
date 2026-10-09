import { PAYMENT_TOKEN, PAYMENT_NATIVE_SYMBOL } from '@clawmarket/shared';
import { Box } from 'ink';
import { Text } from '../../../i18n/Text.js';

import type { CliDefaults } from '../../../config/store.js';
import { buildChatPrompt } from '../chat-prompt.js';
import { executeFlushClaims } from '../../../services/seller.js';
import { theme } from '../../../theme.js';
import { shortenAddress, shortenPeerId } from '../../../utils.js';
import { formatTxLink } from '../../helpers/tx-link.js';
import { FocusedSelectInput } from '../components/FocusedSelectInput.js';
import type { PromptModalState, ChatEntry, ConsoleSnapshot } from '../types.js';
import type { ConsoleViewId } from '../lib.js';
import { formatProviderPrice, getSelectedProvider } from '../lib.js';

export function DashboardView({
  config,
  snapshot,
  isFocused,
  actionError,
  onOpenPrompt,
  onActionError,
  onAppendChat,
  onReplaceLastChat,
  onPushEvent,
  onRefresh,
  buyerStarting,
  onStartBuyer,
  onSetView,
  sellerStarting,
  onStartSeller,
}: {
  config: CliDefaults;
  snapshot: ConsoleSnapshot;
  isFocused: boolean;
  actionError: string | null;
  onOpenPrompt: (modal: PromptModalState) => void;
  onActionError: (message: string | null) => void;
  onAppendChat: (entry: ChatEntry) => void;
  onReplaceLastChat: (entry: ChatEntry) => void;
  onPushEvent: (scope: string, message: string) => void;
  onRefresh: () => Promise<void>;
  buyerStarting: boolean;
  onStartBuyer: () => Promise<void>;
  onSetView: (viewId: ConsoleViewId) => void;
  sellerStarting: boolean;
  onStartSeller: () => Promise<void>;
}) {
  const provider = getSelectedProvider(snapshot.networkSummary, snapshot.selectedModel);

  return (
    <Box flexDirection="column">
      <Text>买家：{buyerStarting ? '正在启动或连接…' : snapshot.buyerService.online ? (`在线，余额 ${snapshot.buyerSummary?.escrowAvailable ?? '--'} USDC`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL) : snapshot.buyerService.message}</Text>
      <Text>
        卖家：{snapshot.sellerService.online
          ? (`待收款 ${snapshot.sellerSummary?.claims.queuedAmountUsdc ?? '--'} USDC · 累计结算 ${snapshot.sellerSummary?.claims.settledAmountUsdc ?? '--'} USDC`).replaceAll('USDC', PAYMENT_TOKEN.symbol).replaceAll('ETH', PAYMENT_NATIVE_SYMBOL)
          : snapshot.sellerService.message}
      </Text>
      {snapshot.sellerQuotaWarning ? (
        <Text color={theme.danger}>{snapshot.sellerQuotaMessage ?? 'Seller upstream quota may be exhausted. Switch accounts in Accounts.'}</Text>
      ) : null}
      <Text>当前模型：{snapshot.selectedModel}</Text>
      <Text>
        P2P: {provider
          ? `${shortenPeerId(provider.peerId)} / ${shortenAddress(provider.walletAddress)} | ${formatProviderPrice(provider)}`
          : '暂无可用 seller'}
      </Text>
      <Box marginTop={1}>
        <FocusedSelectInput
          isFocused={isFocused}
          items={[
            { label: '发送一条聊天消息', value: 'chat' },
            { label: buyerStarting ? '买家正在启动，请稍候…' : snapshot.buyerService.online ? '充值可用预算' : '启动买家服务', value: 'buyer-action' },
            { label: sellerStarting ? '卖家正在启动，请稍候…' : snapshot.sellerService.online ? '查看收入 / 收款' : '启动卖家服务', value: 'seller-action' },
          ]}
          onSelect={async (item) => {
            try {
              onActionError(null);
              if (item.value === 'chat') {
                onOpenPrompt(buildChatPrompt({ config, model: snapshot.selectedModel, onAppendChat, onReplaceLastChat, onPushEvent }));
                return;
              }

              if (item.value === 'buyer-action') {
                if (buyerStarting) return;
                if (!snapshot.buyerService.online) {
                  await onStartBuyer();
                  return;
                }

                onSetView('wallet');
                return;
              }

              if (!snapshot.sellerService.online) {
                await onStartSeller();
                return;
              }

              onSetView('claims');
            } catch (error) {
              if (error instanceof Error && error.name === 'AbortError') return;
              const message = error instanceof Error ? error.message : String(error);
              onActionError(message);
              onPushEvent('错误', message.split('\n')[0] ?? message);
            }
          }}
        />
      </Box>
      {actionError ? (
        <Box marginTop={1}>
          <Text color={theme.danger}>错误: {actionError}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

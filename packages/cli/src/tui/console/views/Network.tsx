import { Box } from 'ink';
import { Text } from '../../../i18n/Text.js';
import { PAYMENT_TOKEN, PAYMENT_NETWORK_NAME } from '@clawmarket/shared';

import { shortenAddress, shortenPeerId } from '../../../utils.js';
import { FocusedSelectInput } from '../components/FocusedSelectInput.js';
import type { ConsoleSnapshot } from '../types.js';
import { formatProviderPrice, getAvailableModels, getSelectedProvider } from '../lib.js';

export function NetworkView({
  snapshot,
  isFocused,
  onSelectModel,
}: {
  snapshot: ConsoleSnapshot;
  isFocused: boolean;
  onSelectModel: (model: string) => Promise<void>;
}) {
  const models = getAvailableModels(snapshot.networkSummary);
  const selectedProvider = getSelectedProvider(snapshot.networkSummary, snapshot.selectedModel);

  return (
    <Box flexDirection="column">
      <Text>支付筛选：{PAYMENT_TOKEN.symbol} · {PAYMENT_NETWORK_NAME}；仅选择相同币种与托管池的卖家。</Text>
      <Text>{snapshot.networkSummary ? `来源: ${snapshot.networkSummary.source ?? 'buyer'}  路由: ${snapshot.networkSummary.routingStrategy}` : '还没有网络状态。'}</Text>
      <Text>
        当前 seller: {selectedProvider
          ? `${shortenPeerId(selectedProvider.peerId)} / ${shortenAddress(selectedProvider.walletAddress)} | ${formatProviderPrice(selectedProvider)}`
          : '暂无'}
      </Text>
      <Box marginTop={1}>
        <FocusedSelectInput
          isFocused={isFocused}
          items={(models.length > 0 ? models : [snapshot.selectedModel]).map((model) => ({
            label: `${model}${model === snapshot.selectedModel ? ' (current)' : ''}`,
            value: model,
          }))}
          onSelect={async (item) => {
            await onSelectModel(item.value);
          }}
        />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text>
          {(snapshot.networkSummary?.models ?? [])
            .slice(0, 10)
            .map((item) => {
              const best = item.bestProvider
                ? ` -> ${shortenPeerId(item.bestProvider.peerId)} ${formatProviderPrice(item.bestProvider)}`
                : '';
              return `${item.model}: ${item.providerCount} seller${best}`;
            })
            .join('\n') || '没有发现 seller。'}
        </Text>
      </Box>
    </Box>
  );
}

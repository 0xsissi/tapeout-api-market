import { Box } from 'ink';
import { Text } from '../../../i18n/Text.js';

import type { CliDefaults } from '../../../config/store.js';
import { buildChatPrompt } from '../chat-prompt.js';
import { getSelectedProvider } from '../lib.js';
import { theme } from '../../../theme.js';
import { FocusedSelectInput } from '../components/FocusedSelectInput.js';
import type { ChatEntry, ConsoleSnapshot, PromptModalState } from '../types.js';
import { RawText } from '../../../i18n/Text.js';
import { getUiLanguage } from '../../../i18n/language.js';
import { translateUiText } from '@clawmarket/shared';

export function ChatView({
  config,
  snapshot,
  chatHistory,
  isFocused,
  onOpenPrompt,
  onAppendChat,
  onReplaceLastChat,
  onClearChat,
  onPushEvent,
}: {
  config: CliDefaults;
  snapshot: ConsoleSnapshot;
  chatHistory: ChatEntry[];
  isFocused: boolean;
  onOpenPrompt: (modal: PromptModalState) => void;
  onAppendChat: (entry: ChatEntry) => void;
  onReplaceLastChat: (entry: ChatEntry) => void;
  onClearChat: () => void;
  onPushEvent: (scope: string, message: string) => void;
}) {
  return (
    <Box flexDirection="column">
      <Text>当前模型: {snapshot.selectedModel}</Text>
      {!snapshot.buyerService.online ? <Text color={theme.accent}>买家尚未连接，请到“总览”启动买家服务。</Text>
        : !getSelectedProvider(snapshot.networkSummary, snapshot.selectedModel) ? <Text color={theme.accent}>尚未发现当前模型的可用卖家。可到“服务市场”切换模型，或稍后重试。</Text> : null}
      <Box marginTop={1} flexDirection="column">
        {chatHistory.length > 0 ? <RawText>{chatHistory.slice(-10).map((entry) => {
          const language = getUiLanguage();
          const label = entry.state === 'failed' && !entry.content ? '提示' : entry.role === 'user' ? '你' : '助手';
          const content = entry.content || (entry.state === 'pending' ? translateUiText('正在寻找卖家并等待回答…', language) : '');
          const error = entry.error ? translateUiText(entry.error, language) : '';
          return `${translateUiText(label, language)}: ${content}${error ? `${content ? '\n' : ''}${error}` : ''}${entry.usage ? `\n  ${entry.usage}` : ''}`;
        }).join('\n\n')}</RawText> : <Text>还没有对话。</Text>}
      </Box>
      <Box marginTop={1}>
        <FocusedSelectInput
          isFocused={isFocused}
          items={[
            { label: '发送消息', value: 'send' },
            { label: '清空历史', value: 'clear' },
          ]}
          onSelect={(item) => {
            if (item.value === 'clear') {
              onClearChat();
              onPushEvent('问答', '聊天历史已清空。');
              return;
            }

            onOpenPrompt(buildChatPrompt({ config, model: snapshot.selectedModel, history: chatHistory, onAppendChat, onReplaceLastChat, onPushEvent }));
          }}
        />
      </Box>
    </Box>
  );
}

import type { CliDefaults } from '../../config/store.js';
import { requestChatStream } from '../../services/buyer.js';
import type { ChatEntry, PromptModalState } from './types.js';

/** Only complete question/answer pairs may be sent back as model context. */
function completedTurns(history: ChatEntry[]) {
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (let i = 0; i + 1 < history.length; i++) {
    const question = history[i]!, answer = history[i + 1]!;
    if (question.role !== 'user' || answer.role !== 'assistant' || answer.state === 'failed' || answer.state === 'pending' || answer.content === '...' || !answer.content.trim()) continue;
    turns.push({ role: 'user', content: question.content }, { role: 'assistant', content: answer.content }); i++;
  }
  return turns.slice(-38);
}

export function buildChatPrompt({ config, model, history = [], onAppendChat, onReplaceLastChat, onPushEvent }: {
  config: CliDefaults; model: string; history?: ChatEntry[];
  onAppendChat: (entry: ChatEntry) => void; onReplaceLastChat: (entry: ChatEntry) => void;
  onPushEvent: (scope: string, message: string) => void;
}): PromptModalState {
  return {
    type: 'prompt', title: 'Chat', initialValue: '', placeholder: '输入问题',
    async onSubmit(value) {
      const promptText = value.trim();
      if (!promptText) throw new Error('消息不能为空。');
      onAppendChat({ role: 'user', content: promptText, state: 'complete' });
      onAppendChat({ role: 'assistant', content: '', state: 'pending' });
      let assistantText = '';
      try {
        const response = await requestChatStream({ url: config.buyer.url, model, promptText,
          messages: [...completedTurns(history), { role: 'user', content: promptText }] }, {
          onDelta(delta) { assistantText += delta; onReplaceLastChat({ role: 'assistant', content: assistantText, state: 'pending' }); },
        });
        const usage = response.usage ? `prompt=${response.usage.prompt_tokens} completion=${response.usage.completion_tokens} total=${response.usage.total_tokens}` : undefined;
        onReplaceLastChat({ role: 'assistant', content: response.choices?.[0]?.message?.content?.trim() || assistantText.trim() || '(empty response)', usage, state: 'complete' });
        onPushEvent('问答', `收到 ${model} 的流式回答。`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onReplaceLastChat({ role: 'assistant', content: assistantText, state: 'failed', error: message });
        onPushEvent('问答', `发送未完成：${message}`);
        throw error;
      }
    },
  };
}

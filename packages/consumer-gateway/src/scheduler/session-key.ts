import { createHash } from 'node:crypto';

import type { ChatCompletionRequest } from '@clawmarket/shared';

export type SessionKeySource = 'explicit' | 'user' | 'prompt_prefix' | 'none';

export interface SessionKeyResult {
  key: string | null;
  source: SessionKeySource;
}

export function deriveSessionKey(body: ChatCompletionRequest): SessionKeyResult {
  const explicitSessionId = body.session_id?.trim();
  if (explicitSessionId) {
    return { key: hashSessionKey(explicitSessionId), source: 'explicit' };
  }

  const user = body.user?.trim();
  if (user) {
    return { key: hashSessionKey(`${user}:${body.model}`), source: 'user' };
  }

  if (!Array.isArray(body.messages) || body.messages.length <= 1) {
    return { key: null, source: 'none' };
  }

  const prefix = body.messages
    .slice(0, -1)
    .map((message) => message.content)
    .join('\n')
    .trim();
  if (!prefix) {
    return { key: null, source: 'none' };
  }

  return { key: hashSessionKey(prefix), source: 'prompt_prefix' };
}

export function hashSessionKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

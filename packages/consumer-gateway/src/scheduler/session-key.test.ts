import { describe, expect, it } from 'vitest';

import { deriveSessionKey, hashSessionKey } from './session-key.js';

describe('deriveSessionKey', () => {
  it('prefers explicit session_id', () => {
    const result = deriveSessionKey({
      model: 'gpt-test',
      session_id: 'session-123',
      user: 'user-a',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result).toEqual({
      key: hashSessionKey('session-123'),
      source: 'explicit',
    });
  });

  it('hashes user and model together when user is present', () => {
    const result = deriveSessionKey({
      model: 'gpt-test',
      user: 'user-a',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result).toEqual({
      key: hashSessionKey('user-a:gpt-test'),
      source: 'user',
    });
  });

  it('derives a stable prompt prefix hash from all but the last message', () => {
    const first = deriveSessionKey({
      model: 'gpt-test',
      messages: [
        { role: 'system', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c1' },
      ],
    });
    const second = deriveSessionKey({
      model: 'gpt-test',
      messages: [
        { role: 'system', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c2' },
      ],
    });

    expect(first.source).toBe('prompt_prefix');
    expect(second.source).toBe('prompt_prefix');
    expect(first.key).toBe(second.key);
  });

  it('returns none for single-turn messages without user', () => {
    expect(
      deriveSessionKey({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).toEqual({ key: null, source: 'none' });
  });
});

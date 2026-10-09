import { describe, expect, it, vi } from 'vitest';

import { parseClaudeHeaders } from './ratelimit-header-parser.js';

describe('parseClaudeHeaders', () => {
  it('parses unified token headers', () => {
    vi.setSystemTime(new Date('2026-04-22T00:00:00.000Z'));
    const headers = new Headers({
      'anthropic-ratelimit-unified-tokens-limit': '100000',
      'anthropic-ratelimit-unified-tokens-remaining': '10000',
      'anthropic-ratelimit-unified-tokens-reset': '2026-04-22T01:00:00.000Z',
    });

    expect(parseClaudeHeaders(headers, 'auth-1')).toEqual({
      authIndex: 'auth-1',
      observedAt: Date.now(),
      tokensLimit: 100000,
      tokensRemaining: 10000,
      resetAt: new Date('2026-04-22T01:00:00.000Z').getTime(),
    });
  });

  it('falls back to request headers', () => {
    vi.setSystemTime(new Date('2026-04-22T00:00:00.000Z'));
    const headers = new Headers({
      'anthropic-ratelimit-requests-limit': '45',
      'anthropic-ratelimit-requests-remaining': '12',
    });

    expect(parseClaudeHeaders(headers, 'auth-1')).toEqual({
      authIndex: 'auth-1',
      observedAt: Date.now(),
      requestsLimit: 45,
      requestsRemaining: 12,
    });
  });
});

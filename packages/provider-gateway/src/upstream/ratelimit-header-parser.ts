export interface RateLimitSnapshot {
  authIndex: string;
  observedAt: number;
  requestsLimit?: number;
  requestsRemaining?: number;
  tokensLimit?: number;
  tokensRemaining?: number;
  resetAt?: number;
}

export function parseClaudeHeaders(headers: Headers, authIndex: string): RateLimitSnapshot | null {
  const unifiedTokensLimit = parseOptionalNumber(headers.get('anthropic-ratelimit-unified-tokens-limit'));
  const unifiedTokensRemaining = parseOptionalNumber(headers.get('anthropic-ratelimit-unified-tokens-remaining'));
  const unifiedTokensReset = headers.get('anthropic-ratelimit-unified-tokens-reset');

  if (unifiedTokensLimit != null || unifiedTokensRemaining != null) {
    return {
      authIndex,
      observedAt: Date.now(),
      tokensLimit: unifiedTokensLimit ?? undefined,
      tokensRemaining: unifiedTokensRemaining ?? undefined,
      resetAt: unifiedTokensReset ? new Date(unifiedTokensReset).getTime() : undefined,
    };
  }

  const requestsLimit = parseOptionalNumber(headers.get('anthropic-ratelimit-requests-limit'));
  const requestsRemaining = parseOptionalNumber(headers.get('anthropic-ratelimit-requests-remaining'));
  if (requestsLimit == null && requestsRemaining == null) {
    return null;
  }

  return {
    authIndex,
    observedAt: Date.now(),
    requestsLimit: requestsLimit ?? undefined,
    requestsRemaining: requestsRemaining ?? undefined,
  };
}

function parseOptionalNumber(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

import type { SubscriptionTier } from '@clawmarket/shared';

import type { ProbeResult } from './types.js';

export async function probeClaude(cliproxyUrl: string, authIndex: string): Promise<ProbeResult> {
  const response = await fetch(`${cliproxyUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-cliproxy-auth-index': authIndex,
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  }).catch(() => null);

  if (!response || !response.ok) {
    return { ok: false, reason: 'ping_failed' };
  }

  const unifiedLimit = response.headers.get('anthropic-ratelimit-unified-tokens-limit');
  if (unifiedLimit) {
    const limit = Number(unifiedLimit);
    const tier: SubscriptionTier =
      limit >= 800_000 ? 'claude-max-20x' :
      limit >= 200_000 ? 'claude-max-5x' :
      'claude-pro';
    return { ok: true, tier, evidence: { unifiedLimit: limit, source: 'header' } };
  }

  const requestLimit = response.headers.get('anthropic-ratelimit-requests-limit');
  if (requestLimit) {
    return {
      ok: true,
      tier: 'claude-pro',
      evidence: { reqLimit: Number(requestLimit), source: 'header' },
    };
  }

  return { ok: false, reason: 'no_ratelimit_header' };
}

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { SubscriptionTier } from '@clawmarket/shared';

import type { ProbeResult } from './types.js';

export async function probeGemini(credsPath?: string): Promise<ProbeResult> {
  const filePath = credsPath ?? join(homedir(), '.gemini', 'oauth_creds.json');
  let credentials: any;
  try {
    credentials = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return { ok: false, reason: 'creds_missing' };
  }

  const token: string | undefined = credentials?.access_token;
  if (!token) {
    return { ok: false, reason: 'no_access_token' };
  }

  const response = await fetch('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  }).catch(() => null);

  if (!response || !response.ok) {
    return { ok: false, reason: 'api_failed' };
  }

  const data = await response.json() as { currentTier?: { id?: string }; allowedTiers?: Array<{ id?: string }> };
  const userTier = data.currentTier?.id ?? data.allowedTiers?.[0]?.id;
  const map: Record<string, SubscriptionTier> = {
    'free-tier': 'gemini-free',
    'standard-tier': 'gemini-standard',
    'legacy-tier': 'gemini-paid',
  };
  const tier = userTier ? map[userTier] : undefined;
  if (!tier) {
    return { ok: false, reason: `unknown_tier:${userTier}` };
  }

  return { ok: true, tier, evidence: { userTier, source: 'loadCodeAssist' } };
}

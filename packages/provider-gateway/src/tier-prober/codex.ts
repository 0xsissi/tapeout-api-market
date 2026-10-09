import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SUBSCRIPTION_PRESETS, type SubscriptionTier } from '@clawmarket/shared';

import type { ProbeResult } from './types.js';

export async function probeCodex(authFilePath?: string): Promise<ProbeResult> {
  const filePath = authFilePath ?? join(homedir(), '.codex', 'auth.json');
  let auth: any;
  try {
    auth = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return { ok: false, reason: 'auth_file_missing' };
  }

  const idToken: string | undefined = auth?.tokens?.id_token;
  if (!idToken) {
    return { ok: false, reason: 'no_id_token' };
  }
  const [, payloadB64] = idToken.split('.');
  if (!payloadB64) {
    return { ok: false, reason: 'malformed_jwt' };
  }

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  const planType: string | undefined = payload?.['https://api.openai.com/auth']?.chatgpt_plan_type;
  if (!planType) {
    return { ok: false, reason: 'plan_type_missing' };
  }

  const tier = `chatgpt-${planType}` as SubscriptionTier;
  if (!(tier in SUBSCRIPTION_PRESETS)) {
    return { ok: false, reason: `unknown_plan:${planType}` };
  }

  return { ok: true, tier, evidence: { planType, source: 'jwt' } };
}

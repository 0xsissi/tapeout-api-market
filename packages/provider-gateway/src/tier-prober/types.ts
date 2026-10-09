import type { SubscriptionTier } from '@clawmarket/shared';

export type ProbeResult =
  | { ok: true; tier: SubscriptionTier; evidence: Record<string, unknown> }
  | { ok: false; reason: string };

import type { SchedulerConfig } from '@clawmarket/shared';

import type { ScoredProvider } from '../router.js';

export interface HardFilterResult {
  candidates: ScoredProvider[];
  reasons: Record<string, number>;
  explorationCandidates: ScoredProvider[];
}

export interface HardFilterInput {
  providers: ScoredProvider[];
  model: string;
  userMaxPrice?: number;
  excludedPeerIds?: Set<string>;
}

export function applyHardFilter(
  input: HardFilterInput,
  config: SchedulerConfig,
): HardFilterResult {
  const reasons: Record<string, number> = {};
  const candidates: ScoredProvider[] = [];
  const explorationCandidates: ScoredProvider[] = [];

  for (const provider of input.providers) {
    const peerId = provider.announcement.peerId;

    if (input.excludedPeerIds?.has(peerId)) {
      bumpReason(reasons, 'already_tried');
      continue;
    }

    const averagePrice =
      (provider.modelPricing.inputPer1m + provider.modelPricing.outputPer1m) / 2;
    if (typeof input.userMaxPrice === 'number' && averagePrice > input.userMaxPrice) {
      bumpReason(reasons, 'price_cap');
      continue;
    }

    if (provider.announcement.reputation.successRate < config.minSuccessRate) {
      bumpReason(reasons, 'low_success_rate');
      continue;
    }

    if (provider.announcement.reputation.score < config.minReputationScore) {
      if (
        provider.announcement.reputation.totalTransactions < 10 &&
        Math.random() < config.newSellerExplorationRate
      ) {
        explorationCandidates.push(provider);
        continue;
      }
      bumpReason(reasons, 'low_reputation');
      continue;
    }

    candidates.push(provider);
  }

  return { candidates, reasons, explorationCandidates };
}

function bumpReason(reasons: Record<string, number>, reason: string): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

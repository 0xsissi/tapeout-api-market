import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG } from './config.js';
import { applyHardFilter } from './hard-filter.js';
import type { ScoredProvider } from '../router.js';

function makeProvider(
  peerId: string,
  overrides?: Partial<ScoredProvider['announcement']['reputation']> & {
    inputPer1m?: number;
    outputPer1m?: number;
  },
): ScoredProvider {
  return {
    announcement: {
      peerId,
      walletAddress: '0x0000000000000000000000000000000000000001',
      publicKey: 'pubkey',
      models: [],
      region: 'apac',
      maxConcurrent: 5,
      stakeAmount: 100n,
      reputation: {
        score: overrides?.score ?? 90,
        totalTransactions: overrides?.totalTransactions ?? 50,
        successRate: overrides?.successRate ?? 0.99,
        avgLatencyMs: overrides?.avgLatencyMs ?? 120,
      },
      timestamp: Date.now(),
      signature: '0xsig',
    },
    modelPricing: {
      model: 'gpt-test',
      inputPer1m: overrides?.inputPer1m ?? 1,
      outputPer1m: overrides?.outputPer1m ?? 2,
    },
    score: 10,
  };
}

describe('applyHardFilter', () => {
  it('filters by price, success rate, reputation, and exclusion set', () => {
    const providers = [
      makeProvider('pricey', { inputPer1m: 9, outputPer1m: 9 }),
      makeProvider('flaky', { successRate: 0.5 }),
      makeProvider('newbie', { score: 30, totalTransactions: 50 }),
      makeProvider('excluded'),
      makeProvider('good'),
    ];

    const result = applyHardFilter(
      {
        providers,
        model: 'gpt-test',
        userMaxPrice: 5,
        excludedPeerIds: new Set(['excluded']),
      },
      DEFAULT_CONFIG,
    );

    expect(result.candidates.map((provider) => provider.announcement.peerId)).toEqual(['good']);
    expect(result.reasons).toEqual({
      price_cap: 1,
      low_success_rate: 1,
      low_reputation: 1,
      already_tried: 1,
    });
  });

  it('lets new sellers through the exploration bucket when sampled', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01);
    const result = applyHardFilter(
      {
        providers: [makeProvider('newbie', { score: 30, totalTransactions: 5 })],
        model: 'gpt-test',
      },
      { ...DEFAULT_CONFIG, newSellerExplorationRate: 0.05 },
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.explorationCandidates.map((provider) => provider.announcement.peerId)).toEqual([
      'newbie',
    ]);
  });

  it('produces an approximately correct exploration rate over many runs', () => {
    let counter = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => ((counter += 1) % 100) / 100);
    let explored = 0;
    for (let index = 0; index < 10_000; index++) {
      const result = applyHardFilter(
        {
          providers: [makeProvider(`peer-${index}`, { score: 30, totalTransactions: 5 })],
          model: 'gpt-test',
        },
        { ...DEFAULT_CONFIG, newSellerExplorationRate: 0.05 },
      );
      explored += result.explorationCandidates.length;
    }

    expect(explored).toBe(500);
  });

  it('applies excluded peers before any other checks', () => {
    const result = applyHardFilter(
      {
        providers: [makeProvider('peer-a', { successRate: 0.2, score: 10 })],
        model: 'gpt-test',
        excludedPeerIds: new Set(['peer-a']),
      },
      DEFAULT_CONFIG,
    );

    expect(result.reasons).toEqual({ already_tried: 1 });
  });
});

import { Wallet } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import { signQuote } from '@clawmarket/shared';

import { greedyPick, softmaxSample } from './softmax.js';

describe('softmax routing helpers', () => {
  const privateKey = Wallet.createRandom().privateKey as `0x${string}`;
  const makerAddress = new Wallet(privateKey).address as `0x${string}`;

  it('returns null for an empty quote set and the only quote for singleton sets', () => {
    expect(softmaxSample([])).toBeNull();
    const quote = makeQuote(2);
    expect(softmaxSample([quote])).toEqual(quote);
  });

  it('greedy pick always chooses the cheapest quote', () => {
    expect(greedyPick([makeQuote(4), makeQuote(2), makeQuote(3)])?.currentPrice).toBe(2);
  });

  it('biases toward cheaper quotes', () => {
    const quotes = [makeQuote(2), makeQuote(2.2), makeQuote(3), makeQuote(5), makeQuote(10)];
    const random = vi.spyOn(Math, 'random');
    const sequence = Array.from({ length: 1000 }, (_, index) => (index % 1000) / 1000);
    let cursor = 0;
    random.mockImplementation(() => sequence[cursor++] ?? 0.5);

    const counts = new Map<number, number>();
    for (let index = 0; index < 1000; index++) {
      const picked = softmaxSample(quotes, 3);
      counts.set(picked!.currentPrice, (counts.get(picked!.currentPrice) ?? 0) + 1);
    }

    random.mockRestore();
    expect((counts.get(2) ?? 0)).toBeGreaterThan(450);
    expect((counts.get(10) ?? 0)).toBeLessThan(50);
  });

  function makeQuote(currentPrice: number) {
    return signQuote({
      makerId: `maker-${currentPrice}`,
      makerAddress,
      nonce: `nonce-${currentPrice}`,
      model: 'claude-sonnet-4',
      p0: 2,
      alpha: 1,
      utilization: 0.2,
      maxConcurrent: 5,
      currentPrice,
      recentLatencyMs: 100,
      successRate: 0.99,
      timestamp: 1_700_000_000_000,
      ttlMs: 10_000,
      schemaVersion: 1,
    }, privateKey);
  }
});

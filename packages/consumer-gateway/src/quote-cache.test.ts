import { Wallet } from 'ethers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { signQuote } from '@clawmarket/shared';

import { LocalQuoteCache } from './quote-cache.js';

describe('LocalQuoteCache', () => {
  const privateKey = Wallet.createRandom().privateKey as `0x${string}`;
  const makerAddress = new Wallet(privateKey).address as `0x${string}`;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-22T13:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects invalid signatures', () => {
    const cache = new LocalQuoteCache();
    const quote = {
      ...makeQuote({ timestamp: Date.now() }),
      signature: '0xdeadbeef',
    };

    cache.insert(quote);

    expect(cache.active('claude-sonnet-4')).toEqual([]);
  });

  it('keeps the newest quote per maker', () => {
    const cache = new LocalQuoteCache();
    const oldQuote = makeSignedQuote({
      nonce: '0000000000000001',
      currentPrice: 3,
      timestamp: Date.now() - 500,
    });
    const newQuote = makeSignedQuote({
      nonce: '0000000000000002',
      currentPrice: 4,
      timestamp: Date.now(),
    });

    cache.insert(oldQuote);
    cache.insert(newQuote);

    expect(cache.active('claude-sonnet-4')).toEqual([newQuote]);
  });

  it('does not let an older quote overwrite a newer one', () => {
    const cache = new LocalQuoteCache();
    const newQuote = makeSignedQuote({
      nonce: '0000000000000002',
      currentPrice: 4,
      timestamp: Date.now(),
    });
    const oldQuote = makeSignedQuote({
      nonce: '0000000000000001',
      currentPrice: 3,
      timestamp: Date.now() - 500,
    });

    cache.insert(newQuote);
    cache.insert(oldQuote);

    expect(cache.active('claude-sonnet-4')).toEqual([newQuote]);
  });

  it('duplicate nonce is rejected', () => {
    const cache = new LocalQuoteCache();
    const quote = makeSignedQuote({ nonce: 'same-nonce', currentPrice: 4, timestamp: Date.now() });

    expect(cache.accept(quote)).toBe('new');
    expect(cache.accept(quote)).toBe('duplicate');

    expect(cache.active('claude-sonnet-4')).toEqual([quote]);
  });

  it('cleans up expired quotes', () => {
    const cache = new LocalQuoteCache();
    cache.insert(makeSignedQuote({ ttlMs: 1_000, timestamp: Date.now() }));

    expect(cache.size()).toBe(1);
    vi.advanceTimersByTime(3_500);
    cache.cleanup();

    expect(cache.size()).toBe(0);
    expect(cache.active('claude-sonnet-4')).toEqual([]);
  });

  it('rejects expired quotes before caching them', () => {
    const cache = new LocalQuoteCache();
    const quote = makeSignedQuote({ ttlMs: 1_000, timestamp: Date.now() - 4_000 });

    expect(cache.accept(quote)).toBe('expired');
    expect(cache.size()).toBe(0);
  });

  it('starts and stops background cleanup idempotently', () => {
    const cache = new LocalQuoteCache();

    cache.start();
    cache.start();
    cache.insert(makeSignedQuote({ ttlMs: 1_000, timestamp: Date.now() }));
    vi.advanceTimersByTime(4_100);

    expect(cache.size()).toBe(0);

    cache.stop();
    cache.stop();
  });

  it('rejects quotes that are too far in the future', () => {
    const cache = new LocalQuoteCache();
    const futureQuote = makeSignedQuote({ timestamp: Date.now() + 2_500 });

    cache.insert(futureQuote);

    expect(cache.active('claude-sonnet-4')).toEqual([]);
  });

  it('computes market depth under a price ceiling', () => {
    const cache = new LocalQuoteCache();
    cache.insert(makeSignedQuote({ makerId: 'maker-a', utilization: 0.25, maxConcurrent: 4, currentPrice: 2 }));
    cache.insert(makeSignedQuote({ makerId: 'maker-b', utilization: 0.5, maxConcurrent: 6, currentPrice: 10 }));

    expect(cache.depth('claude-sonnet-4', 3)).toBeCloseTo(3, 12);
  });

  function makeSignedQuote(overrides: Partial<ReturnType<typeof makeQuote>> = {}) {
    return signQuote(makeQuote(overrides), privateKey);
  }

  function makeQuote(overrides: Partial<{
    makerId: string;
    makerAddress: `0x${string}`;
    model: string;
    p0: number;
    alpha: number;
    utilization: number;
    maxConcurrent: number;
    currentPrice: number;
    recentLatencyMs: number;
    successRate: number;
    timestamp: number;
    ttlMs: number;
    schemaVersion: 1;
    nonce: string;
  }> = {}) {
    return {
      makerId: 'maker-1',
      makerAddress,
      nonce: '0000000000000001',
      model: 'claude-sonnet-4',
      p0: 2,
      alpha: 1,
      utilization: 0.25,
      maxConcurrent: 5,
      currentPrice: 2.67,
      recentLatencyMs: 120,
      successRate: 0.99,
      timestamp: Date.now(),
      ttlMs: 10_000,
      schemaVersion: 1 as const,
      ...overrides,
    };
  }
});

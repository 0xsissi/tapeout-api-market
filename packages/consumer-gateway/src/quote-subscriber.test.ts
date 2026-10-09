import { Wallet } from 'ethers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildQuoteTopic, signQuote } from '@clawmarket/shared';
import type { ClawMarketNode } from '@clawmarket/p2p-node';

import { LocalQuoteCache } from './quote-cache.js';
import { QuoteSubscriber } from './quote-subscriber.js';

describe('QuoteSubscriber', () => {
  const privateKey = Wallet.createRandom().privateKey as `0x${string}`;
  const makerAddress = new Wallet(privateKey).address as `0x${string}`;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-22T13:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('subscribes to quote topics and inserts valid quotes into the cache', async () => {
    const subscriptions = new Map<string, (message: Uint8Array) => void>();
    const p2p = {
      subscribe: vi.fn(async (topic: string, handler: (message: Uint8Array) => void) => {
        subscriptions.set(topic, handler);
        return async () => {
          subscriptions.delete(topic);
        };
      }),
    } as unknown as ClawMarketNode;
    const cache = new LocalQuoteCache();
    const subscriber = new QuoteSubscriber(p2p, cache, ['claude-sonnet-4'], 'testnet');

    await subscriber.start();

    const topic = buildQuoteTopic('claude-sonnet-4', 'testnet');
    const quote = signQuote({
      makerId: 'maker-1',
      makerAddress,
      nonce: '0000000000000001',
      model: 'claude-sonnet-4',
      p0: 2,
      alpha: 1,
      utilization: 0.2,
      maxConcurrent: 5,
      currentPrice: 2.5,
      recentLatencyMs: 100,
      successRate: 0.99,
      timestamp: Date.now(),
      ttlMs: 10_000,
      schemaVersion: 1,
    }, privateKey);

    subscriptions.get(topic)?.(new TextEncoder().encode(JSON.stringify(quote)));

    expect(cache.active('claude-sonnet-4')).toEqual([quote]);

    await subscriber.stop();
    expect(cache.active('claude-sonnet-4')).toEqual([quote]);
  });

  it('ignores malformed messages', async () => {
    const subscriptions = new Map<string, (message: Uint8Array) => void>();
    const p2p = {
      subscribe: vi.fn(async (topic: string, handler: (message: Uint8Array) => void) => {
        subscriptions.set(topic, handler);
        return async () => {
          subscriptions.delete(topic);
        };
      }),
    } as unknown as ClawMarketNode;
    const cache = new LocalQuoteCache();
    const subscriber = new QuoteSubscriber(p2p, cache, ['claude-sonnet-4']);

    await subscriber.start();
    subscriptions.get(buildQuoteTopic('claude-sonnet-4'))?.(new TextEncoder().encode('{bad json'));

    expect(cache.active('claude-sonnet-4')).toEqual([]);
  });

  it('re-subscribes when the quote cache stays empty for too long', async () => {
    const subscriptions = new Map<string, (message: Uint8Array) => void>();
    const unsubscribe = vi.fn(async () => {
      subscriptions.clear();
    });
    const p2p = {
      libp2p: {
        getConnections: vi.fn(() => [{ remotePeer: { toString: () => 'peer-1' } }]),
      },
      subscribe: vi.fn(async (topic: string, handler: (message: Uint8Array) => void) => {
        subscriptions.set(topic, handler);
        return unsubscribe;
      }),
    } as unknown as ClawMarketNode;
    const cache = new LocalQuoteCache();
    const subscriber = new QuoteSubscriber(p2p, cache, ['claude-sonnet-4'], 'testnet', {
      watchdogIntervalMs: 1_000,
      staleAfterMs: 5_000,
    });

    await subscriber.start();
    await vi.advanceTimersByTimeAsync(7_000);

    expect(p2p.subscribe).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not re-subscribe while valid quotes are still arriving', async () => {
    const subscriptions = new Map<string, (message: Uint8Array) => void>();
    const unsubscribe = vi.fn(async () => {
      subscriptions.clear();
    });
    const p2p = {
      libp2p: {
        getConnections: vi.fn(() => [{ remotePeer: { toString: () => 'peer-1' } }]),
      },
      subscribe: vi.fn(async (topic: string, handler: (message: Uint8Array) => void) => {
        subscriptions.set(topic, handler);
        return unsubscribe;
      }),
    } as unknown as ClawMarketNode;
    const cache = new LocalQuoteCache();
    const subscriber = new QuoteSubscriber(p2p, cache, ['claude-sonnet-4'], 'testnet', {
      watchdogIntervalMs: 1_000,
      staleAfterMs: 5_000,
    });

    await subscriber.start();

    const topic = buildQuoteTopic('claude-sonnet-4', 'testnet');
    const quote = signQuote({
      makerId: 'maker-1',
      makerAddress,
      nonce: '0000000000000001',
      model: 'claude-sonnet-4',
      p0: 2,
      alpha: 1,
      utilization: 0.2,
      maxConcurrent: 5,
      currentPrice: 2.5,
      recentLatencyMs: 100,
      successRate: 0.99,
      timestamp: Date.now(),
      ttlMs: 10_000,
      schemaVersion: 1,
    }, privateKey);

    subscriptions.get(topic)?.(new TextEncoder().encode(JSON.stringify(quote)));
    await vi.advanceTimersByTimeAsync(7_000);

    expect(p2p.subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();
  });
});

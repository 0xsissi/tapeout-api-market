import { Wallet } from 'ethers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQuoteSignerDelegation, verifyQuote, PAYMENT_TOKEN } from '@clawmarket/shared';

import { QuoteBroadcaster } from './quote-broadcaster.js';

describe('QuoteBroadcaster', () => {
  const privateKey = Wallet.createRandom().privateKey as `0x${string}`;
  const signingPrivateKey = Wallet.createRandom().privateKey as `0x${string}`;
  const makerAddress = new Wallet(privateKey).address as `0x${string}`;
  const signerAddress = new Wallet(signingPrivateKey).address as `0x${string}`;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-22T13:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('broadcasts signed quotes immediately and on interval', async () => {
    const published: Array<{ topic: string; payload: Uint8Array }> = [];
    const p2p = {
      publish: vi.fn(async (topic: string, payload: Uint8Array) => {
        published.push({ topic, payload });
      }),
    };

    const broadcaster = new QuoteBroadcaster(p2p, {
      makerId: 'maker-1',
      makerAddress,
      privateKey,
      models: [
        { model: 'claude-sonnet-4', inputPer1m: 2, outputPer1m: 4, p0: 2, alpha: 1 },
      ],
      maxConcurrent: 5,
      intervalMs: 1_000,
      minIntervalMs: 0,
      ttlMs: 5_000,
      networkId: 'testnet',
      getUtilization: () => 0.5,
      getRecentLatencyMs: () => 123,
      getRecentSuccessRate: () => 0.97,
    });

    broadcaster.start();
    await vi.advanceTimersByTimeAsync(1_050);

    expect(published).toHaveLength(2);
    const first = parseQuote(published[0]);

    const namespace = PAYMENT_TOKEN.symbol === 'BEM' ? `bem:56:${process.env.ESCROW_POOL_ADDRESS?.toLowerCase() ?? 'unconfigured'}/` : '';
    expect(published[0]?.topic).toBe(`aimm/${namespace}testnet/quotes/claude-sonnet-4`);
    expect(first.currentPrice).toBeCloseTo(4, 12);
    expect(first.recentLatencyMs).toBe(123);
    expect(first.successRate).toBe(0.97);
    expect(verifyQuote(first, makerAddress)).toBe(true);

    broadcaster.stop();
  });

  it('falls back to legacy average pricing and alpha=1', async () => {
    const published: Array<{ topic: string; payload: Uint8Array }> = [];
    const broadcaster = new QuoteBroadcaster(
      {
        publish: async (topic: string, payload: Uint8Array) => {
          published.push({ topic, payload });
        },
      },
      {
        makerId: 'maker-1',
        makerAddress,
        privateKey,
        models: [{ model: 'gpt-5.4', inputPer1m: 2, outputPer1m: 4 }],
        maxConcurrent: 5,
        getUtilization: () => 0.5,
      },
    );

    const [quote] = await broadcaster.broadcast();

    expect(quote.p0).toBe(3);
    expect(quote.alpha).toBe(1);
    expect(quote.currentPrice).toBeCloseTo(6, 12);
    expect(parseQuote(published[0]).currentPrice).toBeCloseTo(6, 12);
  });

  it('keeps busy-time automatic quotes below the owner price ceiling', () => {
    const broadcaster = new QuoteBroadcaster({ publish: vi.fn(async () => {}) }, { makerId: 'maker-1', makerAddress, privateKey, models: [{ model: 'gpt-5.4', inputPer1m: 2, outputPer1m: 2, p0: 2, alpha: 1, quotePriceCeiling: 10 }], maxConcurrent: 5, getUtilization: () => 0.99 });
    const quote = broadcaster.previewQuote('gpt-5.4')!;
    expect(quote.currentPrice).toBe(10);
    expect(verifyQuote(quote, makerAddress)).toBe(true);
  });

  it('throttles off-schedule broadcasts behind a minimum interval', async () => {
    const published: Array<{ topic: string; payload: Uint8Array }> = [];
    const broadcaster = new QuoteBroadcaster(
      {
        publish: async (topic: string, payload: Uint8Array) => {
          published.push({ topic, payload });
        },
      },
      {
        makerId: 'maker-1',
        makerAddress,
        privateKey,
        models: [{ model: 'gpt-5.4', inputPer1m: 2, outputPer1m: 4, p0: 2, alpha: 1 }],
        maxConcurrent: 5,
        intervalMs: 10_000,
        minIntervalMs: 2_000,
        getUtilization: () => 0.25,
      },
    );

    broadcaster.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(published).toHaveLength(1);

    broadcaster.requestBroadcast();
    broadcaster.requestBroadcast();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(published).toHaveLength(2);

    broadcaster.requestBroadcast();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(published).toHaveLength(2);

    broadcaster.stop();
  });

  it('can broadcast quotes signed by a delegated hot signing key', async () => {
    const published: Array<{ topic: string; payload: Uint8Array }> = [];
    const delegation = createQuoteSignerDelegation(signerAddress, privateKey, {
      issuedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
    });
    const broadcaster = new QuoteBroadcaster(
      {
        publish: async (topic: string, payload: Uint8Array) => {
          published.push({ topic, payload });
        },
      },
      {
        makerId: 'maker-1',
        makerAddress,
        privateKey,
        signingPrivateKey,
        signingDelegation: delegation,
        models: [{ model: 'gpt-5.4', inputPer1m: 2, outputPer1m: 4, p0: 2, alpha: 1 }],
        maxConcurrent: 5,
        getUtilization: () => 0.2,
      },
    );

    const [quote] = await broadcaster.broadcast();

    expect(quote.signerAddress).toBe(signerAddress);
    expect(quote.signingDelegation?.walletAddress).toBe(makerAddress);
    expect(parseQuote(published[0])).toMatchObject({
      makerAddress,
      signerAddress,
    });
    expect(verifyQuote(quote, makerAddress)).toBe(true);
  });

  function parseQuote(item: { payload: Uint8Array }) {
    return JSON.parse(new TextDecoder().decode(item.payload));
  }
});

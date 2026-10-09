import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { P2PRouter, type ScoredProvider } from './router.js';

function makeProvider(peerId: string, score: number, models = ['gpt-test']): ScoredProvider {
  return {
    announcement: {
      peerId,
      walletAddress: '0x0000000000000000000000000000000000000001',
      publicKey: 'pubkey',
      models: models.map((model, index) => ({
        model,
        inputPer1m: index === 0 ? 1 : 3,
        outputPer1m: index === 0 ? 2 : 4,
      })),
      region: 'apac',
      maxConcurrent: 5,
      stakeAmount: 100n,
      reputation: {
        score: 90,
        totalTransactions: 10,
        successRate: 0.99,
        avgLatencyMs: 120,
      },
      timestamp: Date.now(),
      signature: '0xsig',
    },
    modelPricing: {
      model: 'gpt-test',
      inputPer1m: 1,
      outputPer1m: 2,
    },
    score,
  };
}

describe('P2PRouter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses cached providers while the cache is fresh', async () => {
    const providers = [makeProvider('peer-a', 10)];
    const consumerRouter = {
      findProviders: vi.fn().mockResolvedValue(providers),
    };
    const router = new P2PRouter(consumerRouter as any);

    const first = await router.findProviders('gpt-test');
    const second = await router.findProviders('gpt-test');

    expect(first).toEqual(providers);
    expect(second).toEqual(providers);
    expect(consumerRouter.findProviders).toHaveBeenCalledTimes(1);
  });

  it('keeps the model directory visible during a slow refresh and replaces it when discovery finishes', async () => {
    const providers = [makeProvider('peer-a', 10)];
    let complete!: (providers: ScoredProvider[]) => void;
    const pending = new Promise<ScoredProvider[]>(resolve => { complete = resolve; });
    const consumerRouter = { findProviders: vi.fn().mockResolvedValueOnce(providers).mockReturnValueOnce(pending) };
    const router = new P2PRouter(consumerRouter as any);
    await router.findProviders('gpt-test'); router.startRefreshLoop(['gpt-test'], 30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(router.getCachedProviders('gpt-test')).toEqual(providers);
    complete([]); await Promise.resolve(); await Promise.resolve();
    expect(router.getCachedProviders('gpt-test')).toEqual([]);
    router.stopRefreshLoop();
  });

  it('retains the last model directory when a periodic discovery request fails', async () => {
    const providers = [makeProvider('peer-a', 10)];
    const consumerRouter = { findProviders: vi.fn().mockResolvedValueOnce(providers).mockRejectedValueOnce(new Error('Temporary network failure')) };
    const router = new P2PRouter(consumerRouter as any);
    await router.findProviders('gpt-test'); router.startRefreshLoop(['gpt-test'], 30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(router.getCachedProviders('gpt-test')).toEqual(providers);
    router.stopRefreshLoop();
  });

  it('falls back to stale cache when the underlying lookup fails', async () => {
    const providers = [makeProvider('peer-a', 10)];
    const consumerRouter = {
      findProviders: vi
        .fn()
        .mockResolvedValueOnce(providers)
        .mockRejectedValueOnce(new Error('lookup failed')),
    };
    const router = new P2PRouter(consumerRouter as any);

    await router.findProviders('gpt-test');
    vi.advanceTimersByTime(75_001); // includes the configured TTL jitter

    const result = await router.findProviders('gpt-test');

    expect(result).toEqual(providers);
    expect(consumerRouter.findProviders).toHaveBeenCalledTimes(2);
  });

  it('excludes providers after repeated failures and restores them after cooldown', async () => {
    const providers = [makeProvider('peer-a', 10), makeProvider('peer-b', 8)];
    const consumerRouter = {
      findProviders: vi.fn().mockResolvedValue(providers),
    };
    const router = new P2PRouter(consumerRouter as any);

    router.markFailed('peer-a');
    router.markFailed('peer-a');
    router.markFailed('peer-a');

    const excluded = await router.findProviders('gpt-test');
    expect(excluded.map((provider) => provider.announcement.peerId)).toEqual(['peer-b']);

    vi.advanceTimersByTime(120_001);

    const restored = await router.findProviders('gpt-test');
    expect(restored.map((provider) => provider.announcement.peerId)).toEqual(['peer-a', 'peer-b']);
  });

  it('clears failure tracking after a success', async () => {
    const providers = [makeProvider('peer-a', 10)];
    const consumerRouter = {
      findProviders: vi.fn().mockResolvedValue(providers),
    };
    const router = new P2PRouter(consumerRouter as any);

    router.markFailed('peer-a');
    router.markFailed('peer-a');
    router.markFailed('peer-a');
    router.markSuccess('peer-a');

    const result = await router.findProviders('gpt-test');

    expect(result.map((provider) => provider.announcement.peerId)).toEqual(['peer-a']);
  });

  it('excludes peers during bootstrap dial cooldown and restores them once reachable again', async () => {
    const providers = [makeProvider('peer-a', 10), makeProvider('peer-b', 8)];
    const consumerRouter = {
      findProviders: vi.fn().mockResolvedValue(providers),
    };
    const router = new P2PRouter(consumerRouter as any);

    router.markPeerUnreachable('peer-a', 90_000, 'relay dial timed out');

    const excluded = await router.findProviders('gpt-test');
    expect(excluded.map((provider) => provider.announcement.peerId)).toEqual(['peer-b']);

    router.markPeerReachable('peer-a');

    const restored = await router.findProviders('gpt-test');
    expect(restored.map((provider) => provider.announcement.peerId)).toEqual(['peer-a', 'peer-b']);
  });

  it('excludes only the cooled-down model for a provider and keeps other models routable', async () => {
    const gptTestProviders = [makeProvider('peer-a', 10), makeProvider('peer-b', 8)];
    const gptOtherProviders = [makeProvider('peer-a', 10)];
    const consumerRouter = {
      findProviders: vi.fn(async (model: string) => (
        model === 'gpt-test' ? gptTestProviders : gptOtherProviders
      )),
    };
    const router = new P2PRouter(consumerRouter as any);

    router.markTemporarilyUnavailable('peer-a', 'gpt-test', 60_000, 'usage limit reached');

    const cooledDown = await router.findProviders('gpt-test');
    const unaffected = await router.findProviders('gpt-other');

    expect(cooledDown.map((provider) => provider.announcement.peerId)).toEqual(['peer-b']);
    expect(unaffected.map((provider) => provider.announcement.peerId)).toEqual(['peer-a']);
  });

  it('restores a cooled-down model after the advertised cooldown expires', async () => {
    const providers = [makeProvider('peer-a', 10), makeProvider('peer-b', 8)];
    const consumerRouter = {
      findProviders: vi.fn().mockResolvedValue(providers),
    };
    const router = new P2PRouter(consumerRouter as any);

    router.markTemporarilyUnavailable('peer-a', 'gpt-test', 30_000, 'model cooldown');

    const duringCooldown = await router.findProviders('gpt-test');
    expect(duringCooldown.map((provider) => provider.announcement.peerId)).toEqual(['peer-b']);

    vi.advanceTimersByTime(30_001);

    const restored = await router.findProviders('gpt-test');
    expect(restored.map((provider) => provider.announcement.peerId)).toEqual(['peer-a', 'peer-b']);
  });

  it('returns null when no providers are available', async () => {
    const consumerRouter = {
      findProviders: vi.fn().mockResolvedValue([]),
    };
    const router = new P2PRouter(consumerRouter as any);

    await expect(router.selectBest('gpt-test')).resolves.toBeNull();
  });

  it('selects the best provider that is not in the exclusion set', async () => {
    const providers = [makeProvider('peer-a', 10), makeProvider('peer-b', 8)];
    const consumerRouter = {
      findProviders: vi.fn().mockResolvedValue(providers),
    };
    const router = new P2PRouter(consumerRouter as any);

    await expect(
      router.selectBestExcluding('gpt-test', new Set(['peer-a'])),
    ).resolves.toMatchObject({
      announcement: { peerId: 'peer-b' },
    });
  });

  it('returns the top n providers while respecting exclusions', async () => {
    const providers = [
      makeProvider('peer-a', 10),
      makeProvider('peer-b', 8),
      makeProvider('peer-c', 7),
    ];
    const consumerRouter = {
      findProviders: vi.fn().mockResolvedValue(providers),
    };
    const router = new P2PRouter(consumerRouter as any);

    await expect(
      router.selectTopN('gpt-test', 2, new Set(['peer-a'])),
    ).resolves.toMatchObject([
      { announcement: { peerId: 'peer-b' } },
      { announcement: { peerId: 'peer-c' } },
    ]);
  });

  it('serves cached network snapshots without triggering discovery', async () => {
    const providers = [makeProvider('peer-a', 10, ['gpt-test', 'gpt-other'])];
    const consumerRouter = {
      findProviders: vi.fn().mockResolvedValue(providers),
      listModels: vi.fn(),
    };
    const router = new P2PRouter(consumerRouter as any);

    await router.findProviders('gpt-test');

    expect(router.listCachedModels()).toEqual(['gpt-other', 'gpt-test']);
    expect(router.getCachedProviders('gpt-other')).toMatchObject([
      {
        announcement: { peerId: 'peer-a' },
        modelPricing: { model: 'gpt-other', inputPer1m: 3, outputPer1m: 4 },
      },
    ]);
    expect(consumerRouter.listModels).not.toHaveBeenCalled();
    expect(consumerRouter.findProviders).toHaveBeenCalledTimes(1);
  });

  it('merges direct and announcement-derived cached providers for failover', async () => {
    const consumerRouter = {
      findProviders: vi
        .fn()
        .mockResolvedValueOnce([makeProvider('peer-a', 10, ['gpt-test'])])
        .mockResolvedValueOnce([makeProvider('peer-b', 8, ['gpt-other', 'gpt-test'])]),
      listModels: vi.fn(),
    };
    const router = new P2PRouter(consumerRouter as any);

    await router.findProviders('gpt-test');
    await router.findProviders('gpt-other');

    expect(router.getCachedProviders('gpt-test').map((provider) => provider.announcement.peerId)).toEqual([
      'peer-a',
      'peer-b',
    ]);

    router.markTemporarilyUnavailable('peer-a', 'gpt-test', 60_000, 'usage limit reached');
    await expect(router.selectBestExcluding('gpt-test', new Set(['peer-a']))).resolves.toMatchObject({
      announcement: { peerId: 'peer-b' },
      modelPricing: { model: 'gpt-test' },
    });
  });

  it('reports whether a provider is currently routable', async () => {
    const providers = [makeProvider('peer-a', 10), makeProvider('peer-b', 8)];
    const consumerRouter = {
      findProviders: vi.fn().mockResolvedValue(providers),
    };
    const router = new P2PRouter(consumerRouter as any);

    router.markFailed('peer-a');
    router.markFailed('peer-a');
    router.markFailed('peer-a');

    await expect(router.isProviderAvailable('gpt-test', 'peer-a')).resolves.toBe(false);
    await expect(router.isProviderAvailable('gpt-test', 'peer-b')).resolves.toBe(true);
  });

  it('stores recent provider observations and expires them after the observation ttl', () => {
    const router = new P2PRouter({ findProviders: vi.fn() } as any);

    router.observeProvider('peer-a', { loadHint: 0.7, inflight: 3, queueDepth: 1 });
    router.recordObservedLatency('peer-a', 240);

    expect(router.getProviderObservation('peer-a')).toMatchObject({
      peerId: 'peer-a',
      loadHint: 0.7,
      inflight: 3,
      queueDepth: 1,
      observedLatencyMs: 240,
    });

    vi.advanceTimersByTime(120_001);

    expect(router.getProviderObservation('peer-a')).toBeNull();
  });

  it('assigns a cache ttl jitter inside the 45s-75s band', () => {
    const router = new P2PRouter({ findProviders: vi.fn() } as any, {
      cacheJitterSeed: 'peer-buyer-a',
    });

    const ttlMs = (router as any).getCacheTtlMs('gpt-test');

    expect(ttlMs).toBeGreaterThanOrEqual(45_000);
    expect(ttlMs).toBeLessThanOrEqual(75_000);
  });
});

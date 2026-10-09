import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { announceModel, startPeriodicAnnounce } = vi.hoisted(() => ({
  announceModel: vi.fn(),
  startPeriodicAnnounce: vi.fn(() => setInterval(() => {}, 60_000)),
}));

vi.mock('./discovery.js', () => ({
  announceModel,
  startPeriodicAnnounce,
}));

describe('ProviderRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T10:00:00.000Z'));
    announceModel.mockReset();
    startPeriodicAnnounce.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function createRegistry(dhtOverrides: Record<string, any> = {}) {
    const dht = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
      ...dhtOverrides,
    };
    const libp2p = {
      services: { dht },
    };
    const { ProviderRegistry } = await import('./provider-registry.js');
    return { registry: new ProviderRegistry(libp2p as any), dht };
  }

  function announcement() {
    return {
      peerId: 'peer-a',
      walletAddress: '0x0000000000000000000000000000000000000001',
      publicKey: 'pub',
      models: [
        { model: 'gpt-1', inputPer1m: 1, outputPer1m: 2 },
        { model: 'gpt-2', inputPer1m: 2, outputPer1m: 3 },
      ],
      region: 'apac',
      maxConcurrent: 5,
      stakeAmount: 100n,
      reputation: {
        score: 90,
        totalTransactions: 10,
        successRate: 0.99,
        avgLatencyMs: 100,
      },
      timestamp: Date.now(),
      signature: '0xsig',
    };
  }

  it('announces each model and stores the current announcement', async () => {
    const { registry, dht } = await createRegistry();
    const payload = announcement();

    await registry.announce(payload as any);

    expect(announceModel).toHaveBeenCalledTimes(2);
    expect(dht.put).toHaveBeenCalledOnce();
    expect(registry.getCurrentAnnouncement()).toEqual(payload);
  });

  it('starts heartbeat and republishes with refreshed timestamps', async () => {
    const { registry, dht } = await createRegistry();
    const payload = announcement();
    const initialTimestamp = payload.timestamp;
    await registry.announce(payload as any);

    registry.startHeartbeat(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(startPeriodicAnnounce).toHaveBeenCalledWith(expect.anything(), ['gpt-1', 'gpt-2'], 5_000);
    expect(dht.put).toHaveBeenCalledTimes(2);
    expect(registry.getCurrentAnnouncement()!.timestamp).toBeGreaterThan(initialTimestamp);

    registry.stopHeartbeat();
  });

  it('throws when starting heartbeat before announce', async () => {
    const { registry } = await createRegistry();

    expect(() => registry.startHeartbeat()).toThrow(/Must announce before starting heartbeat/);
  });

  it('fetches provider announcements from the dht and caches them', async () => {
    const encoded = new TextEncoder().encode(
      JSON.stringify({ ...announcement(), stakeAmount: '100' }),
    );
    const get = vi.fn(async function* () {
      yield { name: 'VALUE', value: encoded };
    });
    const { registry, dht } = await createRegistry({ get });

    const first = await registry.fetchProvider('peer-a');
    const second = await registry.fetchProvider('peer-a');

    expect(first?.stakeAmount).toBe(100n);
    expect(second?.stakeAmount).toBe(100n);
    expect(dht.get).toHaveBeenCalledTimes(1);
  });

  it('unannounces and stops heartbeats', async () => {
    const { registry } = await createRegistry();
    await registry.announce(announcement() as any);
    registry.startHeartbeat(5_000);

    await registry.unannounce();

    expect(registry.getCurrentAnnouncement()).toBeNull();
  });
});

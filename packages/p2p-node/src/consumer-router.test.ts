import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findModelProviders } = vi.hoisted(() => ({
  findModelProviders: vi.fn(),
}));
const { requestProviderAnnouncement } = vi.hoisted(() => ({
  requestProviderAnnouncement: vi.fn(),
}));

vi.mock('./discovery.js', () => ({
  findModelProviders,
}));

vi.mock('./provider-discovery.js', () => ({
  requestProviderAnnouncement,
}));

describe('ConsumerRouter', () => {
  beforeEach(() => {
    findModelProviders.mockReset();
    requestProviderAnnouncement.mockReset();
  });

  function announcement(peerId: string, model: string) {
    return {
      peerId,
      walletAddress: '0x0000000000000000000000000000000000000001',
      publicKey: 'pubkey',
      models: [{ model, inputPer1m: 1, outputPer1m: 2 }],
      region: 'apac',
      maxConcurrent: 5,
      stakeAmount: 100n,
      reputation: {
        score: 95,
        totalTransactions: 12,
        successRate: 0.99,
        avgLatencyMs: 120,
      },
      timestamp: Date.now(),
      signature: '0xsig',
    };
  }

  it('falls back to directly querying connected peers when DHT lookup is empty', async () => {
    findModelProviders.mockResolvedValue([]);
    requestProviderAnnouncement.mockImplementation(async (_libp2p: unknown, peerId: string) => {
      if (peerId === 'peer-seller') {
        return announcement('peer-seller', 'gpt-5.4');
      }
      return null;
    });

    const { ConsumerRouter } = await import('./consumer-router.js');
    const registry = {
      fetchProvider: vi.fn().mockResolvedValue(null),
      getKnownProviders: vi.fn(() => []),
      rememberProvider: vi.fn(),
    };
    const libp2p = {
      getConnections: vi.fn(() => [
        { remotePeer: { toString: () => 'peer-seller' } },
        { remotePeer: { toString: () => 'peer-bootstrap' } },
      ]),
    };

    const router = new ConsumerRouter(libp2p as any, registry as any, {});
    const providers = await router.findProviders('gpt-5.4');

    expect(providers).toHaveLength(1);
    expect(providers[0]?.announcement.peerId).toBe('peer-seller');
    expect(requestProviderAnnouncement).toHaveBeenCalledWith(libp2p, 'peer-seller');
    expect(requestProviderAnnouncement).toHaveBeenCalledWith(libp2p, 'peer-bootstrap');
    expect(registry.rememberProvider).toHaveBeenCalledWith(
      expect.objectContaining({ peerId: 'peer-seller' }),
    );
  });

  it('uses DHT peer ids first and filters by requested model', async () => {
    findModelProviders.mockResolvedValue(['peer-a']);
    requestProviderAnnouncement.mockResolvedValue(null);

    const { ConsumerRouter } = await import('./consumer-router.js');
    const registry = {
      fetchProvider: vi.fn().mockResolvedValue(announcement('peer-a', 'gpt-5.4')),
      getKnownProviders: vi.fn(() => []),
      rememberProvider: vi.fn(),
    };
    const libp2p = {
      getConnections: vi.fn(() => []),
    };

    const router = new ConsumerRouter(libp2p as any, registry as any, {});
    const providers = await router.findProviders('gpt-5.4');

    expect(providers).toHaveLength(1);
    expect(providers[0]?.announcement.peerId).toBe('peer-a');
    expect(requestProviderAnnouncement).not.toHaveBeenCalled();
  });

  it('lists models from remembered and connected provider announcements', async () => {
    findModelProviders.mockResolvedValue([]);
    requestProviderAnnouncement.mockImplementation(async (_libp2p: unknown, peerId: string) => {
      if (peerId === 'peer-live') {
        return announcement('peer-live', 'gemini-2.5-pro');
      }
      return null;
    });

    const { ConsumerRouter } = await import('./consumer-router.js');
    const registry = {
      fetchProvider: vi.fn().mockImplementation(async (peerId: string) => {
        if (peerId === 'peer-known') {
          return announcement('peer-known', 'claude-sonnet-4');
        }
        return null;
      }),
      getKnownProviders: vi.fn(() => [announcement('peer-known', 'claude-sonnet-4')]),
      rememberProvider: vi.fn(),
    };
    const libp2p = {
      getConnections: vi.fn(() => [{ remotePeer: { toString: () => 'peer-live' } }]),
    };

    const router = new ConsumerRouter(libp2p as any, registry as any, {});
    const models = await router.listModels();

    expect(models).toEqual(['claude-sonnet-4', 'gemini-2.5-pro']);
    expect(requestProviderAnnouncement).toHaveBeenCalledWith(libp2p, 'peer-live');
  });

  it('ignores provider announcements that are older than the freshness window', async () => {
    findModelProviders.mockResolvedValue(['peer-stale']);

    const staleTimestamp = Date.now() - 180_000;
    const { ConsumerRouter } = await import('./consumer-router.js');
    const registry = {
      fetchProvider: vi.fn().mockResolvedValue({
        ...announcement('peer-stale', 'gpt-5.4'),
        timestamp: staleTimestamp,
      }),
      getKnownProviders: vi.fn(() => []),
      rememberProvider: vi.fn(),
    };
    const libp2p = {
      getConnections: vi.fn(() => []),
    };

    const router = new ConsumerRouter(libp2p as any, registry as any, {});
    const providers = await router.findProviders('gpt-5.4');

    expect(providers).toEqual([]);
  });
});

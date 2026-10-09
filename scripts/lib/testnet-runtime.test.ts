import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createProviderNodeAdapter,
  resolveBootstrapPeers,
  startBootstrapMaintenance,
  startRelayReservationMaintenance,
} from './testnet-runtime.mjs';

describe('bootstrap peer persistence', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmarket-bootstrap-runtime-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns immediately for background discovery and stops before dialing another peer', async () => {
    let finish!: () => void;
    const dialPeer = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const discoverPeers = vi.fn(async () => []);
    const node = { libp2p: { getConnections: () => [] } };
    const maintenance = await startBootstrapMaintenance({
      node, dialPeer, discoverPeers, waitForInitialRefresh: false, operationTimeoutMs: 1000,
      staticPeers: ['/dns4/slow.example.com/tcp/9090/p2p/SLOW', '/dns4/next.example.com/tcp/9090/p2p/NEXT'],
      refreshMs: 1000,
    });
    await vi.waitFor(() => expect(dialPeer).toHaveBeenCalledOnce());
    await maintenance.stop();
    finish();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(dialPeer).toHaveBeenCalledOnce();
    expect(discoverPeers).not.toHaveBeenCalled();
  });

  it('merges remembered peers from the peer cache', async () => {
    const peerCachePath = path.join(tempDir, 'known-public-peers.json');
    fs.writeFileSync(
      peerCachePath,
      JSON.stringify({
        peers: [
          '/dns4/bootstrap-c.example.com/tcp/9090/p2p/PEER_C',
        ],
      }),
    );

    const result = await resolveBootstrapPeers({
      staticPeers: ['/dns4/bootstrap-a.example.com/tcp/9090/p2p/PEER_A'],
      peerCachePath,
    });

    expect(result.peers).toEqual([
      '/dns4/bootstrap-a.example.com/tcp/9090/p2p/PEER_A',
      '/dns4/bootstrap-c.example.com/tcp/9090/p2p/PEER_C',
    ]);
  });

  it('persists successful public peers and skips private addresses', async () => {
    const peerCachePath = path.join(tempDir, 'known-public-peers.json');
    const dialPeer = vi.fn(async () => {});
    const node = {
      libp2p: {
        getConnections() {
          return [
            { remotePeer: { toString: () => 'PEER_B' } },
            { remotePeer: { toString: () => 'PRIVATE_PEER' } },
            { remotePeer: { toString: () => 'LOCAL_PEER' } },
            { remotePeer: { toString: () => 'BENCHMARK_PEER' } },
          ];
        },
        peerStore: {
          async getInfo(peerId) {
            const value = peerId?.toString?.() ?? '';
            if (value === 'PEER_B') {
              return {
                multiaddrs: [
                  { toString: () => '/dns4/bootstrap-b.example.com/tcp/9090/p2p/PEER_B' },
                ],
              };
            }
            if (value === 'PRIVATE_PEER') {
              return {
                multiaddrs: [
                  { toString: () => '/ip4/192.168.1.10/tcp/9090/p2p/PRIVATE_PEER' },
                ],
              };
            }
            if (value === 'LOCAL_PEER') {
              return {
                multiaddrs: [
                  { toString: () => '/ip4/127.0.0.1/tcp/9090/p2p/LOCAL_PEER' },
                ],
              };
            }
            if (value === 'BENCHMARK_PEER') {
              return {
                multiaddrs: [
                  { toString: () => '/ip4/198.18.0.1/tcp/9090/p2p/BENCHMARK_PEER' },
                ],
              };
            }
            return { multiaddrs: [] };
          },
        },
      },
    };

    const maintenance = await startBootstrapMaintenance({
      node,
      dialPeer,
      staticPeers: ['/dns4/bootstrap-a.example.com/tcp/9090/p2p/PEER_A'],
      peerCachePath,
      refreshMs: 60_000,
      logLabel: 'test bootstrap',
    });

    const remembered = JSON.parse(fs.readFileSync(peerCachePath, 'utf8'));
    expect(remembered.peers).toEqual([
      '/dns4/bootstrap-a.example.com/tcp/9090/p2p/PEER_A',
      '/dns4/bootstrap-b.example.com/tcp/9090/p2p/PEER_B',
    ]);
    expect(dialPeer).toHaveBeenCalledWith('/dns4/bootstrap-a.example.com/tcp/9090/p2p/PEER_A');

    await maintenance.stop();
  });

  it('does not persist transient remoteAddr source ports when the peer store has no advertised address', async () => {
    const peerCachePath = path.join(tempDir, 'known-public-peers.json');
    const dialPeer = vi.fn(async () => {});
    const node = {
      libp2p: {
        getConnections() {
          return [
            {
              remotePeer: { toString: () => 'PEER_B' },
              remoteAddr: { toString: () => '/ip4/203.0.113.40/tcp/35556/p2p/PEER_B' },
            },
          ];
        },
        peerStore: {
          async getInfo() {
            return { multiaddrs: [] };
          },
          async get() {
            return { addresses: [] };
          },
        },
      },
    };

    const maintenance = await startBootstrapMaintenance({
      node,
      dialPeer,
      staticPeers: ['/dns4/bootstrap-a.example.com/tcp/9090/p2p/PEER_A'],
      peerCachePath,
      refreshMs: 60_000,
      logLabel: 'test bootstrap',
    });

    const remembered = JSON.parse(fs.readFileSync(peerCachePath, 'utf8'));
    expect(remembered.peers).toEqual([
      '/dns4/bootstrap-a.example.com/tcp/9090/p2p/PEER_A',
    ]);

    await maintenance.stop();
  });

  it('discovers and dials additional public peers returned by bootstrap exchange', async () => {
    const peerCachePath = path.join(tempDir, 'known-public-peers.json');
    const dialPeer = vi.fn(async () => {});
    const discoverPeers = vi.fn(async (peer) => {
      if (peer === '/dns4/bootstrap-a.example.com/tcp/9090/p2p/PEER_A') {
        return ['/dns4/provider-a.example.com/tcp/19100/p2p/PROVIDER_A'];
      }
      return [];
    });
    const node = {
      libp2p: {
        getConnections() {
          return [];
        },
      },
    };

    const maintenance = await startBootstrapMaintenance({
      node,
      dialPeer,
      discoverPeers,
      staticPeers: ['/dns4/bootstrap-a.example.com/tcp/9090/p2p/PEER_A'],
      peerCachePath,
      refreshMs: 60_000,
      logLabel: 'test bootstrap',
    });

    const remembered = JSON.parse(fs.readFileSync(peerCachePath, 'utf8'));
    expect(remembered.peers).toEqual([
      '/dns4/bootstrap-a.example.com/tcp/9090/p2p/PEER_A',
      '/dns4/provider-a.example.com/tcp/19100/p2p/PROVIDER_A',
    ]);
    expect(discoverPeers).toHaveBeenCalledWith('/dns4/bootstrap-a.example.com/tcp/9090/p2p/PEER_A');
    expect(dialPeer).toHaveBeenCalledWith('/dns4/bootstrap-a.example.com/tcp/9090/p2p/PEER_A');
    expect(dialPeer).toHaveBeenCalledWith('/dns4/provider-a.example.com/tcp/19100/p2p/PROVIDER_A');

    await maintenance.stop();
  });

  it('continues peer discovery when a bootstrap peer is already connected', async () => {
    const peerCachePath = path.join(tempDir, 'known-public-peers.json');
    const dialPeer = vi.fn(async () => {
      throw new Error('timed out');
    });
    const discoverPeers = vi.fn(async (peer) => {
      if (peer === '/dns4/bootstrap-a.example.com/tcp/9090/p2p/PEER_A') {
        return ['/dns4/provider-a.example.com/tcp/19100/p2p/PROVIDER_A'];
      }
      return [];
    });
    const node = {
      libp2p: {
        getConnections() {
          return [
            {
              remotePeer: {
                toString: () => 'PEER_A',
              },
            },
          ];
        },
      },
    };

    const maintenance = await startBootstrapMaintenance({
      node,
      dialPeer,
      discoverPeers,
      staticPeers: ['/dns4/bootstrap-a.example.com/tcp/9090/p2p/PEER_A'],
      peerCachePath,
      refreshMs: 60_000,
      logLabel: 'test bootstrap',
    });

    const remembered = JSON.parse(fs.readFileSync(peerCachePath, 'utf8'));
    expect(remembered.peers).toEqual([
      '/dns4/bootstrap-a.example.com/tcp/9090/p2p/PEER_A',
      '/dns4/provider-a.example.com/tcp/19100/p2p/PROVIDER_A',
    ]);
    expect(dialPeer).not.toHaveBeenCalledWith('/dns4/bootstrap-a.example.com/tcp/9090/p2p/PEER_A');
    expect(dialPeer).toHaveBeenCalledWith('/dns4/provider-a.example.com/tcp/19100/p2p/PROVIDER_A');
    expect(discoverPeers).toHaveBeenCalledWith('/dns4/bootstrap-a.example.com/tcp/9090/p2p/PEER_A');

    await maintenance.stop();
  });

  it('reports bootstrap peer reachability changes to the caller', async () => {
    const peerCachePath = path.join(tempDir, 'known-public-peers.json');
    const onPeerReachable = vi.fn();
    const onPeerUnreachable = vi.fn();
    const dialPeer = vi.fn(async (peer) => {
      if (peer.includes('PEER_A')) {
        throw new Error('timed out');
      }
    });
    const node = {
      libp2p: {
        getConnections() {
          return [
            {
              remotePeer: {
                toString: () => 'PEER_B',
              },
            },
          ];
        },
      },
    };

    const maintenance = await startBootstrapMaintenance({
      node,
      dialPeer,
      onPeerReachable,
      onPeerUnreachable,
      staticPeers: [
        '/dns4/bootstrap-a.example.com/tcp/9090/p2p/PEER_A',
        '/dns4/bootstrap-b.example.com/tcp/9090/p2p/PEER_B',
      ],
      peerCachePath,
      refreshMs: 60_000,
      logLabel: 'test bootstrap',
    });

    expect(onPeerUnreachable).toHaveBeenCalledWith(
      '/dns4/bootstrap-a.example.com/tcp/9090/p2p/PEER_A',
      expect.stringContaining('timed out'),
    );
    expect(onPeerReachable).toHaveBeenCalledWith(
      '/dns4/bootstrap-b.example.com/tcp/9090/p2p/PEER_B',
    );

    await maintenance.stop();
  });

  it('treats the terminal peer in a relay address as the reachability target', async () => {
    const peerCachePath = path.join(tempDir, 'known-public-peers.json');
    const onPeerReachable = vi.fn();
    const onPeerUnreachable = vi.fn();
    const relaySeller = '/ip4/203.0.113.30/tcp/9090/p2p/RELAY_PEER/p2p-circuit/p2p/SELLER_PEER';
    const dialPeer = vi.fn(async () => {
      throw new Error('relay path failed');
    });
    const node = {
      libp2p: {
        getConnections() {
          return [
            {
              remotePeer: {
                toString: () => 'RELAY_PEER',
              },
            },
          ];
        },
      },
    };

    const maintenance = await startBootstrapMaintenance({
      node,
      dialPeer,
      onPeerReachable,
      onPeerUnreachable,
      staticPeers: [relaySeller],
      peerCachePath,
      refreshMs: 60_000,
      logLabel: 'test bootstrap',
    });

    expect(dialPeer).toHaveBeenCalledWith(relaySeller);
    expect(onPeerUnreachable).toHaveBeenCalledWith(
      relaySeller,
      expect.stringContaining('relay path failed'),
    );
    expect(onPeerReachable).not.toHaveBeenCalled();

    await maintenance.stop();
  });
});

describe('relay reservation maintenance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renews relay reservations even when a circuit address is already visible', async () => {
    const reserveRelaySlots = vi.fn(async () => {});
    const node = {
      reserveRelaySlots,
      getMultiaddrs() {
        return ['/ip4/203.0.113.30/tcp/9090/p2p/RELAY/p2p-circuit'];
      },
    };

    const stop = startRelayReservationMaintenance(node, {
      intervalMs: 10_000,
      renewEveryMs: 30_000,
      waitForReadyMs: 0,
      logLabel: '[test relay]',
    });

    expect(reserveRelaySlots).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(reserveRelaySlots).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(reserveRelaySlots).toHaveBeenCalledTimes(2);

    stop();
  });

  it('keeps retrying until a circuit address becomes visible', async () => {
    const reserveRelaySlots = vi.fn(async () => {});
    let hasRelayAddress = false;
    const node = {
      reserveRelaySlots,
      getMultiaddrs() {
        return hasRelayAddress
          ? ['/ip4/203.0.113.30/tcp/9090/p2p/RELAY/p2p-circuit']
          : ['/ip4/127.0.0.1/tcp/19190/p2p/SELLER'];
      },
    };

    const stop = startRelayReservationMaintenance(node, {
      intervalMs: 5_000,
      renewEveryMs: 5_000,
      waitForReadyMs: 500,
      logLabel: '[test relay]',
    });

    expect(reserveRelaySlots).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_500);
    expect(reserveRelaySlots).toHaveBeenCalledTimes(2);

    hasRelayAddress = true;
    await vi.advanceTimersByTimeAsync(5_500);
    expect(reserveRelaySlots).toHaveBeenCalledTimes(3);

    stop();
  });
});

describe('createProviderNodeAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prefers native send when the libp2p stream exposes it', async () => {
    let registeredHandler;
    const fakeStream = {
      send: vi.fn(() => true),
      onDrain: vi.fn().mockResolvedValue(undefined),
      sink: vi.fn(async () => {}),
      close: vi.fn().mockResolvedValue(undefined),
      source: (async function* () {})(),
    };
    const node = {
      peerId: { toString: () => 'PEER_TEST' },
      libp2p: {
        handle: vi.fn((_, handler) => {
          registeredHandler = handler;
        }),
        getMultiaddrs: vi.fn(() => []),
        contentRouting: {
          provide: vi.fn(async () => {}),
        },
      },
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };

    const adapter = createProviderNodeAdapter(node);
    adapter.handle('/test', async ({ stream }) => {
      const sent = stream.send(Uint8Array.from([1, 2, 3]));
      expect(sent).toBe(true);

      await stream.sink((async function* () {
        yield Uint8Array.from([4, 5, 6]);
      })());
    });

    expect(typeof registeredHandler).toBe('function');
    await registeredHandler(fakeStream, {});

    expect(fakeStream.send).toHaveBeenCalledTimes(2);
    expect(Array.from(fakeStream.send.mock.calls[0][0])).toEqual([1, 2, 3]);
    expect(Array.from(fakeStream.send.mock.calls[1][0])).toEqual([4, 5, 6]);
    expect(fakeStream.sink).not.toHaveBeenCalled();
    expect(fakeStream.close).not.toHaveBeenCalled();
  });

  it('lazily starts a persistent sink for sink-only streams', async () => {
    let registeredHandler;
    const writtenChunks = [];
    const fakeStream = {
      sink: vi.fn(async (source) => {
        for await (const chunk of source) {
          writtenChunks.push(Array.from(chunk));
        }
      }),
      close: vi.fn().mockResolvedValue(undefined),
      source: (async function* () {})(),
    };
    const node = {
      peerId: { toString: () => 'PEER_TEST' },
      libp2p: {
        handle: vi.fn((_, handler) => {
          registeredHandler = handler;
        }),
        getMultiaddrs: vi.fn(() => []),
        contentRouting: {
          provide: vi.fn(async () => {}),
        },
      },
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };

    const adapter = createProviderNodeAdapter(node);
    adapter.handle('/test', async ({ stream }) => {
      const sent = stream.send(Uint8Array.from([1, 2, 3]));
      expect(sent).toBe(true);

      await stream.sink((async function* () {
        yield Uint8Array.from([4, 5, 6]);
      })());
    });

    expect(typeof registeredHandler).toBe('function');
    await registeredHandler(fakeStream, {});

    expect(fakeStream.sink).toHaveBeenCalledTimes(1);
    expect(writtenChunks).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(fakeStream.close).not.toHaveBeenCalled();
  });
});

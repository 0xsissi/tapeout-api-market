import { afterEach, describe, expect, it, vi } from 'vitest';
import { planObserverPeers, observerTimeout } from './market-observer-peers.mjs';

const direct = (id: string, port = 9090) => `/ip4/203.0.113.10/tcp/${port}/p2p/${id}`;
afterEach(() => vi.useRealTimers());

describe('market discovery peer scheduling', () => {
  it('discovers a newly appended seller even when existing sellers have many routes', () => {
    const duplicates = Array.from({ length: 30 }, (_, i) => direct('ExistingSeller', 9000 + i));
    const plan = planObserverPeers([...duplicates, direct('NewSeller')]);
    expect(plan.peers.map(peer => peer.peerId)).toEqual(['ExistingSeller', 'NewSeller']);
    expect(plan.peers[0].addresses).toHaveLength(4);
  });
  it('visits every peer over bounded rounds rather than scanning the same first 24 forever', () => {
    const addresses = Array.from({ length: 55 }, (_, i) => direct(`Seller${i}`));
    const seen = new Set<string>(); let cursor = 0;
    for (let round = 0; round < 3; round++) {
      const plan = planObserverPeers(addresses, cursor); cursor = plan.nextCursor;
      expect(plan.peers).toHaveLength(24);
      plan.peers.forEach(peer => seen.add(peer.peerId));
    }
    expect(seen.size).toBe(55);
  });
  it('uses the final destination of relay addresses and supports IPv6 and DNS routes', () => {
    const plan = planObserverPeers([
      `${direct('Relay')}/p2p-circuit/p2p/Seller`,
      '/dns6/relay.example/tcp/9090/p2p/Relay/p2p-circuit/p2p/Seller',
      '/ip6/2001:db8::1/tcp/9090/p2p/OtherSeller',
      `${direct('Relay')}/p2p-circuit`, null, 'not-an-address', direct('Seller'), direct('Seller'),
    ]);
    expect(plan.peers.map(peer => peer.peerId)).toEqual(['Seller', 'OtherSeller']);
    expect(plan.peers[0].addresses).toHaveLength(3);
    expect(planObserverPeers([])).toEqual({ peers: [], nextCursor: 0 });
  });
  it('clears the timeout for completed work and bounds stalled operations', async () => {
    vi.useFakeTimers();
    await expect(observerTimeout(Promise.resolve('done'), 5000)).resolves.toBe('done');
    expect(vi.getTimerCount()).toBe(0);
    const stalled = observerTimeout(new Promise(() => {}), 5000);
    const rejection = expect(stalled).rejects.toThrow('Observer timeout');
    await vi.advanceTimersByTimeAsync(5000); await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
});

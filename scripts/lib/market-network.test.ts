import { describe, expect, it, vi } from 'vitest';
import { createCatalogRefresher, networkSnapshot } from '../../apps/marketplace/public/market-network.js';

const now = 1_700_000_000_000;
const seller = (peerId: string) => ({ peerId, chainId: 97, status: 'reachable', observedAt: now, announcementAt: now });

describe('network page catalog updates', () => {
  it('includes newly discovered sellers alongside entry nodes in subsequent snapshots', () => {
    const nodes = [{ id: 'entry', status: 'online', checkedAt: now }];
    const first = networkSnapshot({ nodes, sellers: [seller('existing')] }, now);
    const next = networkSnapshot({ nodes, sellers: [seller('existing'), seller('new')] }, now);
    expect(first.sellers.map(item => item.peerId)).toEqual(['existing']);
    expect(next.sellers.map(item => item.peerId)).toEqual(['existing', 'new']);
    expect(next.nodes).toEqual(nodes);
  });
  it('expires online labels after failures, removes long-expired rows, and excludes other chains', () => {
    const catalog = { nodes: [{ status: 'online', checkedAt: now }], sellers: [seller('seller'), { ...seller('other-chain'), chainId: 56 }] };
    expect(networkSnapshot(catalog, now + 100_000).nodes[0].status).toBe('stale');
    expect(networkSnapshot(catalog, now + 100_000).sellers).toEqual([{ ...seller('seller'), status: 'stale' }]);
    expect(networkSnapshot(catalog, now + 600_000).sellers).toEqual([]);
    expect(catalog.sellers[0].status).toBe('reachable');
  });
  it('shares overlapping manual and timer refreshes, then accepts a later catalog with a new seller', async () => {
    let finish!: (value: unknown) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce({ sellers: [seller('new')] });
    const onCatalog = vi.fn(), onBusy = vi.fn(), onError = vi.fn();
    const refresh = createCatalogRefresher({ read, onCatalog, onBusy, onError });
    const first = refresh(), timer = refresh(); expect(timer).toBe(first);
    await Promise.resolve(); finish({ sellers: [] }); await first;
    expect(read).toHaveBeenCalledTimes(1);
    await refresh(); expect(onCatalog).toHaveBeenLastCalledWith({ sellers: [seller('new')] });
    expect(onBusy.mock.calls).toEqual([[true], [false], [true], [false]]);
    expect(onError).not.toHaveBeenCalled();
  });
  it('shows a failed refresh without replacing the last catalog, then can retry', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ sellers: [] });
    const onCatalog = vi.fn(), onError = vi.fn(), onBusy = vi.fn();
    const refresh = createCatalogRefresher({ read, onCatalog, onError, onBusy });
    await refresh(); expect(onCatalog).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledOnce();
    expect(onBusy).toHaveBeenLastCalledWith(false);
    await refresh(); expect(onCatalog).toHaveBeenCalledWith({ sellers: [] });
  });
});

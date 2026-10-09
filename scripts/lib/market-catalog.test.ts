import { describe, expect, it } from 'vitest';
import { publicAnnouncement, catalogSnapshot, probeBootstrap, configuredBootstrapSources } from './market-catalog.mjs';
const now = Date.now();
const announcement = { peerId: '12D3KooWTestProvider', walletAddress: '0x1111111111111111111111111111111111111111', timestamp: now,
  paymentToken: { chainId: 97, symbol: 'USDC', decimals: 6, address: '0xFcc26b50731525a4452D0ED428cdf11058723B89' },
  settlementPool: '0x90D30bA5d3e72A029335D2B879786ba912EA6e5F', models: [{ model: 'sample-model', inputPer1m: 1, outputPer1m: 2 }],
  backendURL: 'secret upstream URL', apiKey: 'private fixture', queue: ['private buyer'] };
describe('public market catalog', () => {
  it('reads operator endpoints only from configuration and rejects credential-bearing URLs', () => {
    expect(configuredBootstrapSources('')).toEqual([]);
    expect(configuredBootstrapSources('[{"id":"test-node","url":"https://bootstrap.example.com"}]')).toEqual([{ id: 'test-node', name: 'Bootstrap 1', host: 'bootstrap.example.com', url: 'https://bootstrap.example.com' }]);
    for (const raw of ['{}', '[{"url":"file:///private/config"}]', '[{"url":"https://account:secret@bootstrap.example.com"}]', '[{"url":"https://bootstrap.example.com?token=private"}]']) expect(() => configuredBootstrapSources(raw)).toThrow();
  });
  it('shows actual p0-based base rates from old 60/60 fields and marks dynamic pricing', () => {
    const result = publicAnnouncement({ ...announcement, models: [{ model: 'sol', inputPer1m: 60, outputPer1m: 60, p0: 5, alpha: 1 }] }, now);
    expect(result.models[0]).toEqual({ model: 'sol', inputPer1m: 5, outputPer1m: 5, p0: 5, dynamic: true });
  });
  it('publishes only a small announcement projection, without server management details or origin proof', () => {
    const safe = publicAnnouncement(announcement, now); expect(safe.authenticityProof).toBe(false); expect(safe.informationSource).toBe('seller-announcement');
    expect(safe).not.toHaveProperty('backendURL'); expect(safe).not.toHaveProperty('apiKey'); expect(safe).not.toHaveProperty('queue');
  });
  it('rejects the wrong token, wrong pool, future time, negative prices, and unsupported network', () => {
    expect(publicAnnouncement({ ...announcement, settlementPool: announcement.walletAddress }, now)).toBeNull();
    expect(publicAnnouncement({ ...announcement, paymentToken: { ...announcement.paymentToken, chainId: 56 } }, now)).toBeNull();
    expect(publicAnnouncement({ ...announcement, paymentToken: { ...announcement.paymentToken, address: announcement.walletAddress } }, now)).toBeNull();
    expect(publicAnnouncement({ ...announcement, timestamp: now + 60_000 }, now)).toBeNull();
    expect(publicAnnouncement({ ...announcement, models: [{ model: 'model', inputPer1m: -1, outputPer1m: 2 }] }, now)).toBeNull();
  });
  it('does not count stale sellers as currently reachable and expires their rows', () => {
    const seller = publicAnnouncement(announcement, now);
    const stale = catalogSnapshot({ nodes: [], sellers: [seller], observedAt: now, now: now + 100_000 });
    expect(stale.stats.visibleSellers).toBe(0); expect(stale.sellers[0].status).toBe('stale');
    expect(catalogSnapshot({ nodes: [], sellers: [seller], observedAt: now, now: now + 600_001 }).sellers).toEqual([]);
  });
  it('excludes other networks even when an old observer cache contains their valid announcement', () => {
    const old = { ...announcement, paymentToken: { symbol: 'USDC', decimals: 6, chainId: 84532, address: '0xcF0819eb156D6c6c1c5d9A515E351D2D1aefff7D' }, settlementPool: '0x8A392a77eb88f477FeF060033937a2e4692Eb56E' };
    expect(publicAnnouncement(old, now)).toBeNull();
    const seller = publicAnnouncement(announcement, now);
    const catalog = catalogSnapshot({ nodes: [], sellers: [seller, { ...seller, chainId: 84532 }, { ...seller, chainId: 1952 }], observedAt: now, now });
    expect(catalog.chainId).toBe(97); expect(catalog.sellers).toHaveLength(1); expect(catalog.stats.visibleSellers).toBe(1);
  });
  it('does not show failed or unrelated HTTP health responses as online entry nodes', async () => {
    const source = configuredBootstrapSources('[{"url":"https://bootstrap.example.com"}]')[0];
    const result = await probeBootstrap(source, async () => new Response(JSON.stringify({ status: 'ok', role: 'model-seller', peerId: 'unknown' })));
    expect(result.status).toBe('unavailable'); expect(result).not.toHaveProperty('connections');
  });
});

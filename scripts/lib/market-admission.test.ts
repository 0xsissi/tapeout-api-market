import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { MarketAdmission } from './market-admission.mjs';
const PILOT_SELLER = '0x2222222222222222222222222222222222222222';
import { startMarketServer } from './market-server.mjs';
import { syncApprovedBuyers } from './admission-sync.mjs';
const directories: string[] = [];
afterEach(() => { for (const d of directories.splice(0)) { if (!d.startsWith(path.join(os.tmpdir(), 'tam-admission-'))) throw new Error('Unexpected test directory'); fs.rmSync(d, { recursive: true, force: true }); } });
function setup() { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-admission-')); directories.push(directory); let now = Date.now(); const admission = new MarketAdmission({ directory, origin: 'https://market.example', now: () => now, sellers: [PILOT_SELLER] }); return { directory, admission, advance: (ms: number) => now += ms }; }
async function apply(a: any, wallet = ethers.Wallet.createRandom(), ip = 'test-ip') { const c = a.challenge({ address: wallet.address, sellerAddress: PILOT_SELLER, currency: 'USDC' }, ip); const signature = await wallet.signMessage(c.message); return { c, signature, result: a.submit({ id: c.id, signature }, ip), wallet }; }
describe('reviewed buyer access', () => {
  it('never treats ownership proof or an application as access; persists idempotent results without signatures', async () => {
    const s = setup(), r = await apply(s.admission);
    expect(r.result.status).toBe('pending'); expect(s.admission.approved().grants).toEqual([]);
    expect(s.admission.submit({ id: r.c.id, signature: r.signature }, 'test-ip')).toEqual(r.result);
    expect(fs.readFileSync(path.join(s.directory, r.c.id + '.json'), 'utf8')).not.toContain(r.signature);
    expect(r.c.message).toContain('does not authorize a payment'); expect(r.c.message).toContain('Approved wallet addresses are published');
    expect(() => s.admission.challenge({ address: r.wallet.address, sellerAddress: PILOT_SELLER, currency: 'USDC' }, 'test-ip')).toThrow('已经提交');
  });
  it('rejects forged signers, different source, unsupported seller, stale challenge, and path traversal', async () => {
    const s = setup(), w = ethers.Wallet.createRandom(); const c = s.admission.challenge({ address: w.address, sellerAddress: PILOT_SELLER, currency: 'USDC' }, 'ip');
    expect(() => s.admission.submit({ id: c.id, signature: ethers.Wallet.createRandom().signingKey.sign(ethers.hashMessage(c.message)).serialized }, 'ip')).toThrow('申请钱包');
    expect(() => s.admission.submit({ id: c.id, signature: '0x' }, 'other-ip')).toThrow('来源');
    expect(() => s.admission.challenge({ address: w.address, sellerAddress: w.address, currency: 'USDC' }, 'ip')).toThrow('本站');
    s.advance(300001); expect(() => s.admission.submit({ id: c.id, signature: '0x' }, 'ip')).toThrow('过期'); expect(() => s.admission.status('../salt')).toThrow('无效');
  });
  it('requires operator review, scopes/expiries grants, revokes them, and serializes reviews', async () => {
    const s = setup(), r = await apply(s.admission);
    s.admission.review(r.c.id, 'approved', 1); const g = s.admission.approved().grants[0];
    expect(g).toMatchObject({ address: r.wallet.address, sellerAddress: PILOT_SELLER, currency: 'USDC', chainId: 97, poolAddress: '0x90D30bA5d3e72A029335D2B879786ba912EA6e5F' });
    fs.mkdirSync(path.join(s.directory, 'review.lock')); expect(() => s.admission.review(r.c.id, 'rejected')).toThrow(); fs.rmdirSync(path.join(s.directory, 'review.lock'));
    s.advance(3600001); expect(s.admission.status(r.c.id).status).toBe('expired'); expect(s.admission.approved().grants).toEqual([]);
    s.admission.review(r.c.id, 'approved', 1); s.admission.review(r.c.id, 'rejected'); expect(s.admission.status(r.c.id).status).toBe('rejected'); expect(s.admission.approved().grants).toEqual([]);
  });
  it('protects HTTP origins/admin files while exposing only reviewed public grants', async () => {
    const s = setup(), server = await startMarketServer({ port: 0, origin: 'https://market.example', admission: s.admission, getCatalog: () => ({ sellers: [] }) }); const base = `http://127.0.0.1:${server.port}`;
    try {
      const r = await fetch(base + '/api/admission/challenge', { method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}' }); expect(r.status).toBe(403);
      for (const url of ['/salt', '/approved-buyers.json', '/api/admission/approve', '/downloads/../wallet.json']) expect((await fetch(base + url)).status).toBe(404);
      expect(await (await fetch(base + '/api/admission/approved')).json()).toEqual({ version: 1, grants: [] });
      for (const url of ['/skill.md', '/llms.txt', '/install.mjs']) expect((await fetch(base + url)).status).toBe(200);
    } finally { await server.stop(); }
  });
  it('syncs only an explicitly configured HTTPS authority and preserves prior grants on failure', async () => {
    const s = setup(), file = path.join(s.directory, 'remote.json'), r = await apply(s.admission); s.admission.review(r.c.id, 'approved');
    const fetcher = async () => new Response(JSON.stringify(s.admission.approved()));
    await syncApprovedBuyers({ origin: 'https://market.example', file, fetcher }); const prior = fs.readFileSync(file, 'utf8');
    await expect(syncApprovedBuyers({ origin: 'http://evil.example', file, fetcher })).rejects.toThrow('HTTPS');
    await expect(syncApprovedBuyers({ origin: 'https://market.example', file, fetcher: async () => new Response('{"version":1,"grants":[{"chainId":56}]}') })).rejects.toThrow('Invalid'); expect(fs.readFileSync(file, 'utf8')).toBe(prior);
    s.admission.review(r.c.id, 'rejected'); await syncApprovedBuyers({ origin: 'https://market.example', file, fetcher }); expect(JSON.parse(fs.readFileSync(file, 'utf8')).grants).toEqual([]);
  });
});

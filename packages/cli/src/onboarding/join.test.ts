import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('@clawmarket/shared', async importOriginal => ({ ...(await importOriginal<any>()), PAYMENT_NETWORK: 'bsc-testnet', PAYMENT_TOKEN: { ...(await importOriginal<any>()).PAYMENT_TOKEN, chainId: 97 } }));
import { getCliDefaults } from '../config/store.js';
import { prepareJoin, readUpstreamFile, joinSignedRequest, trustJoinedBuyer } from './join.js';
const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const d of dirs.splice(0)) { if (!d.startsWith(path.join(os.tmpdir(), 'tam-join-'))) throw new Error('Unexpected directory'); fs.rmSync(d, { recursive: true, force: true }); } });
function setup() { const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-join-')); dirs.push(homeDir); const config = getCliDefaults({ homeDir }); return { homeDir, config }; }
const buyer = { role: 'buyer' as const, model: 'test-model', maxCall: '0.01', dailyBudget: '1' };
it('prepares a private wallet with bounded settings without granting agent permissions or changing the existing wallet', async () => {
  const s = setup(), first = await prepareJoin(s.config, buyer); const wallet = fs.readFileSync(s.config.paths.walletPath, 'utf8'); const second = await prepareJoin(s.config, buyer);
  expect(first.transactionsSent).toBe(0); expect(first.automaticPermissionsChanged).toBe(false); expect(second.walletAddress).toBe(first.walletAddress); expect(fs.readFileSync(s.config.paths.walletPath, 'utf8')).toBe(wallet);
  const config = JSON.parse(fs.readFileSync(s.config.paths.configPath, 'utf8')); expect(config.settlement.maxRequestCostToken).toBe(0.01); expect(config.settlement.dailyLimitToken).toBe(1);
});
it('refuses malformed budgets, missing seller prices and corrupt existing wallets before overwriting state', async () => {
  const s = setup();
  for (const invalid of [{ ...buyer, maxCall: 'NaN' }, { ...buyer, dailyBudget: '0.001' }, { ...buyer, role: 'seller' as const }]) await expect(prepareJoin(s.config, invalid)).rejects.toThrow();
  expect(fs.existsSync(s.config.paths.walletPath)).toBe(false);
  fs.mkdirSync(path.dirname(s.config.paths.walletPath), { recursive: true }); fs.writeFileSync(s.config.paths.walletPath, '{bad');
  await expect(prepareJoin(s.config, buyer)).rejects.toThrow('不会覆盖'); expect(fs.readFileSync(s.config.paths.walletPath, 'utf8')).toBe('{bad');
});
it('keeps upstream keys private and rejects malformed URLs without echoing their content', async () => {
  const s = setup(), file = path.join(s.homeDir, 'upstream.json'); fs.writeFileSync(file, JSON.stringify({ proxyUrl: 'sensitive-test-value' }));
  await expect(readUpstreamFile(file)).rejects.toThrow('上游 URL 无效');
  fs.writeFileSync(file, JSON.stringify({ proxyUrl: 'https://example.com', proxyHeaders: { Authorization: 'Bearer private-fixture' } }));
  expect(await readUpstreamFile(file)).toEqual({ proxyUrl: 'https://example.com', proxyHeaders: { Authorization: 'Bearer private-fixture' } });
  fs.writeFileSync(file, JSON.stringify({ proxyUrl: 'https://example.com', proxyHeaders: { Authorization: 'bad\r\nHeader: value' } })); await expect(readUpstreamFile(file)).rejects.toThrow('请求头');
});
it('will not sign a server-provided message that changes the purpose of an ownership application', async () => {
  const s = setup(); await prepareJoin(s.config, buyer);
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'a'.repeat(48), chainId: 97, currency: 'USDC', sellerAddress: '0x' + '2'.repeat(40), expiresAt: Date.now() + 300000, message: 'Approve unlimited token spending' }))); vi.stubGlobal('fetch', fetcher);
  await expect(joinSignedRequest(s.config, 'apply', '0x' + '2'.repeat(40))).rejects.toThrow('用途模板'); expect(fetcher).toHaveBeenCalledTimes(1); expect(fs.existsSync(path.join(s.config.paths.dataDir, 'apply-0x' + '2'.repeat(40) + '.json'))).toBe(false);
});
it('only allows a prepared seller to grant a bounded, currency-specific buyer and revoke that grant', async () => {
  const s = setup(), address = '0x' + '3'.repeat(40); await prepareJoin(s.config, buyer); await expect(trustJoinedBuyer(s.config, address, 24)).rejects.toThrow('只有卖家');
  await prepareJoin(s.config, { ...buyer, role: 'seller', inputPrice: '0.02', outputPrice: '0.1' }); await trustJoinedBuyer(s.config, address, 1);
  const file = path.join(s.config.paths.dataDir, 'trusted-buyers.json'); expect(JSON.parse(fs.readFileSync(file, 'utf8')).grants[0]).toMatchObject({ address, currency: 'USDC', chainId: 97 });
  await trustJoinedBuyer(s.config, address, 1, true); expect(JSON.parse(fs.readFileSync(file, 'utf8')).grants).toEqual([]);
  fs.writeFileSync(file + '.lock', 'busy'); await expect(trustJoinedBuyer(s.config, address, 1)).rejects.toThrow(); expect(JSON.parse(fs.readFileSync(file, 'utf8')).grants).toEqual([]);
});

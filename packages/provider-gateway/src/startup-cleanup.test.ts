import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@clawmarket/shared', async () => ({
  ...await vi.importActual<typeof import('@clawmarket/shared')>('@clawmarket/shared'),
  assertPaymentDeployment: vi.fn(async () => {}),
}));
import { ProviderGateway } from './sidecar.js';

let home: string;
let gateway: ProviderGateway | undefined;
afterEach(async () => {
  await gateway?.stop();
  vi.unstubAllEnvs();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

it('releases the ledger, watcher and P2P node after startup fails before running becomes true', async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-partial-seller-'));
  vi.stubEnv('TAM_HOME', home);
  const privateKey = `0x${'11'.repeat(32)}` as `0x${string}`;
  const pool = '0x1111111111111111111111111111111111111111' as const;
  const wallet = new Wallet(privateKey);
  const stop = vi.fn(async () => {});
  gateway = new ProviderGateway({
    privateKey, proxyUrl: 'http://127.0.0.1:1', models: [{ model: 'fixture', inputPer1m: 1, outputPer1m: 1 }],
    escrowPoolAddress: pool, chainId: 97, rpcUrl: 'http://127.0.0.1:1', bootstrapPeers: [], dailyLimitUsd: 1,
  }, async () => ({ peerId: { toString: () => 'fixture' }, start: async () => { throw new Error('fixture P2P startup failure'); }, stop }) as any);
  const lock = path.join(home, '.clawmarket-provider', '97', pool, wallet.address.toLowerCase(), 'ledger.lock');
  expect(fs.existsSync(lock)).toBe(true);
  await expect(gateway.start()).rejects.toThrow('fixture P2P startup failure');
  await gateway.stop();
  expect(stop).toHaveBeenCalledOnce();
  expect(fs.existsSync(lock)).toBe(false);
  await gateway.stop();
  expect(stop).toHaveBeenCalledOnce();
});

import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { approvedBuyer } from './trusted-buyers.js';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { if (!d.startsWith(path.join(os.tmpdir(), 'tam-trust-'))) throw new Error('Unexpected directory'); fs.rmSync(d, { recursive: true, force: true }); } });
it('matches every grant dimension and reads revocation without restarting the seller', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-trust-')); dirs.push(d); const file = path.join(d, 'buyers.json'), address = '0x' + '1'.repeat(40), scope = { sellerAddress: '0x' + '2'.repeat(40), currency: 'USDC', chainId: 97, poolAddress: '0x' + '3'.repeat(40) };
  const save = (grants: unknown[]) => fs.writeFileSync(file, JSON.stringify({ version: 1, grants }));
  expect(approvedBuyer(address, file, scope, 100)).toBe(false); save([{ address, ...scope, expiresAt: 200 }]); expect(approvedBuyer(address, file, scope, 100)).toBe(true);
  for (const patch of [{ currency: 'BEM' }, { chainId: 56 }, { sellerAddress: address }, { poolAddress: address }]) expect(approvedBuyer(address, file, { ...scope, ...patch }, 100)).toBe(false);
  expect(approvedBuyer(address, file, scope, 200)).toBe(false); save([]); expect(approvedBuyer(address, file, scope, 100)).toBe(false);
  fs.writeFileSync(file, '{invalid'); expect(approvedBuyer(address, file, scope, 100)).toBe(false);
});

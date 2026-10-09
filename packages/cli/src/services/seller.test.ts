import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { loadSeededNetworkStatus } from './seller.js';
import { BEM_PAYMENT_TOKEN } from '@clawmarket/shared';

describe('seller services', () => {
  it('builds a seeded network status from announcement bundles', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-seed-'));
    const seedPath = path.join(tempDir, 'seed.json');
    await writeFile(
      seedPath,
      JSON.stringify({
        announcement: {
          peerId: '12D3KooWTestPeer',
          walletAddress: '0xabc123',
          region: 'test',
          maxConcurrent: 2,
          timestamp: 123456,
          models: [{ model: 'gpt-5.4', inputPer1m: 60, outputPer1m: 60 }],
        },
        multiaddrs: ['/ip4/127.0.0.1/tcp/19190'],
      }),
      'utf8',
    );

    const status = await loadSeededNetworkStatus(seedPath, 'gpt-5.4');

    expect(status?.source).toBe('seed');
    expect(status?.bestProvider?.peerId).toBe('12D3KooWTestPeer');
    expect(status?.models[0]?.bestProvider?.inputPer1m).toBe(60);
  });
  it('hides seeded sellers whose currency or explicit pool does not match the selected profile', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tam-seed-currency-'));
    const file = path.join(dir, 'seed.json');
    const announcement = { peerId: 'peer', walletAddress: 'wallet', models: [{ model: 'model', inputPer1m: 1000, outputPer1m: 2000 }] };
    await writeFile(file, JSON.stringify({ announcement: { ...announcement, paymentToken: BEM_PAYMENT_TOKEN } }));
    expect(await loadSeededNetworkStatus(file, 'model')).toBeNull();
    await writeFile(file, JSON.stringify({ announcement: { ...announcement, settlementPool: '0x2222222222222222222222222222222222222222' } }));
    expect(await loadSeededNetworkStatus(file, 'model')).toBeNull();
  });
});

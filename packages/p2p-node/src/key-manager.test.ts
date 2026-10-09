import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ensureQuoteSigningKey } from './key-manager.js';

describe('ensureQuoteSigningKey', () => {
  it('creates a signing key on first use and reuses it while fresh', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-signing-key-'));
    const keyPath = path.join(dir, 'signing.key.json');

    const created = await ensureQuoteSigningKey(keyPath, { now: 1_700_000_000_000 });
    const reused = await ensureQuoteSigningKey(keyPath, { now: 1_700_000_000_000 + 1_000 });

    expect(created.privateKey).toBe(reused.privateKey);
    expect(created.address).toBe(reused.address);
    expect(reused.rotated).toBe(false);

    const persisted = JSON.parse(await readFile(keyPath, 'utf8'));
    expect(persisted.privateKey).toBe(created.privateKey);
    expect(persisted.createdAt).toBe(1_700_000_000_000);
  });

  it('rotates a stale signing key after the max age window', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-signing-key-'));
    const keyPath = path.join(dir, 'signing.key.json');

    const created = await ensureQuoteSigningKey(keyPath, {
      now: 1_700_000_000_000,
      maxAgeMs: 5_000,
    });
    const rotated = await ensureQuoteSigningKey(keyPath, {
      now: 1_700_000_000_000 + 5_001,
      maxAgeMs: 5_000,
    });

    expect(rotated.privateKey).not.toBe(created.privateKey);
    expect(rotated.address).not.toBe(created.address);
    expect(rotated.rotated).toBe(true);
  });
});

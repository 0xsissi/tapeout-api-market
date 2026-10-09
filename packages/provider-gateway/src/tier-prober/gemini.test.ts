import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeGemini } from './gemini.js';

describe('probeGemini', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('returns creds_missing when the oauth file is absent', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'gemini-probe-'));
    await expect(probeGemini(path.join(tempDir, 'missing.json'))).resolves.toEqual({
      ok: false,
      reason: 'creds_missing',
    });
  });

  it('maps loadCodeAssist tiers to local presets', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'gemini-probe-'));
    const credsPath = path.join(tempDir, 'oauth_creds.json');
    await writeFile(credsPath, JSON.stringify({ access_token: 'token' }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      currentTier: { id: 'standard-tier' },
    }), { status: 200 })));

    await expect(probeGemini(credsPath)).resolves.toEqual({
      ok: true,
      tier: 'gemini-standard',
      evidence: { userTier: 'standard-tier', source: 'loadCodeAssist' },
    });
  });
});

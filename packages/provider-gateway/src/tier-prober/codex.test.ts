import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { probeCodex } from './codex.js';

describe('probeCodex', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await import('node:fs/promises').then((fs) => fs.rm(tempDir!, { recursive: true, force: true }));
      tempDir = null;
    }
  });

  it('reads plan type from the local JWT payload', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-probe-'));
    const authPath = path.join(tempDir, 'auth.json');
    const payload = Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
    })).toString('base64url');
    await writeFile(authPath, JSON.stringify({
      tokens: { id_token: `header.${payload}.sig` },
    }));

    await expect(probeCodex(authPath)).resolves.toEqual({
      ok: true,
      tier: 'chatgpt-plus',
      evidence: { planType: 'plus', source: 'jwt' },
    });
  });

  it('returns plan_type_missing when the claim is absent', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-probe-'));
    const authPath = path.join(tempDir, 'auth.json');
    const payload = Buffer.from(JSON.stringify({})).toString('base64url');
    await writeFile(authPath, JSON.stringify({
      tokens: { id_token: `header.${payload}.sig` },
    }));

    await expect(probeCodex(authPath)).resolves.toEqual({
      ok: false,
      reason: 'plan_type_missing',
    });
  });
});

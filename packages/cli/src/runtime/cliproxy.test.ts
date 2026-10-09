import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { syncCodexCliAuthToCliproxy } from './cliproxy.js';

describe('cliproxy runtime auth sync', () => {
  it('reuses local Codex auth.json for seller auth when auth dir is empty', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-cliproxy-'));
    const authDir = path.join(root, 'auths');
    const codexAuthPath = path.join(root, 'codex-auth.json');
    await mkdir(authDir);

    await writeFile(codexAuthPath, `${JSON.stringify({
      auth_mode: 'chatgpt',
      last_refresh: '2026-04-21T07:40:54.877Z',
      tokens: {
        id_token: makeJwt({
          email: 'user@example.com',
          sub: 'user-123',
          exp: 1_777_777_777,
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct-123',
            chatgpt_plan_type: 'plus',
          },
        }),
        access_token: makeJwt({
          exp: 1_777_777_777,
        }),
        refresh_token: 'rt_example',
        account_id: 'acct-123',
      },
    }, null, 2)}\n`, 'utf8');

    const synced = await syncCodexCliAuthToCliproxy('codex', authDir, codexAuthPath);

    expect(synced).toMatchObject({
      sourceAuthPath: codexAuthPath,
      targetAuthPath: path.join(authDir, 'codex-user@example.com-plus.json'),
    });

    const saved = JSON.parse(await readFile(synced!.targetAuthPath, 'utf8'));
    expect(saved).toMatchObject({
      type: 'codex',
      email: 'user@example.com',
      refresh_token: 'rt_example',
      account_id: 'acct-123',
      last_refresh: '2026-04-21T07:40:54.877Z',
    });
    expect(saved.access_token).toContain('.');
    expect(saved.id_token).toContain('.');
    expect(saved.expired).toBe('2026-05-03T03:09:37.000Z');
  });

  it('does not overwrite an existing seller auth dir', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-cliproxy-'));
    const authDir = path.join(root, 'auths');
    const codexAuthPath = path.join(root, 'codex-auth.json');
    await mkdir(authDir);
    await writeFile(path.join(authDir, 'existing.json'), '{"type":"codex"}\n', 'utf8');
    await writeFile(codexAuthPath, '{}\n', 'utf8');

    await expect(syncCodexCliAuthToCliproxy('codex', authDir, codexAuthPath)).resolves.toBeNull();
  });
});

function makeJwt(payload: Record<string, unknown>): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  return [
    encodeBase64Url(header),
    encodeBase64Url(payload),
    'signature',
  ].join('.');
}

function encodeBase64Url(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

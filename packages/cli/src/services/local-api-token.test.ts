import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLocalApiToken } from './local-api-token.js';
import { fetchWithTimeout } from './http.js';

const fileToken = 'fixture-file-api-token-012345678901234567890123456789';
const envToken = 'fixture-env-api-token-012345678901234567890123456789';
beforeEach(() => vi.stubEnv('CLAWMARKET_API_TOKEN', undefined));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function tokenHome(value = fileToken) {
  const home = await mkdtemp(path.join(tmpdir(), 'tam-local-api-key-'));
  await mkdir(path.join(home, '.clawmarket'));
  await writeFile(path.join(home, '.clawmarket', 'api-token'), value);
  return home;
}

describe('local API credential source', () => {
  it('reads the current profile home without creating or touching a wallet', async () => {
    const home = await tokenHome(`\n${fileToken}\n`);
    expect(readLocalApiToken('http://127.0.0.1:18380', home)).toBe(fileToken);
    expect(existsSync(path.join(home, '.clawmarket', 'wallet.json'))).toBe(false);
  });
  it('uses the same environment override for display and HTTP authentication', async () => {
    const home = await tokenHome();
    vi.stubEnv('CLAWMARKET_API_TOKEN', envToken);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    expect(readLocalApiToken('http://localhost:18380', home)).toBe(envToken);
    await fetchWithTimeout('http://localhost:18380/v1/models');
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: `Bearer ${envToken}` });
  });
  it('does not create a credential when the buyer has not generated one', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'tam-missing-api-key-'));
    expect(readLocalApiToken('http://127.0.0.1:18380', home)).toBeNull();
    expect(existsSync(path.join(home, '.clawmarket'))).toBe(false);
  });
  it.each(['https://api.example.com', 'http://127.0.0.1.example.com', 'file://localhost/api', 'invalid', 'http://owner:fixture@localhost:18380'])('does not expose the local credential for %s', url => {
    vi.stubEnv('CLAWMARKET_API_TOKEN', envToken);
    expect(readLocalApiToken(url)).toBeNull();
  });
  it('does not attach a local credential to a remote request', async () => {
    vi.stubEnv('CLAWMARKET_API_TOKEN', envToken);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    await fetchWithTimeout('https://api.example.com/models');
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).not.toHaveProperty('authorization');
  });
  it('rejects incomplete or control-character credentials', async () => {
    expect(readLocalApiToken('http://127.0.0.1:18380', await tokenHome('short'))).toBeNull();
    expect(readLocalApiToken('http://127.0.0.1:18380', await tokenHome(fileToken + '\u001b[31m'))).toBeNull();
  });
});

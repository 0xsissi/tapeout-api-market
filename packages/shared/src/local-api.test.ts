import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLocalApiToken } from './local-api.js';
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) { if (!d.startsWith(path.join(os.tmpdir(), 'tam-api-profile-'))) throw new Error('Unexpected directory'); fs.rmSync(d, { recursive: true, force: true }); } });
it('isolates gateway credentials per explicit TAM profile and keeps tokens stable inside that profile', () => {
  vi.stubEnv('CLAWMARKET_API_TOKEN', '');
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-api-profile-')), b = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-api-profile-')); dirs.push(a, b);
  vi.stubEnv('TAM_HOME', a); const first = loadLocalApiToken(); expect(loadLocalApiToken()).toBe(first); expect(fs.existsSync(path.join(a, '.clawmarket/api-token'))).toBe(true);
  vi.stubEnv('TAM_HOME', b); expect(loadLocalApiToken()).not.toBe(first);
});

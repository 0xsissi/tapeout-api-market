import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Owner-only gateway credential; never return it through the AI controller API. */
export function loadLocalApiToken(): string {
  if (process.env.CLAWMARKET_API_TOKEN) {
    if (process.env.CLAWMARKET_API_TOKEN.length < 32) throw new Error('Local API token must contain at least 32 characters');
    return process.env.CLAWMARKET_API_TOKEN;
  }
  const directory = path.join(process.env.TAM_HOME ?? process.env.HOME ?? homedir(), '.clawmarket');
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'api-token');
  if (!existsSync(file)) { try { writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
  const token = readFileSync(file, 'utf8').trim();
  if (token.length < 32) throw new Error('Local API token must contain at least 32 characters');
  return token;
}

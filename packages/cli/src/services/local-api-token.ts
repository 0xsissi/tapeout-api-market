import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function isLocalApiUrl(url: string): boolean {
  try {
    const target = new URL(url);
    return ['http:', 'https:'].includes(target.protocol) && ['127.0.0.1', 'localhost'].includes(target.hostname) && !target.username && !target.password;
  } catch { return false; }
}

/** Read the existing owner credential; never create one or expose it for a remote gateway. */
export function readLocalApiToken(url: string, homeDir = process.env.TAM_HOME ?? process.env.HOME ?? homedir()): string | null {
  if (!isLocalApiUrl(url)) return null;
  try {
    const token = process.env.CLAWMARKET_API_TOKEN ?? readFileSync(path.join(homeDir, '.clawmarket', 'api-token'), 'utf8').trim();
    return token.length >= 32 && !/[\u0000-\u001f\u007f]/.test(token) ? token : null;
  } catch { return null; }
}

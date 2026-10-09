import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export function loadApiToken(): string {
  const dir = path.join(process.env.TAM_HOME ?? process.env.HOME ?? os.homedir(), '.clawmarket');
  const file = path.join(dir, 'api-token');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) {
    try { fs.writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const token = fs.readFileSync(file, 'utf8').trim();
  if (token.length < 32) throw new Error('Local API token must contain at least 32 characters');
  return token;
}

export function validLocalRequest(req: IncomingMessage, port: number): boolean {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (req.headers.host && !allowedHosts.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  if (Array.isArray(origin)) return false;
  try { return allowedHosts.has(new URL(origin).host) && new URL(origin).protocol === 'http:'; }
  catch { return false; }
}

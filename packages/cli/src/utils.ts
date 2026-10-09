import { PAYMENT_TOKEN, PAYMENT_SCALE, formatPaymentAmount } from '@clawmarket/shared';
import { access, readFile, readdir } from 'node:fs/promises';
import { ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import type { ServiceStatus } from './types.js';
import { getWalletPath, readStoredWallet } from './wallet/store.js';

export function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function normalizeInterval(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 3000;
  }

  return Math.max(500, Math.floor(value));
}

export function extractPortFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    return parsed.port ? Number(parsed.port) : null;
  } catch {
    return null;
  }
}

export function parseMicroUsdc(value: string): bigint {
  const trimmed = value.trim();
  const sign = trimmed.startsWith('-') ? -1n : 1n;
  const normalized = trimmed.replace(/^[+-]/, '');
  const [wholePart, fractionPart = ''] = normalized.split('.', 2);
  const whole = BigInt(wholePart || '0');
  const fraction = BigInt(fractionPart.padEnd(PAYMENT_TOKEN.decimals, '0').slice(0, PAYMENT_TOKEN.decimals) || '0');
  return sign * (whole * PAYMENT_SCALE + fraction);
}

export function formatMicroUsdc(value: bigint): string { return formatPaymentAmount(value); }

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function directoryHasRealFiles(dirPath: string): Promise<boolean> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && !entry.name.startsWith('.'));
  } catch {
    return false;
  }
}

export async function readPrivateKeyFromWallet(filePath: string, label: string): Promise<string> {
  try {
    const wallet = await readStoredWallet(filePath || getWalletPath());
    return wallet.privateKey;
  } catch (error) {
    throw new Error(
      `Cannot read ${label} at ${filePath || getWalletPath()}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function waitForChildExit(child: ChildProcess): Promise<number | null> {
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}

export function formatRequestError(url: string, error: unknown, kind?: 'buyer' | 'seller'): string {
  const parsed = safeParseUrl(url);
  const serviceLabel = kind === 'seller' || parsed?.port === '8787' || parsed?.pathname.startsWith('/v1/seller')
    ? 'seller 状态 API'
    : 'buyer gateway';
  const endpoint = parsed ? `${parsed.hostname}:${parsed.port || '(default)'}` : url;
  const cause = extractNestedErrorMessage(error);
  return `无法连接 ${serviceLabel}（${endpoint}）：${cause}`;
}

export function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function extractNestedErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = error.cause;
  if (cause && typeof cause === 'object') {
    const record = cause as Record<string, unknown>;
    if (typeof record.code === 'string' && record.code === 'ECONNREFUSED') {
      return '服务还没启动，或者刚刚已经退出。';
    }
    if (typeof record.message === 'string') {
      return record.message;
    }
  }

  if (error.message === 'fetch failed') {
    return '服务还没启动，或者刚刚已经退出。';
  }

  if (error.name === 'AbortError' || /aborted/i.test(error.message)) {
    return '请求超时，请稍后重试；如果一直超时，请重启 buyer。';
  }

  return error.message;
}

export function shortenAddress(value: string): string {
  if (value.length <= 12) {
    return value;
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function shortenPeerId(value: string): string {
  if (value.length <= 18) {
    return value;
  }

  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

export async function waitForService(
  url: string,
  timeoutMs: number,
  getStatus: (targetUrl: string, kind: 'buyer' | 'seller') => Promise<ServiceStatus>,
  kind: 'buyer' | 'seller',
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const status = await getStatus(url, kind);
    signal?.throwIfAborted();
    if (status.online) {
      return true;
    }
    await delay(750, undefined, { signal });
  }
  return false;
}

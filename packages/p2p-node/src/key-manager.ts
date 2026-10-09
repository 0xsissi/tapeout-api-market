import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Wallet } from 'ethers';

export interface ManagedSigningKey {
  privateKey: `0x${string}`;
  address: `0x${string}`;
  createdAt: number;
  rotated: boolean;
}

interface StoredSigningKey {
  version: 1;
  privateKey: `0x${string}`;
  createdAt: number;
}

const DEFAULT_SIGNING_KEY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function ensureQuoteSigningKey(
  identityPath: string,
  options?: {
    maxAgeMs?: number;
    now?: number;
  },
): Promise<ManagedSigningKey> {
  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_SIGNING_KEY_MAX_AGE_MS;
  const now = options?.now ?? Date.now();

  const existing = await readStoredSigningKey(identityPath);
  if (!existing) {
    const created = createStoredSigningKey(now);
    await writeStoredSigningKey(identityPath, created);
    return toManagedSigningKey(created, false);
  }

  if (now - existing.createdAt < maxAgeMs) {
    return toManagedSigningKey(existing, false);
  }

  const rotated = createStoredSigningKey(now);
  await writeStoredSigningKey(identityPath, rotated);
  return toManagedSigningKey(rotated, true);
}

async function readStoredSigningKey(identityPath: string): Promise<StoredSigningKey | null> {
  try {
    const raw = await readFile(identityPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoredSigningKey>;
    if (parsed?.version !== 1 || !isHexPrivateKey(parsed.privateKey) || !Number.isFinite(parsed.createdAt)) {
      throw new Error(`Invalid signing identity at ${identityPath}`);
    }
    return {
      version: 1,
      privateKey: parsed.privateKey,
      createdAt: Number(parsed.createdAt),
    };
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function createStoredSigningKey(createdAt: number): StoredSigningKey {
  const wallet = Wallet.createRandom();
  return {
    version: 1,
    privateKey: wallet.privateKey as `0x${string}`,
    createdAt,
  };
}

async function writeStoredSigningKey(identityPath: string, key: StoredSigningKey): Promise<void> {
  await mkdir(path.dirname(identityPath), { recursive: true });
  await writeFile(identityPath, `${JSON.stringify(key, null, 2)}\n`, 'utf8');
  await chmod(identityPath, 0o600).catch(() => {});
}

function toManagedSigningKey(key: StoredSigningKey, rotated: boolean): ManagedSigningKey {
  return {
    privateKey: key.privateKey,
    address: new Wallet(key.privateKey).address as `0x${string}`,
    createdAt: key.createdAt,
    rotated,
  };
}

function isHexPrivateKey(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

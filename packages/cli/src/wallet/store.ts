import os from 'node:os';
import path from 'node:path';
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export interface StoredWallet {
  privateKey: `0x${string}`;
  address: `0x${string}`;
  createdAt: string;
  importedAt?: string;
}

export interface WalletStoreOptions {
  homeDir?: string;
  walletPath?: string;
  legacyWalletPath?: string;
  logger?: (message: string) => void;
}

export interface EnsureWalletResult {
  wallet: StoredWallet;
  created: boolean;
  migrated: boolean;
}

export function getWalletDir(homeDir = process.env.HOME ?? os.homedir()): string {
  return path.join(homeDir, '.clawmarket');
}

export function getWalletPath(homeDir = process.env.HOME ?? os.homedir()): string {
  return path.join(getWalletDir(homeDir), 'wallet.json');
}

export function getLegacySellerWalletPath(homeDir = process.env.HOME ?? os.homedir()): string {
  return path.join(getWalletDir(homeDir), 'seller-wallet.json');
}

export function isValidPrivateKey(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{64}$/.test(value.trim());
}

export async function readStoredWallet(filePath = getWalletPath()): Promise<StoredWallet> {
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
  const privateKey = String(parsed.privateKey ?? '').trim();
  if (!isValidPrivateKey(privateKey)) {
    throw new Error(`Wallet at ${filePath} does not contain a valid privateKey.`);
  }

  const address = typeof parsed.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(parsed.address)
    ? parsed.address as `0x${string}`
    : privateKeyToAccount(privateKey).address;

  return {
    privateKey,
    address,
    createdAt: typeof parsed.createdAt === 'string' && parsed.createdAt.trim()
      ? parsed.createdAt
      : new Date().toISOString(),
    importedAt: typeof parsed.importedAt === 'string' && parsed.importedAt.trim()
      ? parsed.importedAt
      : undefined,
  };
}

export async function saveStoredWallet(wallet: StoredWallet, filePath = getWalletPath()): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(wallet, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(filePath, 0o600);
}

export async function createStoredWallet(filePath = getWalletPath()): Promise<StoredWallet> {
  const privateKey = generatePrivateKey();
  const wallet: StoredWallet = {
    privateKey,
    address: privateKeyToAccount(privateKey).address,
    createdAt: new Date().toISOString(),
  };
  await saveStoredWallet(wallet, filePath);
  return wallet;
}

export async function migrateLegacyWallet(options: WalletStoreOptions = {}): Promise<boolean> {
  const walletPath = options.walletPath ?? getWalletPath(options.homeDir);
  const legacyWalletPath = options.legacyWalletPath ?? getLegacySellerWalletPath(options.homeDir);

  try {
    await readStoredWallet(walletPath);
    return false;
  } catch {
    // Fall through and check the legacy path.
  }

  let legacyWallet: StoredWallet;
  try {
    legacyWallet = await readStoredWallet(legacyWalletPath);
  } catch {
    return false;
  }

  await mkdir(path.dirname(walletPath), { recursive: true, mode: 0o700 });
  try {
    await rename(legacyWalletPath, walletPath);
  } catch {
    await saveStoredWallet(legacyWallet, walletPath);
  }
  await chmod(walletPath, 0o600);
  options.logger?.(`已将旧钱包迁移到 ${walletPath}`);
  return true;
}

export async function ensureStoredWallet(options: WalletStoreOptions = {}): Promise<EnsureWalletResult> {
  const walletPath = options.walletPath ?? getWalletPath(options.homeDir);
  const migrated = await migrateLegacyWallet({ ...options, walletPath });

  try {
    const wallet = await readStoredWallet(walletPath);
    return { wallet, created: false, migrated };
  } catch {
    const wallet = await createStoredWallet(walletPath);
    return { wallet, created: true, migrated };
  }
}

export async function backupWallet(filePath = getWalletPath()): Promise<string> {
  const backupPath = `${filePath}.bak`;
  await copyFile(filePath, backupPath);
  await chmod(backupPath, 0o600);
  return backupPath;
}

export async function importStoredWallet(
  privateKey: string,
  options: WalletStoreOptions & { backupExisting?: boolean } = {},
): Promise<{ wallet: StoredWallet; backupPath: string | null }> {
  const walletPath = options.walletPath ?? getWalletPath(options.homeDir);
  if (!isValidPrivateKey(privateKey)) {
    throw new Error('Private key must be a 0x-prefixed 32-byte hex string.');
  }

  let backupPath: string | null = null;
  try {
    await readStoredWallet(walletPath);
    if (options.backupExisting !== false) {
      backupPath = await backupWallet(walletPath);
    }
  } catch {
    backupPath = null;
  }

  const normalized = privateKey.trim() as `0x${string}`;
  const wallet: StoredWallet = {
    privateKey: normalized,
    address: privateKeyToAccount(normalized).address,
    createdAt: new Date().toISOString(),
    importedAt: new Date().toISOString(),
  };
  await saveStoredWallet(wallet, walletPath);
  return { wallet, backupPath };
}

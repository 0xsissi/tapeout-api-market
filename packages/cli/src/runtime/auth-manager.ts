import path from 'node:path';
import { mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises';

import type { SellerUpstream } from '../config/schema.js';
import { inspectAuthDir } from './auth-inspector.js';

export interface AuthBackup {
  path: string;
  upstream: SellerUpstream | null;
  identity: string | null;
  savedAt: string;
}

export async function backupAuthDir(authDir: string, upstream?: SellerUpstream): Promise<string | null> {
  if (!(await directoryHasAuthContents(authDir))) {
    return null;
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = upstream ? `${authDir}.bak-${upstream}-${ts}` : `${authDir}.bak-${ts}`;
  await rename(authDir, backupPath);
  await mkdir(authDir, { recursive: true });
  return backupPath;
}

export async function restoreAuthDir(authDir: string, backupPath: string): Promise<void> {
  await rm(authDir, { recursive: true, force: true });
  await rename(backupPath, authDir);
}

export async function clearAuthDir(authDir: string): Promise<void> {
  await rm(authDir, { recursive: true, force: true });
  await mkdir(authDir, { recursive: true });
}

export async function listAuthBackups(authDir: string): Promise<AuthBackup[]> {
  const parentDir = path.dirname(authDir);
  const baseName = path.basename(authDir);
  let entries;
  try {
    entries = await readdir(parentDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const backups: AuthBackup[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${baseName}.bak-`)) {
      continue;
    }

    const backupPath = path.join(parentDir, entry.name);
    const parsed = parseBackupName(baseName, entry.name);
    const inspection = await inspectAuthDir(backupPath);
    backups.push({
      path: backupPath,
      upstream: parsed.upstream ?? inspection.upstream,
      identity: inspection.identity,
      savedAt: parsed.savedAt,
    });
  }

  return backups.sort((left, right) => right.savedAt.localeCompare(left.savedAt));
}

export async function switchToBackup(args: {
  authDir: string;
  backupPath: string;
  currentUpstream?: SellerUpstream;
}): Promise<string | null> {
  const currentBackup = await backupAuthDir(args.authDir, args.currentUpstream);
  // backupAuthDir recreates an empty target; Windows cannot rename over it.
  await rmdir(args.authDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await rename(args.backupPath, args.authDir);
  return currentBackup;
}

export async function logoutCurrent(authDir: string): Promise<string | null> {
  if (!(await directoryHasAuthContents(authDir))) {
    await mkdir(authDir, { recursive: true });
    return null;
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logoutPath = `${authDir}.loggedout-${ts}`;
  await rename(authDir, logoutPath);
  await mkdir(authDir, { recursive: true });
  return logoutPath;
}

export async function deleteBackup(backupPath: string): Promise<void> {
  await rm(backupPath, { recursive: true, force: true });
}

export async function cleanupLoggedOutAuthDirs(authDir: string, olderThanMs = 7 * 24 * 60 * 60 * 1000): Promise<string[]> {
  const parentDir = path.dirname(authDir);
  const baseName = path.basename(authDir);
  let entries;
  try {
    entries = await readdir(parentDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const now = Date.now();
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${baseName}.loggedout-`)) {
      continue;
    }

    const loggedOutPath = path.join(parentDir, entry.name);
    const savedAt = parseLoggedOutSavedAt(baseName, entry.name);
    if (!savedAt || now - Date.parse(savedAt) < olderThanMs) {
      continue;
    }
    await rm(loggedOutPath, { recursive: true, force: true });
    removed.push(loggedOutPath);
  }
  return removed;
}

function parseBackupName(baseName: string, name: string): { upstream: SellerUpstream | null; savedAt: string } {
  const rest = name.slice(`${baseName}.bak-`.length);
  const match = /^(codex|claude|gemini)-(.+)$/.exec(rest);
  const rawSavedAt = match ? match[2]! : rest;
  return {
    upstream: match ? match[1] as SellerUpstream : null,
    savedAt: backupTimestampToIso(rawSavedAt),
  };
}

function parseLoggedOutSavedAt(baseName: string, name: string): string | null {
  const rest = name.slice(`${baseName}.loggedout-`.length);
  const parsed = Date.parse(backupTimestampToIso(rest));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function backupTimestampToIso(value: string): string {
  const restored = value.replace(
    /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/,
    '$1:$2:$3.$4',
  );
  const parsed = Date.parse(restored);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}

async function directoryHasAuthContents(dirPath: string): Promise<boolean> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      if (entry.isFile()) {
        return true;
      }
      if (entry.isDirectory() && await directoryHasAuthContents(path.join(dirPath, entry.name))) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

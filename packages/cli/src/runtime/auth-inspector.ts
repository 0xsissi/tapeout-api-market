import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';

import type { SellerUpstream } from '../config/schema.js';

export interface AuthInspection {
  path: string;
  upstream: SellerUpstream | null;
  identity: string | null;
  lastUsedAt: string | null;
  fileCount: number;
  hasAuth: boolean;
}

interface AuthFileInfo {
  filePath: string;
  fileName: string;
  parsed: Record<string, unknown> | null;
  mtimeMs: number;
}

export async function inspectAuthDir(dir: string): Promise<AuthInspection> {
  const files = await readAuthFiles(dir);
  const upstream = inferUpstream(files);
  const identity = inferIdentity(files);
  const lastUsedAt = files.length > 0
    ? new Date(Math.max(...files.map((file) => file.mtimeMs))).toISOString()
    : null;

  return {
    path: dir,
    upstream,
    identity,
    lastUsedAt,
    fileCount: files.length,
    hasAuth: files.length > 0,
  };
}

async function readAuthFiles(dir: string): Promise<AuthFileInfo[]> {
  const results: AuthFileInfo[] = [];

  async function visit(currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) {
        continue;
      }

      const parsed = await readJsonObject(entryPath);
      const info = await stat(entryPath);
      results.push({
        filePath: entryPath,
        fileName: entry.name,
        parsed,
        mtimeMs: info.mtimeMs,
      });
    }
  }

  await visit(dir);
  return results;
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function inferUpstream(files: AuthFileInfo[]): SellerUpstream | null {
  const votes = new Map<SellerUpstream, number>();
  for (const file of files) {
    const explicit = normalizeUpstream(readString(file.parsed, 'type') ?? readString(file.parsed, 'provider'));
    const byName = inferUpstreamFromName(file.fileName);
    const upstream = explicit ?? byName;
    if (upstream) {
      votes.set(upstream, (votes.get(upstream) ?? 0) + 1);
    }
  }

  return [...votes.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

function inferIdentity(files: AuthFileInfo[]): string | null {
  for (const file of files) {
    const explicit = [
      readString(file.parsed, 'email'),
      readString(file.parsed, 'account_email'),
      readString(file.parsed, 'account_id'),
      readString(file.parsed, 'organization_id'),
      readString(file.parsed, 'project_id'),
    ].find((value) => value && value.trim());
    if (explicit) {
      return explicit.trim();
    }
  }

  const named = files
    .map((file) => identityFromFileName(file.fileName))
    .find((value) => value && value.trim());
  return named?.trim() ?? null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function normalizeUpstream(value: string | null): SellerUpstream | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'claude' || normalized === 'gemini') {
    return normalized;
  }
  if (normalized === 'google') {
    return 'gemini';
  }
  if (normalized === 'anthropic') {
    return 'claude';
  }
  return null;
}

function inferUpstreamFromName(fileName: string): SellerUpstream | null {
  const normalized = fileName.toLowerCase();
  if (normalized.startsWith('codex-') || normalized.includes('codex')) {
    return 'codex';
  }
  if (normalized.startsWith('claude-') || normalized.includes('anthropic')) {
    return 'claude';
  }
  if (normalized.includes('gemini') || normalized.includes('google')) {
    return 'gemini';
  }
  return null;
}

function identityFromFileName(fileName: string): string | null {
  const base = fileName.replace(/\.json$/i, '');
  const withoutProvider = base.replace(/^(codex|claude|gemini)-/i, '');
  return withoutProvider || null;
}

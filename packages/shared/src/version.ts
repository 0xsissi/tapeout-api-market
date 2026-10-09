import type { ClientVersionPolicy } from './types/index.js';

export const UNKNOWN_CLIENT_VERSION = '0.0.0';

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

export function normalizeVersion(input: string | null | undefined): string {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) {
    return UNKNOWN_CLIENT_VERSION;
  }

  const withoutPrefix = trimmed.replace(/^v/i, '');
  const base = withoutPrefix.split(/[+-]/, 1)[0] ?? withoutPrefix;
  const parts = base.split('.');
  if (parts.length === 0) {
    return UNKNOWN_CLIENT_VERSION;
  }

  const numericParts = parts.slice(0, 3).map((part) => {
    const match = part.match(/^(\d+)/);
    return match?.[1] ?? '0';
  });
  while (numericParts.length < 3) {
    numericParts.push('0');
  }

  return numericParts.join('.');
}

export function compareVersion(a: string, b: string): -1 | 0 | 1 {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);
  if (!parsedA || !parsedB) {
    warnInvalidVersion(a, b);
    return 0;
  }

  if (parsedA.major !== parsedB.major) {
    return parsedA.major > parsedB.major ? 1 : -1;
  }
  if (parsedA.minor !== parsedB.minor) {
    return parsedA.minor > parsedB.minor ? 1 : -1;
  }
  if (parsedA.patch !== parsedB.patch) {
    return parsedA.patch > parsedB.patch ? 1 : -1;
  }
  return 0;
}

export function isClientVersionAllowed(
  clientVersion: string,
  policy: ClientVersionPolicy,
): { allowed: boolean; reason?: 'below_min' | 'banned' } {
  const normalizedClientVersion = normalizeVersion(clientVersion);
  const normalizedMinVersion = normalizeVersion(policy.minClientVersion);
  if (compareVersion(normalizedClientVersion, normalizedMinVersion) < 0) {
    return { allowed: false, reason: 'below_min' };
  }

  const bannedVersions = (policy.bannedVersions ?? []).map(normalizeVersion);
  if (bannedVersions.includes(normalizedClientVersion)) {
    return { allowed: false, reason: 'banned' };
  }

  return { allowed: true };
}

function parseVersion(input: string | null | undefined): ParsedVersion | null {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) {
    return null;
  }

  if (!/^v?\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?$/i.test(trimmed)) {
    return null;
  }

  const normalized = normalizeVersion(trimmed);
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    return null;
  }

  const [major, minor, patch] = normalized.split('.').map(Number);
  if (
    !Number.isInteger(major)
    || !Number.isInteger(minor)
    || !Number.isInteger(patch)
  ) {
    return null;
  }

  return { major, minor, patch };
}

function warnInvalidVersion(a: string, b: string): void {
  console.warn(
    `[client-version] Invalid version comparison input: ${JSON.stringify({ a, b })}`,
  );
}

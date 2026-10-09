import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { compareVersion } from '@clawmarket/shared';

import { CLI_VERSION } from './version.js';

const DEFAULT_FEED_URL = 'https://api.github.com/repos/0xsissi/tapeout-api-market/releases/latest';
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_CACHE_FILE_PATH = path.join(os.homedir(), '.clawmarket', 'update-cache.json');

interface ReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

interface ReleasePayload {
  tag_name?: string;
  body?: string;
  html_url?: string;
  assets?: ReleaseAsset[];
}

class MissingReleaseFeedError extends Error {
  constructor(status: number) {
    super(`GitHub releases feed returned HTTP ${status}`);
    this.name = 'MissingReleaseFeedError';
  }
}

interface CachedUpdateCheckResult {
  checkedAt: number;
  feedUrl: string;
  result: UpdateCheckResult;
}

export interface UpdateCheckResult {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  releaseUrl?: string;
  tarballUrl?: string;
  sha256?: string;
  releaseNotes?: string;
}

export async function checkForUpdate(options?: {
  feedUrl?: string;
  timeoutMs?: number;
  cacheFilePath?: string;
  cacheTTLMs?: number;
  skip?: boolean;
}): Promise<UpdateCheckResult> {
  const skip = options?.skip ?? process.env.CLAW_SKIP_UPDATE_CHECK === '1';
  const fallback: UpdateCheckResult = {
    current: CLI_VERSION,
    latest: null,
    hasUpdate: false,
  };
  if (skip) {
    return fallback;
  }

  const feedUrl = options?.feedUrl ?? process.env.CLAW_UPDATE_FEED_URL ?? DEFAULT_FEED_URL;
  if (!isAllowedUpdateUrl(feedUrl)) {
    console.warn(`[update-check] Rejected non-whitelisted feed URL: ${feedUrl}`);
    return fallback;
  }

  const cacheFilePath = options?.cacheFilePath ?? DEFAULT_CACHE_FILE_PATH;
  const cacheTTLMs = options?.cacheTTLMs ?? DEFAULT_CACHE_TTL_MS;
  const cached = await readCache(cacheFilePath);
  if (cached && cached.feedUrl === feedUrl && Date.now() - cached.checkedAt < cacheTTLMs) {
    return cached.result;
  }

  try {
    const release = await fetchReleasePayload(feedUrl, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const latestRelease = Array.isArray(release) ? release[0] : release;
    if (!latestRelease || typeof latestRelease !== 'object') {
      return fallback;
    }

    const latestVersion = normalizeTag(latestRelease.tag_name);
    if (!latestVersion) {
      return fallback;
    }

    const tarballAsset = selectTarballAsset(latestRelease.assets ?? []);
    const shaAsset = (latestRelease.assets ?? []).find((asset) => asset.name === 'SHA256SUMS');
    const tarballUrl = tarballAsset?.browser_download_url;
    const sha256 = tarballAsset?.name && shaAsset?.browser_download_url
      ? await fetchSha256(shaAsset.browser_download_url, tarballAsset.name, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      : undefined;

    const result: UpdateCheckResult = {
      current: CLI_VERSION,
      latest: latestVersion,
      hasUpdate: compareVersion(CLI_VERSION, latestVersion) < 0,
      ...(typeof latestRelease.html_url === 'string' ? { releaseUrl: latestRelease.html_url } : {}),
      ...(typeof tarballUrl === 'string' ? { tarballUrl } : {}),
      ...(typeof sha256 === 'string' ? { sha256 } : {}),
      ...(typeof latestRelease.body === 'string'
        ? { releaseNotes: latestRelease.body.trim().slice(0, 200) }
        : {}),
    };

    await writeCache(cacheFilePath, {
      checkedAt: Date.now(),
      feedUrl,
      result,
    });
    return result;
  } catch (error) {
    if (error instanceof MissingReleaseFeedError) {
      return cached?.result ?? fallback;
    }
    console.warn(`[update-check] Failed to check for updates: ${formatError(error)}`);
    return cached?.result ?? fallback;
  }
}

async function fetchReleasePayload(feedUrl: string, timeoutMs: number): Promise<ReleasePayload | ReleasePayload[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(feedUrl, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `tam/${CLI_VERSION}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 404) {
        throw new MissingReleaseFeedError(response.status);
      }
      throw new Error(`GitHub releases feed returned HTTP ${response.status}`);
    }
    return await response.json() as ReleasePayload | ReleasePayload[];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSha256(url: string, assetName: string, timeoutMs: number): Promise<string | undefined> {
  if (!isAllowedUpdateUrl(url)) {
    console.warn(`[update-check] Rejected non-whitelisted asset URL: ${url}`);
    return undefined;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'text/plain',
        'user-agent': `tam/${CLI_VERSION}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`SHA256SUMS returned HTTP ${response.status}`);
    }
    const text = await response.text();
    const line = text.split(/\r?\n/).find((entry) => entry.includes(assetName));
    const match = line?.match(/([a-f0-9]{64})/i);
    return match?.[1];
  } finally {
    clearTimeout(timer);
  }
}

function selectTarballAsset(assets: ReleaseAsset[]): ReleaseAsset | undefined {
  const platformAssetNames = getPreferredAssetNames();
  for (const name of platformAssetNames) {
    const match = assets.find((asset) => asset.name === name);
    if (match) {
      return match;
    }
  }

  return assets.find((asset) => {
    const name = asset.name ?? '';
    return (
      name.endsWith('.tar.gz')
      && name !== 'SHA256SUMS'
      && name !== 'install.sh'
    );
  });
}

function getPreferredAssetNames(): string[] {
  const arch = process.arch;
  const platform = process.platform;
  if (platform === 'darwin' && arch === 'arm64') {
    return ['tam-macos-arm64.tar.gz', `tam-v${CLI_VERSION}.tar.gz`, 'clawmarket-macos-arm64.tar.gz', `clawmarket-v${CLI_VERSION}.tar.gz`];
  }
  if (platform === 'darwin' && arch === 'x64') {
    return ['tam-macos-x64.tar.gz', `tam-v${CLI_VERSION}.tar.gz`, 'clawmarket-macos-x64.tar.gz', `clawmarket-v${CLI_VERSION}.tar.gz`];
  }
  if (platform === 'linux' && arch === 'arm64') {
    return ['tam-linux-arm64.tar.gz', `tam-v${CLI_VERSION}.tar.gz`, 'clawmarket-linux-arm64.tar.gz', `clawmarket-v${CLI_VERSION}.tar.gz`];
  }
  if (platform === 'linux' && arch === 'x64') {
    return ['tam-linux-x64.tar.gz', `tam-v${CLI_VERSION}.tar.gz`, 'clawmarket-linux-x64.tar.gz', `clawmarket-v${CLI_VERSION}.tar.gz`];
  }
  if (platform === 'win32' && arch === 'x64') {
    return ['tam-win-x64.zip', `tam-v${CLI_VERSION}.zip`, 'clawmarket-win-x64.zip', `clawmarket-v${CLI_VERSION}.zip`];
  }
  return [`tam-v${CLI_VERSION}.tar.gz`, `clawmarket-v${CLI_VERSION}.tar.gz`];
}

function normalizeTag(tagName: string | undefined): string | null {
  if (typeof tagName !== 'string' || !tagName.trim()) {
    return null;
  }
  return tagName.trim().replace(/^v/i, '');
}

function isAllowedUpdateUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      return false;
    }
    const host = url.hostname.toLowerCase();
    return (
      host === 'github.com'
      || host === 'api.github.com'
      || host.endsWith('.github.com')
      || host.endsWith('.githubusercontent.com')
    );
  } catch {
    return false;
  }
}

async function readCache(cacheFilePath: string): Promise<CachedUpdateCheckResult | null> {
  try {
    const raw = await readFile(cacheFilePath, 'utf8');
    const parsed = JSON.parse(raw) as CachedUpdateCheckResult;
    if (
      typeof parsed?.checkedAt !== 'number'
      || typeof parsed?.feedUrl !== 'string'
      || !parsed?.result
    ) {
      return null;
    }
    return parsed;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    console.warn(`[update-check] Ignoring invalid cache file ${cacheFilePath}: ${formatError(error)}`);
    return null;
  }
}

async function writeCache(cacheFilePath: string, payload: CachedUpdateCheckResult): Promise<void> {
  await mkdir(path.dirname(cacheFilePath), { recursive: true });
  await writeFile(cacheFilePath, JSON.stringify(payload, null, 2), 'utf8');
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

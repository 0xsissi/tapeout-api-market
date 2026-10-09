import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkForUpdate } from './update-check.js';
import { CLI_VERSION } from './version.js';

const originalFetch = globalThis.fetch;

describe('checkForUpdate', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    delete process.env.CLAW_SKIP_UPDATE_CHECK;
    delete process.env.CLAW_UPDATE_FEED_URL;
  });

  it('returns early when skipped', async () => {
    const result = await checkForUpdate({ skip: true });

    expect(result).toEqual({
      current: CLI_VERSION,
      latest: null,
      hasUpdate: false,
    });
  });

  it('uses a fresh cache entry without touching the network', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'update-check-cache-'));
    const cacheFilePath = path.join(dir, 'update-cache.json');
    writeFileSync(cacheFilePath, JSON.stringify({
      checkedAt: Date.now(),
      feedUrl: 'https://api.github.com/repos/0xsissi/tapeout-api-market/releases/latest',
      result: {
        current: CLI_VERSION,
        latest: '9.9.9',
        hasUpdate: true,
        releaseUrl: 'https://github.com/0xsissi/tapeout-api-market/releases/tag/v9.9.9',
      },
    }));
    globalThis.fetch = vi.fn();

    const result = await checkForUpdate({ cacheFilePath });

    expect(result).toMatchObject({ latest: '9.9.9', hasUpdate: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores a broken cache file and rebuilds it from the network', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'update-check-cache-'));
    const cacheFilePath = path.join(dir, 'update-cache.json');
    writeFileSync(cacheFilePath, '{');
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tag_name: 'v9.9.9',
        html_url: 'https://github.com/0xsissi/tapeout-api-market/releases/tag/v9.9.9',
        body: 'notes',
        assets: [],
      }), { status: 200 }));

    const result = await checkForUpdate({ cacheFilePath, cacheTTLMs: 1 });

    expect(result).toMatchObject({ latest: '9.9.9', hasUpdate: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses release metadata and SHA256SUMS when the network succeeds', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tag_name: 'v9.9.9',
        html_url: 'https://github.com/0xsissi/tapeout-api-market/releases/tag/v9.9.9',
        body: 'fixes',
        assets: [
          {
            name: 'clawmarket-linux-x64.tar.gz',
            browser_download_url: 'https://github.com/0xsissi/tapeout-api-market/releases/download/v9.9.9/clawmarket-linux-x64.tar.gz',
          },
          {
            name: 'SHA256SUMS',
            browser_download_url: 'https://github.com/0xsissi/tapeout-api-market/releases/download/v9.9.9/SHA256SUMS',
          },
        ],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  clawmarket-linux-x64.tar.gz\n',
        { status: 200 },
      ));

    const result = await checkForUpdate({
      feedUrl: 'https://api.github.com/repos/0xsissi/tapeout-api-market/releases/latest',
      cacheFilePath: path.join(mkdtempSync(path.join(os.tmpdir(), 'update-check-')), 'update-cache.json'),
    });

    expect(result).toMatchObject({
      latest: '9.9.9',
      hasUpdate: true,
      tarballUrl: 'https://github.com/0xsissi/tapeout-api-market/releases/download/v9.9.9/clawmarket-linux-x64.tar.gz',
    });
  });

  it('rejects non-whitelisted feed URLs without making a request', async () => {
    globalThis.fetch = vi.fn();

    const result = await checkForUpdate({
      feedUrl: 'http://not-github.example/releases/latest',
    });

    expect(result).toEqual({
      current: CLI_VERSION,
      latest: null,
      hasUpdate: false,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('checks the TAM repository and prefers a TAM archive over a legacy archive', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tam-update-check-'));
    const extension = process.platform === 'win32' && process.arch === 'x64' ? 'zip' : 'tar.gz';
    const archiveName = `tam-v${CLI_VERSION}.${extension}`;
    const archiveUrl = `https://github.com/0xsissi/tapeout-api-market/releases/download/v9.9.9/${archiveName}`;
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      tag_name: 'v9.9.9',
      assets: [
        { name: `clawmarket-v${CLI_VERSION}.${extension}`, browser_download_url: 'https://github.com/0xsissi/tapeout-api-market/releases/download/v9.9.9/legacy.tar.gz' },
        { name: archiveName, browser_download_url: archiveUrl },
      ],
    }), { status: 200 }));

    try {
      const result = await checkForUpdate({ cacheFilePath: path.join(directory, 'update-cache.json') });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/0xsissi/tapeout-api-market/releases/latest',
        expect.objectContaining({ headers: expect.objectContaining({ 'user-agent': `tam/${CLI_VERSION}` }) }),
      );
      expect(result.tarballUrl).toBe(archiveUrl);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('silently ignores a missing default releases feed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('not found', { status: 404 }));

    const result = await checkForUpdate({
      cacheFilePath: path.join(mkdtempSync(path.join(os.tmpdir(), 'update-check-')), 'update-cache.json'),
      cacheTTLMs: 1,
    });

    expect(result).toEqual({
      current: CLI_VERSION,
      latest: null,
      hasUpdate: false,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

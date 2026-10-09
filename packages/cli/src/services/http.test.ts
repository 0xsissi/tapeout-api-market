import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkEndpoint,
  ClientUpgradeRequiredError,
  fetchJson,
  fetchWithTimeout,
  getServiceStatus,
  postJson,
} from './http.js';

const originalFetch = globalThis.fetch;

describe('http services', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('labels a seller health failure correctly when BSC changes the status port', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const status = await getServiceStatus('http://127.0.0.1:9087/health', 'seller');
    expect(status.online).toBe(false);
    expect(status.message).toContain('seller 状态 API');
    expect(status.message).not.toContain('buyer gateway');
  });

  it('reads JSON payloads', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, value: 7 }), { status: 200 }),
    );

    await expect(fetchJson<{ ok: boolean; value: number }>('http://127.0.0.1/test')).resolves.toEqual({
      ok: true,
      value: 7,
    });
  });
  it('keeps the caller deadline active after response headers arrive', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('streaming body'));
    const deadline = new AbortController();
    await fetchWithTimeout('http://127.0.0.1/test', { signal: deadline.signal });
    const sentSignal = vi.mocked(globalThis.fetch).mock.calls[0][1]!.signal!;
    expect(sentSignal.aborted).toBe(false);
    deadline.abort();
    expect(sentSignal.aborted).toBe(true);
  });

  it('uses a longer timeout for JSON endpoints than health checks', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await fetchJson<{ ok: boolean }>('http://127.0.0.1/test');
    await getServiceStatus('http://127.0.0.1/health', 'buyer');

    const jsonSignal = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.signal as AbortSignal;
    const healthSignal = vi.mocked(globalThis.fetch).mock.calls[1]?.[1]?.signal as AbortSignal;
    expect(jsonSignal).not.toBe(healthSignal);
    expect(setTimeout).toBeDefined();
  });

  it('surfaces API error messages on POST', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'not enough credits' } }), { status: 400 }),
    );

    await expect(postJson('http://127.0.0.1/test', { amountUsd: 1 })).rejects.toThrow('not enough credits');
  });

  it('throws a dedicated upgrade error for 426 responses', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        error: {
          type: 'client_upgrade_required',
          message: '客户端版本过低，请升级到 v0.2.3。',
          minClientVersion: '0.2.2',
          recommendedVersion: '0.2.3',
          upgradeUrl: 'https://github.com/luoluo3310/clawmarket-releases/releases/latest',
          upgradeCommand: 'clawmarket self-update',
        },
      }), { status: 426 }),
    );

    await expect(postJson('http://127.0.0.1/test', { amountUsd: 1 })).rejects.toBeInstanceOf(
      ClientUpgradeRequiredError,
    );
  });

  it('reports endpoint health and service status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await expect(checkEndpoint('http://127.0.0.1/health')).resolves.toEqual({ ok: true, message: 'HTTP 200' });
    await expect(getServiceStatus('http://127.0.0.1/health', 'buyer')).resolves.toEqual({
      online: true,
      message: 'online',
    });
  });
});

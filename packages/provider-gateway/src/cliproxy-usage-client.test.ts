import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliproxyUsageClient } from './cliproxy-usage-client.js';

describe('CliproxyUsageClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('degrades to empty usage records when management endpoint is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('404 page not found', { status: 404 })));
    const client = new CliproxyUsageClient('http://127.0.0.1:4310');

    await expect(client.fetchRecentRecords(Date.now() - 1000)).resolves.toEqual([]);
  });

  it('degrades to empty usage records when management endpoint returns non-JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    const client = new CliproxyUsageClient('http://127.0.0.1:4310');

    await expect(client.fetchRecentRecords(Date.now() - 1000)).resolves.toEqual([]);
  });
});

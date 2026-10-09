import * as http from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, SchedulerConfigManager } from './config.js';
import { SchedulerAdminServer } from './admin-endpoint.js';
import { SchedulerLogger } from './logger.js';
import { SessionStickyTable } from './session-sticky.js';

describe('SchedulerAdminServer', () => {
  let server: SchedulerAdminServer | null = null;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    await server?.stop();
    vi.restoreAllMocks();
  });

  it('serves current config and supports kill switch toggles', async () => {
    const manager = new SchedulerConfigManager({ configFilePath: '/tmp/does-not-exist.json' });
    const logger = new SchedulerLogger(DEFAULT_CONFIG);
    const sticky = new SessionStickyTable({ capacity: 10, ttlMs: 10_000 });
    server = new SchedulerAdminServer(manager, logger, sticky, { port: 0 });
    await server.start();
    const baseUrl = server.url!;

    const configBefore = await fetch(`${baseUrl}/admin/scheduler/config`);
    expect(await configBefore.json()).toMatchObject({ mode: 'legacy' });

    const kill = await fetch(`${baseUrl}/admin/scheduler/kill`, { method: 'POST' });
    expect(await kill.json()).toMatchObject({ killSwitch: true });

    const revive = await fetch(`${baseUrl}/admin/scheduler/revive`, { method: 'POST' });
    expect(await revive.json()).toMatchObject({ killSwitch: false });
  });

  it('rejects non-local host headers', async () => {
    const manager = new SchedulerConfigManager({ configFilePath: '/tmp/does-not-exist.json' });
    const logger = new SchedulerLogger(DEFAULT_CONFIG);
    const sticky = new SessionStickyTable({ capacity: 10, ttlMs: 10_000 });
    server = new SchedulerAdminServer(manager, logger, sticky, { port: 0 });
    await server.start();
    const baseUrl = server.url!;

    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/admin/scheduler/config`,
        { headers: { Host: 'example.com' } },
        (res) => {
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(status).toBe(403);
  });

  it('returns recent logs, summary, sticky snapshot, and sticky stats', async () => {
    const manager = new SchedulerConfigManager({ configFilePath: '/tmp/does-not-exist.json' });
    const logger = new SchedulerLogger(DEFAULT_CONFIG);
    const sticky = new SessionStickyTable({ capacity: 10, ttlMs: 10_000 });
    sticky.set('abcdef1234567890', 'peer-a');
    sticky.get('abcdef1234567890');
    sticky.get('missing');
    logger
      .startRequest('req-1', 'gpt-test', '0.2.0')
      .setSelected('peer-a', 1, 'legacy', [])
      .setOutcome('success')
      .finalize();

    server = new SchedulerAdminServer(manager, logger, sticky, { port: 0 });
    await server.start();
    const baseUrl = server.url!;

    const logs = await fetch(`${baseUrl}/admin/scheduler/logs?limit=5`);
    expect(await logs.json()).toEqual([
      expect.objectContaining({
        requestId: 'req-1',
      }),
    ]);

    const summary = await fetch(`${baseUrl}/admin/scheduler/summary?windowMs=60000`);
    expect(await summary.json()).toMatchObject({
      total: 1,
      successRate: 1,
      clientVersions: {
        '0.2.0': 1,
      },
    });

    const stickyResponse = await fetch(`${baseUrl}/admin/scheduler/sticky`);
    expect(await stickyResponse.json()).toEqual([
      expect.objectContaining({
        keyHashPrefix: 'abcdef123456',
        peerId: 'peer-a',
      }),
    ]);

    const stickyStats = await fetch(`${baseUrl}/admin/scheduler/sticky/stats`);
    expect(await stickyStats.json()).toMatchObject({
      size: 1,
      lookups: 2,
      hits: 1,
      misses: 1,
      hitRate: 0.5,
    });
  });
});

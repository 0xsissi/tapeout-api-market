import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, SchedulerConfigManager } from './config.js';

describe('SchedulerConfigManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('loads the default safe config', () => {
    const manager = new SchedulerConfigManager({
      configFilePath: path.join(os.tmpdir(), 'missing-scheduler.json'),
    });

    expect(manager.get()).toEqual(DEFAULT_CONFIG);
  });

  it('applies environment overrides on top of defaults', () => {
    vi.stubEnv('CLAW_SCHEDULER_MODE', 'new');
    vi.stubEnv('CLAW_SCHEDULER_ROLLOUT_PCT', '25');
    const manager = new SchedulerConfigManager({
      configFilePath: path.join(os.tmpdir(), 'missing-scheduler.json'),
    });

    expect(manager.get()).toMatchObject({
      mode: 'new',
      rolloutPct: 25,
    });
  });

  it('lets the local file override environment values', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sched-'));
    const filePath = path.join(dir, 'scheduler.json');
    await writeFile(filePath, JSON.stringify({ rolloutPct: 50, enableSessionSticky: false }));
    vi.stubEnv('CLAW_SCHEDULER_ROLLOUT_PCT', '25');
    const manager = new SchedulerConfigManager({ configFilePath: filePath });

    expect(manager.get()).toMatchObject({
      rolloutPct: 50,
      enableSessionSticky: false,
    });
  });

  it('ignores a missing config file without throwing', () => {
    expect(
      () =>
        new SchedulerConfigManager({
          configFilePath: path.join(os.tmpdir(), 'does-not-exist.json'),
        }),
    ).not.toThrow();
  });

  it('keeps running when the config file contains invalid json', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sched-'));
    const filePath = path.join(dir, 'scheduler.json');
    await writeFile(filePath, '{"mode":"new"');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const manager = new SchedulerConfigManager({ configFilePath: filePath });

    expect(manager.get()).toEqual(DEFAULT_CONFIG);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('preserves kill switch regardless of rollout percentage', () => {
    vi.stubEnv('CLAW_SCHEDULER_KILL', 'true');
    vi.stubEnv('CLAW_SCHEDULER_ROLLOUT_PCT', '100');
    const manager = new SchedulerConfigManager({
      configFilePath: path.join(os.tmpdir(), 'missing-scheduler.json'),
    });

    expect(manager.get()).toMatchObject({
      killSwitch: true,
      rolloutPct: 100,
    });
  });

  it('detects file changes and notifies subscribers', async () => {
    vi.useRealTimers();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sched-'));
    const filePath = path.join(dir, 'scheduler.json');
    await writeFile(filePath, JSON.stringify({ rolloutPct: 0 }));
    const manager = new SchedulerConfigManager({ configFilePath: filePath, pollIntervalMs: 1_000 });
    const callback = vi.fn();
    manager.onChange(callback);
    manager.startWatching();

    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeFile(filePath, JSON.stringify({ rolloutPct: 25, mode: 'new' }));
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(manager.get()).toMatchObject({ rolloutPct: 25, mode: 'new' });
    expect(callback).toHaveBeenCalled();
    manager.stopWatching();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProtectionManager } from './protection.js';

describe('ProtectionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('acquires immediately until the concurrency limit is reached', async () => {
    const manager = new ProtectionManager({ maxConcurrent: 2 });

    await manager.acquire();
    await manager.acquire();

    expect(manager.currentConcurrent).toBe(2);
    expect(manager.isAvailable()).toBe(false);

    manager.destroy();
  });

  it('wakes the next waiter when a slot is released', async () => {
    const manager = new ProtectionManager({ maxConcurrent: 1 });

    await manager.acquire();

    let resolved = false;
    const waiting = manager.acquire().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    manager.release();
    await waiting;

    expect(resolved).toBe(true);
    expect(manager.currentConcurrent).toBe(1);

    manager.release();
    manager.destroy();
  });

  it('goes offline after consecutive failures and recovers after the cooldown', async () => {
    const manager = new ProtectionManager({
      maxConsecutiveErrors: 3,
      offlineDurationMs: 5_000,
    });

    manager.recordError();
    manager.recordError();
    expect(manager.isOffline).toBe(false);

    manager.recordError();
    expect(manager.isOffline).toBe(true);
    expect(manager.offlineRemainingSeconds).toBe(5);

    await expect(manager.acquire()).rejects.toThrow(/Node is offline/);

    vi.advanceTimersByTime(5_000);

    expect(manager.isAvailable()).toBe(true);
    expect(manager.isOffline).toBe(false);

    await manager.acquire();
    expect(manager.currentConcurrent).toBe(1);

    manager.release();
    manager.destroy();
  });

  it('rejects new work after the daily limit is reached', async () => {
    const manager = new ProtectionManager({ dailyLimitUsd: 10 });

    manager.addDailySpend(9.5);
    expect(manager.isAvailable()).toBe(true);

    manager.addDailySpend(0.5);
    expect(manager.dailySpendUsd).toBe(10);
    expect(manager.isAvailable()).toBe(false);

    await expect(manager.acquire()).rejects.toThrow('Daily spending limit exceeded');

    manager.destroy();
  });

  it('resets the consecutive error counter after a success', () => {
    const manager = new ProtectionManager({
      maxConsecutiveErrors: 2,
      offlineDurationMs: 5_000,
    });

    manager.recordError();
    manager.recordSuccess();
    manager.recordError();

    expect(manager.isOffline).toBe(false);

    manager.destroy();
  });

  it('can be forced offline until the safety interlock is cleared', async () => {
    const manager = new ProtectionManager({ maxConcurrent: 1 });

    manager.forceOffline('circuit_breaker');
    expect(manager.isAvailable()).toBe(false);
    expect(manager.isOffline).toBe(true);
    expect(manager.forcedOfflineReason).toBe('circuit_breaker');
    await expect(manager.acquire()).rejects.toThrow(/circuit_breaker/);

    manager.clearForcedOffline('circuit_breaker');
    expect(manager.isOffline).toBe(false);

    await manager.acquire();
    expect(manager.currentConcurrent).toBe(1);

    manager.release();
    manager.destroy();
  });

  it('automatically clears a timed forced-offline window after retry-after elapses', async () => {
    const manager = new ProtectionManager({ maxConcurrent: 1 });

    manager.forceOffline('upstream_quota', 5_000);
    expect(manager.isOffline).toBe(true);
    expect(manager.offlineRemainingSeconds).toBe(5);
    await expect(manager.acquire()).rejects.toThrow(/retry after 5s/);

    vi.advanceTimersByTime(5_000);

    expect(manager.isOffline).toBe(false);
    await manager.acquire();
    expect(manager.currentConcurrent).toBe(1);

    manager.release();
    manager.destroy();
  });
});

import { describe, expect, it, vi } from 'vitest';

import { QuotaWindowTracker, type AccountQuota } from './quota-window-tracker.js';
import { CliproxyUsageClient, type UsageRecord } from './cliproxy-usage-client.js';

describe('QuotaWindowTracker', () => {
  const quota: AccountQuota = {
    authIndex: 'auth-1',
    upstream: 'claude',
    credits: 45,
    windowMs: 5 * 3600_000,
    weeklyCredits: 100,
    weeklyWindowMs: 7 * 24 * 3600_000,
    modelWeights: {
      'claude-opus-4': 5,
      'claude-sonnet-4': 1,
    },
    defaultWeight: 1,
  };

  it('Opus burns 5x credits of Sonnet for same tokens', () => {
    const tracker = new QuotaWindowTracker({ fetchRecentRecords: async () => [] } as CliproxyUsageClient, [quota]);
    expect(tracker.creditsFor(quota, makeRecord('claude-opus-4', 1000))).toBe(5);
    expect(tracker.creditsFor(quota, makeRecord('claude-sonnet-4', 1000))).toBe(1);
    expect(
      tracker.creditsFor(quota, makeRecord('claude-opus-4', 1000))
      / tracker.creditsFor(quota, makeRecord('claude-sonnet-4', 1000)),
    ).toBeCloseTo(5.0, 2);
  });

  it('fresh header overrides local credit window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-22T00:00:00.000Z'));
    const tracker = new QuotaWindowTracker({ fetchRecentRecords: async () => [] } as CliproxyUsageClient, [quota]);
    tracker.ingestHeader({
      authIndex: 'auth-1',
      observedAt: Date.now(),
      tokensLimit: 100000,
      tokensRemaining: 10000,
    });

    expect(tracker.perAccount()).toEqual([
      { authIndex: 'auth-1', uPrimary: 0.9, uWeekly: 0, u: 0.9, source: 'header' },
    ]);
    vi.useRealTimers();
  });

  it('falls back to sliding windows and respects weekly max', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-22T10:00:00.000Z'));
    const now = Date.now();
    const client = {
      fetchRecentRecords: vi.fn(async () => [
        makeRecord('claude-sonnet-4', 20_000, now - 1_000),
        makeRecord('claude-sonnet-4', 20_000, now - 2_000),
        makeRecord('claude-opus-4', 10_000, now - quota.windowMs + 1_000),
      ]),
    } as unknown as CliproxyUsageClient;
    const tracker = new QuotaWindowTracker(client, [quota]);

    await tracker.poll();

    const account = tracker.perAccount()[0];
    expect(account?.source).toBe('window');
    expect(account?.uPrimary).toBeCloseTo(0.999, 3);
    expect(tracker.aggregateUtilization).toBeCloseTo(0.999, 3);
    vi.useRealTimers();
  });

  it('weekly window dominates when 5h is low but weekly is saturated', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-22T10:00:00.000Z'));
    const now = Date.now();
    const client = {
      fetchRecentRecords: vi.fn(async () => [
        makeRecord('claude-sonnet-4', 10_000, now - 1_000),
        makeRecord('claude-sonnet-4', 90_000, now - (6 * 3600_000)),
      ]),
    } as unknown as CliproxyUsageClient;
    const tracker = new QuotaWindowTracker(client, [quota]);

    await tracker.poll();

    expect(tracker.accountU(quota)).toBeGreaterThan(0.8);
    vi.useRealTimers();
  });

  it('can force an account to full utilization during a cooling window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-22T10:00:00.000Z'));
    const tracker = new QuotaWindowTracker({ fetchRecentRecords: async () => [] } as CliproxyUsageClient, [quota]);

    tracker.forceUtilization('auth-1', 0.999, 5_000, Date.now());

    expect(tracker.perAccount()).toEqual([
      { authIndex: 'auth-1', uPrimary: 0, uWeekly: 0, u: 0.999, source: 'forced' },
    ]);
    expect(tracker.aggregateUtilization).toBeCloseTo(0.999, 6);

    vi.advanceTimersByTime(5_000);
    expect(tracker.perAccount()).toEqual([
      { authIndex: 'auth-1', uPrimary: 0, uWeekly: 0, u: 0, source: 'window' },
    ]);
    vi.useRealTimers();
  });

  function makeRecord(model: string, totalTokens: number, timestamp = Date.now()): UsageRecord {
    return {
      timestamp,
      authIndex: 'auth-1',
      model,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens,
      failed: false,
    };
  }
});

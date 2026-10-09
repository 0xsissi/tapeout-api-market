import type { RateLimitSnapshot } from './upstream/ratelimit-header-parser.js';
import type { UsageRecord } from './cliproxy-usage-client.js';
import { CliproxyUsageClient } from './cliproxy-usage-client.js';

export interface AccountQuota {
  authIndex: string;
  upstream: 'claude' | 'codex' | 'gemini';
  credits: number;
  windowMs: number;
  weeklyCredits?: number;
  weeklyWindowMs?: number;
  modelWeights: Record<string, number>;
  defaultWeight: number;
}

export class QuotaWindowTracker {
  private readonly buffers = new Map<string, UsageRecord[]>();
  private readonly headerSnapshots = new Map<string, RateLimitSnapshot>();
  private readonly forcedUtilization = new Map<string, { value: number; until: number }>();
  private pollTimer: NodeJS.Timeout | null = null;
  private lastPollAt = Date.now();

  constructor(
    private readonly client: CliproxyUsageClient,
    private readonly quotas: AccountQuota[],
  ) {}

  ingestHeader(snapshot: RateLimitSnapshot): void {
    this.headerSnapshots.set(snapshot.authIndex, snapshot);
  }

  forceUtilization(authIndex: string, value: number, durationMs: number, now = Date.now()): void {
    this.forcedUtilization.set(authIndex, {
      value: Math.min(0.999, Math.max(0, value)),
      until: now + Math.max(0, durationMs),
    });
  }

  async start(pollIntervalMs = 10_000): Promise<void> {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.poll().catch((error) => {
        console.warn('[QuotaWindowTracker] poll failed', error);
      });
    }, pollIntervalMs);
    await this.poll();
  }

  stop(): void {
    if (!this.pollTimer) {
      return;
    }
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  creditsFor(quota: AccountQuota, record: UsageRecord): number {
    const weight = quota.modelWeights[record.model] ?? quota.defaultWeight;
    return (weight * record.totalTokens) / 1000;
  }

  async poll(): Promise<void> {
    const now = Date.now();
    const records = await this.client.fetchRecentRecords(this.lastPollAt - 1000);
    this.lastPollAt = now;

    for (const record of records) {
      const buffer = this.buffers.get(record.authIndex) ?? [];
      buffer.push(record);
      this.buffers.set(record.authIndex, buffer);
    }

    const maxWindow = Math.max(...this.quotas.map((quota) => quota.weeklyWindowMs ?? quota.windowMs), 0);
    for (const [authIndex, records] of this.buffers) {
      this.buffers.set(authIndex, records.filter((record) => record.timestamp >= now - maxWindow));
    }
  }

  accountU(quota: AccountQuota, now = Date.now()): number {
    this.pruneForcedUtilization(now);
    const forced = this.forcedUtilization.get(quota.authIndex);
    if (forced) {
      return forced.value;
    }
    return Math.max(this.primaryU(quota, now), this.weeklyU(quota, now));
  }

  get aggregateUtilization(): number {
    let used = 0;
    let capacity = 0;
    const now = Date.now();
    for (const quota of this.quotas) {
      used += this.accountU(quota, now) * quota.credits;
      capacity += quota.credits;
    }
    if (capacity <= 0) {
      return 0;
    }
    return Math.min(used / capacity, 0.999);
  }

  perAccount(): Array<{
    authIndex: string;
    uPrimary: number;
    uWeekly: number;
    u: number;
    source: 'header' | 'window' | 'forced';
  }> {
    const now = Date.now();
    return this.quotas.map((quota) => {
      this.pruneForcedUtilization(now);
      const forced = this.forcedUtilization.get(quota.authIndex);
      const snapshot = this.headerSnapshots.get(quota.authIndex);
      const source = forced
        ? 'forced'
        : snapshot && now - snapshot.observedAt < 60_000
          ? 'header'
          : 'window';
      const uPrimary = this.primaryU(quota, now);
      const uWeekly = this.weeklyU(quota, now);
      return {
        authIndex: quota.authIndex,
        uPrimary,
        uWeekly,
        u: forced ? forced.value : Math.max(uPrimary, uWeekly),
        source,
      };
    });
  }

  private primaryU(quota: AccountQuota, now: number): number {
    const snapshot = this.headerSnapshots.get(quota.authIndex);
    if (snapshot && now - snapshot.observedAt < 60_000) {
      if (snapshot.tokensLimit && snapshot.tokensRemaining != null) {
        return Math.min(1 - snapshot.tokensRemaining / snapshot.tokensLimit, 0.999);
      }
      if (snapshot.requestsLimit && snapshot.requestsRemaining != null) {
        return Math.min(1 - snapshot.requestsRemaining / snapshot.requestsLimit, 0.999);
      }
    }

    const relevant = (this.buffers.get(quota.authIndex) ?? []).filter((record) => {
      return record.timestamp >= now - quota.windowMs && !record.failed;
    });
    const usedCredits = relevant.reduce((sum, record) => sum + this.creditsFor(quota, record), 0);
    return quota.credits > 0 ? Math.min(usedCredits / quota.credits, 0.999) : 0;
  }

  private weeklyU(quota: AccountQuota, now: number): number {
    if (!quota.weeklyCredits || !quota.weeklyWindowMs) {
      return 0;
    }
    const relevant = (this.buffers.get(quota.authIndex) ?? []).filter((record) => {
      return record.timestamp >= now - quota.weeklyWindowMs! && !record.failed;
    });
    const usedCredits = relevant.reduce((sum, record) => sum + this.creditsFor(quota, record), 0);
    return Math.min(usedCredits / quota.weeklyCredits, 0.999);
  }

  private pruneForcedUtilization(now = Date.now()): void {
    for (const [authIndex, forced] of this.forcedUtilization) {
      if (forced.until <= now) {
        this.forcedUtilization.delete(authIndex);
      }
    }
  }
}

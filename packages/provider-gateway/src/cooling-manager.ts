export interface CoolingRecord {
  until: number;
  reason: string;
}

export class CoolingManager {
  private readonly cooling = new Map<string, CoolingRecord>();

  tripAccount(accountId: string, retryAfterSec: number, reason: string, now = Date.now()): void {
    const seconds = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 300;
    this.cooling.set(accountId, {
      until: now + seconds * 1000,
      reason,
    });
  }

  isAvailable(accountId: string, now = Date.now()): boolean {
    this.prune(now);
    return !this.cooling.has(accountId);
  }

  activeCount(now = Date.now()): number {
    this.prune(now);
    return this.cooling.size;
  }

  activeAccounts(now = Date.now()): string[] {
    this.prune(now);
    return Array.from(this.cooling.keys());
  }

  remainingSeconds(accountId: string, now = Date.now()): number {
    this.prune(now);
    const record = this.cooling.get(accountId);
    if (!record) {
      return 0;
    }
    return Math.max(0, Math.ceil((record.until - now) / 1000));
  }

  record(accountId: string, now = Date.now()): CoolingRecord | null {
    this.prune(now);
    return this.cooling.get(accountId) ?? null;
  }

  minRemainingSeconds(now = Date.now()): number {
    this.prune(now);
    let min = Number.POSITIVE_INFINITY;
    for (const record of this.cooling.values()) {
      min = Math.min(min, record.until - now);
    }
    if (!Number.isFinite(min)) {
      return 0;
    }
    return Math.max(0, Math.ceil(min / 1000));
  }

  prune(now = Date.now()): void {
    for (const [accountId, record] of this.cooling) {
      if (record.until <= now) {
        this.cooling.delete(accountId);
      }
    }
  }
}

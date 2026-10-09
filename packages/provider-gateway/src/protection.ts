/**
 * ProtectionManager — Concurrency control and auto-offline protection
 * Migrated from claw-market/seller-node.js protection logic
 *
 * Provides:
 * - Semaphore-based concurrency limiting
 * - Consecutive error tracking with auto-offline
 * - Daily USD spending limit with midnight reset
 */

export class ProtectionManager {
  /** Maximum concurrent requests allowed */
  readonly maxConcurrent: number;
  /** Current number of active requests */
  private _currentConcurrent = 0;
  /** Track consecutive errors */
  private _consecutiveErrors = 0;
  /** Max consecutive errors before auto-offline */
  private readonly maxConsecutiveErrors: number;
  /** Whether the node is manually/auto offlined */
  private _isOffline = false;
  /** Forced offline gate used by AIMM safety interlocks. */
  private _forcedOfflineReason: string | null = null;
  /** Optional expiry for forced-offline windows such as upstream quota cooldowns. */
  private _forcedOfflineUntil = 0;
  /** Timestamp when offline period ends (0 = not time-limited) */
  private _offlineUntil = 0;
  /** Duration to stay offline after error threshold (ms) */
  private readonly offlineDurationMs: number;

  /** Daily limit in USD */
  readonly dailyLimitUsd: number;
  /** Accumulated spend today in USD */
  private _dailySpendUsd = 0;
  private _reservedDailyBudgetUsd = 0;
  /** Midnight reset timer */
  private _resetTimer: ReturnType<typeof setTimeout> | null = null;

  /** Waiters blocked on acquire() */
  private _waitQueue: Array<() => void> = [];

  constructor(options?: {
    maxConcurrent?: number;
    maxConsecutiveErrors?: number;
    offlineDurationMs?: number;
    dailyLimitUsd?: number;
  }) {
    this.maxConcurrent = options?.maxConcurrent ?? 5;
    this.maxConsecutiveErrors = options?.maxConsecutiveErrors ?? 3;
    this.offlineDurationMs = options?.offlineDurationMs ?? 5 * 60 * 1000;
    this.dailyLimitUsd = options?.dailyLimitUsd ?? 400;
    this._scheduleMidnightReset();
  }

  /** Current number of in-flight requests */
  get currentConcurrent(): number {
    return this._currentConcurrent;
  }

  get queueDepth(): number {
    return this._waitQueue.length;
  }

  get loadHint(): number {
    if (this.maxConcurrent <= 0) {
      return 1;
    }
    return Math.min(1, this._currentConcurrent / this.maxConcurrent);
  }

  shouldSoftReject(threshold = 0.9): boolean {
    return this.loadHint > threshold;
  }

  /**
   * Check if this node can accept new requests.
   * Returns false if offline, at concurrency limit, or daily limit exceeded.
   */
  isAvailable(): boolean {
    this._refreshForcedOffline();
    if (this._forcedOfflineReason) {
      return false;
    }
    if (this._isOffline) {
      if (this._offlineUntil > 0 && Date.now() >= this._offlineUntil) {
        // Offline period expired, come back online
        this._isOffline = false;
        this._offlineUntil = 0;
        this._consecutiveErrors = 0;
      } else {
        return false;
      }
    }
    if (this._dailySpendUsd >= this.dailyLimitUsd) {
      return false;
    }
    return this._currentConcurrent < this.maxConcurrent;
  }

  /**
   * Acquire a concurrency slot. Resolves when a slot is available.
   * Throws if node is offline or daily limit exceeded.
   */
  async acquire(): Promise<void> {
    this._refreshForcedOffline();
    if (this._forcedOfflineReason) {
      const remainMs = this._forcedOfflineUntil > 0 ? this._forcedOfflineUntil - Date.now() : 0;
      throw new Error(
        `Node is offline (${this._forcedOfflineReason})${remainMs > 0 ? `, retry after ${Math.ceil(remainMs / 1000)}s` : ''}`,
      );
    }
    if (this._isOffline && (this._offlineUntil === 0 || Date.now() < this._offlineUntil)) {
      const remainMs = this._offlineUntil > 0 ? this._offlineUntil - Date.now() : 0;
      throw new Error(
        `Node is offline${remainMs > 0 ? `, retry after ${Math.ceil(remainMs / 1000)}s` : ''}`
      );
    }
    // Clear expired offline
    if (this._isOffline && this._offlineUntil > 0 && Date.now() >= this._offlineUntil) {
      this._isOffline = false;
      this._offlineUntil = 0;
      this._consecutiveErrors = 0;
    }
    if (this._dailySpendUsd >= this.dailyLimitUsd) {
      throw new Error('Daily spending limit exceeded');
    }

    if (this._currentConcurrent < this.maxConcurrent) {
      this._currentConcurrent++;
      return;
    }

    // Wait for a slot
    return new Promise<void>((resolve) => {
      this._waitQueue.push(() => {
        this._currentConcurrent++;
        resolve();
      });
    });
  }

  /**
   * Release a concurrency slot after request completes.
   */
  release(): void {
    this._currentConcurrent = Math.max(0, this._currentConcurrent - 1);
    // Wake up next waiter if any
    if (this._waitQueue.length > 0 && this._currentConcurrent < this.maxConcurrent) {
      const next = this._waitQueue.shift();
      next?.();
    }
  }

  /**
   * Record a successful request. Resets the consecutive error counter.
   */
  recordSuccess(): void {
    this._consecutiveErrors = 0;
  }

  /**
   * Record a failed request. If consecutive errors reach the threshold,
   * the node goes offline for offlineDurationMs.
   */
  recordError(): void {
    this._consecutiveErrors++;
    if (this._consecutiveErrors >= this.maxConsecutiveErrors) {
      this._isOffline = true;
      this._offlineUntil = Date.now() + this.offlineDurationMs;
      console.warn(
        `[Protection] Auto-offline triggered after ${this._consecutiveErrors} consecutive errors. ` +
        `Resuming in ${this.offlineDurationMs / 1000}s`
      );
    }
  }

  /**
   * Add to the daily spend tracker. Auto-offlines if limit exceeded.
   */
  addDailySpend(amountUsd: number): void {
    this._dailySpendUsd += amountUsd;
    if (this._dailySpendUsd >= this.dailyLimitUsd) {
      console.warn(
        `[Protection] Daily settlement-token limit reached: ${this._dailySpendUsd.toFixed(2)} / ${this.dailyLimitUsd}`
      );
    }
  }

  reserveDailyBudget(amountUsd: number): void {
    if (!Number.isFinite(amountUsd) || amountUsd < 0 || this._dailySpendUsd + this._reservedDailyBudgetUsd + amountUsd > this.dailyLimitUsd + 1e-12) {
      throw new Error('Daily spending budget exceeded');
    }
    this._reservedDailyBudgetUsd += amountUsd;
  }

  finishDailyBudget(reservedUsd: number, spentUsd: number): void {
    this._reservedDailyBudgetUsd = Math.max(0, this._reservedDailyBudgetUsd - reservedUsd);
    this.addDailySpend(spentUsd);
  }

  /** Current daily spend in USD */
  get dailySpendUsd(): number {
    return this._dailySpendUsd;
  }

  forceOffline(reason: string, durationMs = 0): void {
    this._forcedOfflineReason = reason;
    this._forcedOfflineUntil = durationMs > 0 ? Date.now() + durationMs : 0;
  }

  clearForcedOffline(reason?: string): void {
    if (!reason || this._forcedOfflineReason === reason) {
      this._forcedOfflineReason = null;
      this._forcedOfflineUntil = 0;
    }
  }

  get forcedOfflineReason(): string | null {
    return this._forcedOfflineReason;
  }

  /** Whether node is currently offline */
  get isOffline(): boolean {
    this._refreshForcedOffline();
    return this._isOffline || this._forcedOfflineReason != null;
  }

  /** Seconds remaining in offline period (0 if not offline or no time limit) */
  get offlineRemainingSeconds(): number {
    this._refreshForcedOffline();
    if (this._forcedOfflineReason && this._forcedOfflineUntil > 0) {
      return Math.max(0, Math.ceil((this._forcedOfflineUntil - Date.now()) / 1000));
    }
    if (!this._isOffline || this._offlineUntil === 0) return 0;
    return Math.max(0, Math.ceil((this._offlineUntil - Date.now()) / 1000));
  }

  /**
   * Schedule daily counter reset at next midnight (local time).
   */
  private _scheduleMidnightReset(): void {
    const now = new Date();
    const nextMidnight = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      0, 0, 0, 0
    );
    const msUntilMidnight = nextMidnight.getTime() - now.getTime();

    this._resetTimer = setTimeout(() => {
      this._dailySpendUsd = 0;
      console.log('[Protection] Daily spend counter reset at midnight');
      // Re-schedule for next midnight
      this._scheduleMidnightReset();
    }, msUntilMidnight);

    // Don't block process exit
    if (this._resetTimer.unref) {
      this._resetTimer.unref();
    }
  }

  /**
   * Clean up timers. Call on shutdown.
   */
  destroy(): void {
    if (this._resetTimer) {
      clearTimeout(this._resetTimer);
      this._resetTimer = null;
    }
  }

  private _refreshForcedOffline(now = Date.now()): void {
    if (this._forcedOfflineReason && this._forcedOfflineUntil > 0 && now >= this._forcedOfflineUntil) {
      this._forcedOfflineReason = null;
      this._forcedOfflineUntil = 0;
    }
  }
}

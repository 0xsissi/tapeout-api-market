export interface StickyEntry {
  peerId: string;
  createdAt: number;
  lastUsedAt: number;
  hitCount: number;
  consecutiveFailures: number;
  lastFailureAt?: number;
}

export interface StickyStats {
  size: number;
  capacity: number;
  ttlMs: number;
  lookups: number;
  hits: number;
  misses: number;
  hitRate: number;
  inserts: number;
  evictions: number;
  expirations: number;
  evictionRate: number;
}

export class SessionStickyTable {
  private readonly entries = new Map<string, StickyEntry>();
  private config: { capacity: number; ttlMs: number };
  private lookups = 0;
  private hits = 0;
  private misses = 0;
  private inserts = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(config: { capacity: number; ttlMs: number }) {
    this.config = { ...config };
  }

  get size(): number {
    return this.entries.size;
  }

  get(keyHash: string): StickyEntry | null {
    this.lookups += 1;
    const entry = this.entries.get(keyHash);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    if (Date.now() - entry.lastUsedAt > this.config.ttlMs) {
      this.entries.delete(keyHash);
      this.misses += 1;
      this.expirations += 1;
      return null;
    }

    this.hits += 1;
    entry.lastUsedAt = Date.now();
    entry.hitCount += 1;
    this.entries.delete(keyHash);
    this.entries.set(keyHash, entry);
    return { ...entry };
  }

  set(keyHash: string, peerId: string): void {
    const now = Date.now();
    const existing = this.entries.get(keyHash);
    const next: StickyEntry = existing
      ? {
          ...existing,
          peerId,
          lastUsedAt: now,
        }
      : {
          peerId,
          createdAt: now,
          lastUsedAt: now,
          hitCount: 0,
          consecutiveFailures: 0,
        };

    if (!existing) {
      this.inserts += 1;
    }
    this.entries.delete(keyHash);
    this.entries.set(keyHash, next);
    this.evictIfNeeded();
  }

  markFailure(keyHash: string): void {
    const entry = this.entries.get(keyHash);
    if (!entry) {
      return;
    }
    entry.consecutiveFailures += 1;
    entry.lastFailureAt = Date.now();
  }

  markSuccess(keyHash: string): void {
    const entry = this.entries.get(keyHash);
    if (!entry) {
      return;
    }
    entry.consecutiveFailures = 0;
    entry.lastFailureAt = undefined;
  }

  delete(keyHash: string): void {
    this.entries.delete(keyHash);
  }

  snapshot(): Array<{ keyHashPrefix: string; peerId: string; hitCount: number; ageMs: number }> {
    const now = Date.now();
    return Array.from(this.entries.entries()).map(([keyHash, entry]) => ({
      keyHashPrefix: keyHash.slice(0, 12),
      peerId: entry.peerId,
      hitCount: entry.hitCount,
      ageMs: now - entry.createdAt,
    }));
  }

  stats(): StickyStats {
    const evictionBase = this.inserts + this.expirations;
    return {
      size: this.entries.size,
      capacity: this.config.capacity,
      ttlMs: this.config.ttlMs,
      lookups: this.lookups,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.lookups > 0 ? this.hits / this.lookups : 0,
      inserts: this.inserts,
      evictions: this.evictions,
      expirations: this.expirations,
      evictionRate: evictionBase > 0 ? this.evictions / evictionBase : 0,
    };
  }

  updateConfig(config: Partial<{ capacity: number; ttlMs: number }>): void {
    this.config = {
      capacity: config.capacity ?? this.config.capacity,
      ttlMs: config.ttlMs ?? this.config.ttlMs,
    };
    this.pruneExpired();
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.config.capacity) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) {
        return;
      }
      this.entries.delete(oldestKey);
      this.evictions += 1;
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [keyHash, entry] of this.entries) {
      if (now - entry.lastUsedAt > this.config.ttlMs) {
        this.entries.delete(keyHash);
        this.expirations += 1;
      }
    }
  }
}

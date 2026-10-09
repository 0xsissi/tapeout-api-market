import { isQuoteExpired, isQuoteTooFarInFuture, verifyQuote, type QuoteMessage } from '@clawmarket/shared';

interface CacheEntry {
  quote: QuoteMessage;
  receivedAt: number;
  seenNonces: string[];
}

export class LocalQuoteCache {
  private readonly cache = new Map<string, Map<string, CacheEntry>>();
  private gcTimer: NodeJS.Timeout | null = null;
  private lastSeenAt: number | null = null;

  start(): void {
    if (this.gcTimer) {
      return;
    }
    this.gcTimer = setInterval(() => this.cleanup(), 2_000);
  }

  stop(): void {
    if (!this.gcTimer) {
      return;
    }
    clearInterval(this.gcTimer);
    this.gcTimer = null;
  }

  accept(quote: QuoteMessage): 'new' | 'update' | 'duplicate' | 'stale' | 'expired' | 'invalid' {
    if (!verifyQuote(quote, quote.makerAddress)) {
      console.warn(`[QuoteCache] invalid signature from ${quote.makerId}`);
      return 'invalid';
    }

    if (isQuoteTooFarInFuture(quote)) {
      return 'invalid';
    }
    this.lastSeenAt = Date.now();
    if (isQuoteExpired(quote)) {
      return 'expired';
    }

    const modelCache = this.cache.get(quote.model) ?? new Map<string, CacheEntry>();
    const existing = modelCache.get(quote.makerId);
    if (existing && existing.quote.timestamp > quote.timestamp) {
      return 'stale';
    }
    if (existing && existing.seenNonces.includes(quote.nonce)) {
      return 'duplicate';
    }

    const seenNonces = existing
      ? [...existing.seenNonces, quote.nonce].slice(-32)
      : [quote.nonce];

    modelCache.set(quote.makerId, { quote, receivedAt: Date.now(), seenNonces });
    this.cache.set(quote.model, modelCache);
    return existing ? 'update' : 'new';
  }

  insert(quote: QuoteMessage): void {
    this.accept(quote);
  }

  active(model: string): QuoteMessage[] {
    const modelCache = this.cache.get(model);
    if (!modelCache) {
      return [];
    }

    const now = Date.now();
    const result: QuoteMessage[] = [];
    for (const entry of modelCache.values()) {
      if (!isQuoteExpired(entry.quote, now)) {
        result.push(entry.quote);
      }
    }
    return result;
  }

  depth(model: string, priceCeiling: number): number {
    return this.active(model)
      .filter((quote) => quote.currentPrice <= priceCeiling)
      .reduce((sum, quote) => sum + quote.maxConcurrent * (1 - quote.utilization), 0);
  }

  size(now = Date.now()): number {
    let total = 0;
    for (const modelCache of this.cache.values()) {
      for (const entry of modelCache.values()) {
        if (!isQuoteExpired(entry.quote, now)) {
          total += 1;
        }
      }
    }
    return total;
  }

  getLastSeenAt(): number | null {
    return this.lastSeenAt;
  }

  cleanup(now = Date.now()): void {
    for (const [model, modelCache] of this.cache) {
      for (const [makerId, entry] of modelCache) {
        if (isQuoteExpired(entry.quote, now)) {
          modelCache.delete(makerId);
        }
      }
      if (modelCache.size === 0) {
        this.cache.delete(model);
      }
    }
  }
}

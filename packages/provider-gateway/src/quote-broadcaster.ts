import {
  buildQuoteTopic,
  cucPrice,
  resolveModelAlpha,
  resolveModelBasePrice,
  signQuote,
  type ModelPricing,
  type QuoteMessage,
  type QuoteSignerDelegation,
} from '@clawmarket/shared';

interface QuotePublishTarget {
  publish(topic: string, message: Uint8Array): Promise<void>;
}

interface QuoteBroadcasterConfig {
  makerId: string;
  makerAddress: `0x${string}`;
  privateKey: `0x${string}`;
  signingPrivateKey?: `0x${string}`;
  signingDelegation?: QuoteSignerDelegation;
  models: ModelPricing[];
  maxConcurrent: number;
  intervalMs?: number;
  minIntervalMs?: number;
  ttlMs?: number;
  networkId?: string;
  getUtilization: () => number;
  getRecentLatencyMs?: () => number;
  getRecentSuccessRate?: () => number;
}

export class QuoteBroadcaster {
  private timer: NodeJS.Timeout | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly minIntervalMs: number;
  private readonly ttlMs: number;
  private lastBroadcastAt = 0;
  private nonceCounter = 0n;
  private broadcastCount = 0;

  constructor(
    private readonly p2p: QuotePublishTarget,
    private readonly config: QuoteBroadcasterConfig,
  ) {
    this.intervalMs = config.intervalMs ?? 10_000;
    this.minIntervalMs = config.minIntervalMs ?? 2_000;
    this.ttlMs = config.ttlMs ?? 10_000;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.requestBroadcast();
    this.timer = setInterval(() => {
      this.requestBroadcast();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  requestBroadcast(): void {
    if (this.pendingTimer) {
      return;
    }

    const waitMs = Math.max(0, this.minIntervalMs - (Date.now() - this.lastBroadcastAt));
    if (waitMs === 0) {
      void this.broadcast().catch((error) => {
        console.warn('[QuoteBroadcaster] initial broadcast failed', error);
      });
      return;
    }

    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      void this.broadcast().catch((error) => {
        console.warn('[QuoteBroadcaster] scheduled broadcast failed', error);
      });
    }, waitMs);
  }

  async broadcast(): Promise<QuoteMessage[]> {
    this.lastBroadcastAt = Date.now();
    const quotes = this.previewQuotes();
    await Promise.all(quotes.map(async (quote) => {
      const topic = buildQuoteTopic(quote.model, this.config.networkId);
      const payload = new TextEncoder().encode(JSON.stringify(quote));
      await this.p2p.publish(topic, payload);
    }));
    this.broadcastCount += quotes.length;

    return quotes;
  }

  get totalBroadcasts(): number {
    return this.broadcastCount;
  }

  previewQuotes(): QuoteMessage[] {
    const utilization = this.config.getUtilization();
    const recentLatencyMs = this.config.getRecentLatencyMs?.() ?? 0;
    const successRate = this.config.getRecentSuccessRate?.() ?? 1;

    return this.config.models.map((pricing) =>
      this.buildQuote(pricing, utilization, recentLatencyMs, successRate),
    );
  }

  previewQuote(model: string): QuoteMessage | null {
    return this.previewQuotes().find((quote) => quote.model === model) ?? null;
  }

  private buildQuote(
    pricing: ModelPricing,
    utilization: number,
    recentLatencyMs: number,
    successRate: number,
  ): QuoteMessage {
    const p0 = resolveModelBasePrice(pricing);
    const alpha = resolveModelAlpha(pricing);

    return signQuote({
      makerId: this.config.makerId,
      makerAddress: this.config.makerAddress,
      nonce: this.nextNonce(),
      model: pricing.model,
      p0,
      alpha,
      utilization,
      maxConcurrent: this.config.maxConcurrent,
      currentPrice: Math.min(cucPrice(p0, utilization, alpha), pricing.quotePriceCeiling ?? Infinity),
      recentLatencyMs,
      successRate,
      timestamp: Date.now(),
      ttlMs: this.ttlMs,
      schemaVersion: 1,
    }, this.config.signingPrivateKey ?? this.config.privateKey, {
      signingDelegation: this.config.signingDelegation,
    });
  }

  private nextNonce(): string {
    this.nonceCounter += 1n;
    return this.nonceCounter.toString(16).padStart(16, '0');
  }
}

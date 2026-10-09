import { buildQuoteTopic, type QuoteMessage } from '@clawmarket/shared';
import type { ClawMarketNode } from '@clawmarket/p2p-node';

import { LocalQuoteCache } from './quote-cache.js';

interface QuoteSubscriberOptions {
  watchdogIntervalMs?: number;
  staleAfterMs?: number;
}

export class QuoteSubscriber {
  private readonly unsubscribers: Array<() => void> = [];
  private readonly watchdogIntervalMs: number;
  private readonly staleAfterMs: number;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private startedAt: number | null = null;
  private lastResubscribeAt: number | null = null;
  private restartPromise: Promise<void> | null = null;

  constructor(
    private readonly p2p: ClawMarketNode,
    private readonly cache: LocalQuoteCache,
    private readonly interestedModels: string[],
    private readonly networkId?: string,
    options?: QuoteSubscriberOptions,
  ) {
    this.watchdogIntervalMs = options?.watchdogIntervalMs ?? 15_000;
    this.staleAfterMs = options?.staleAfterMs ?? 30_000;
  }

  async start(): Promise<void> {
    if (this.unsubscribers.length > 0) {
      return;
    }
    this.startedAt ??= Date.now();
    for (const model of this.interestedModels) {
      const topic = buildQuoteTopic(model, this.networkId);
      const unsubscribe = await this.p2p.subscribe(topic, (rawMessage) => {
        try {
          const quote = JSON.parse(new TextDecoder().decode(rawMessage)) as QuoteMessage;
          this.cache.insert(quote);
        } catch (error) {
          console.warn('[QuoteSubscriber] bad message', error);
        }
      });
      this.unsubscribers.push(unsubscribe);
    }
    this.startWatchdog();
  }

  async stop(): Promise<void> {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    const pending = [...this.unsubscribers];
    this.unsubscribers.length = 0;
    for (const unsubscribe of pending) {
      await unsubscribe();
    }
  }

  private startWatchdog(): void {
    if (this.watchdogTimer || this.interestedModels.length === 0) {
      return;
    }
    this.watchdogTimer = setInterval(() => {
      void this.maybeResubscribe();
    }, this.watchdogIntervalMs);
  }

  private async maybeResubscribe(): Promise<void> {
    if (this.restartPromise) {
      await this.restartPromise;
      return;
    }
    const now = Date.now();
    const lastSeenAt = this.cache.getLastSeenAt() ?? this.startedAt ?? now;
    const emptyCache = this.cache.size(now) === 0;
    const hasConnections = this.p2p.libp2p.getConnections().length > 0;
    const stale = now - lastSeenAt >= this.staleAfterMs;
    const recentlyRestarted = this.lastResubscribeAt != null && now - this.lastResubscribeAt < this.staleAfterMs;

    if (!emptyCache || !hasConnections || !stale || recentlyRestarted) {
      return;
    }

    console.warn(
      `[QuoteSubscriber] quote cache empty for ${now - lastSeenAt}ms; restarting quote subscriptions for ${this.interestedModels.join(', ')}`,
    );
    this.lastResubscribeAt = now;
    const restart = (async () => {
      await this.stop();
      await this.start();
    })();
    this.restartPromise = restart;
    try {
      await restart;
    } finally {
      if (this.restartPromise === restart) {
        this.restartPromise = null;
      }
    }
  }
}

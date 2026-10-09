/**
 * P2P Router — Local caching wrapper around ConsumerRouter from @clawmarket/p2p-node.
 * Adds failure tracking, automatic fallback, and a local provider cache
 * that refreshes every 60 seconds.
 */

import { createHash } from 'node:crypto';
import os from 'node:os';

import type { ConsumerRouter } from '@clawmarket/p2p-node';
import type { ProviderAnnouncement, ModelPricing } from '@clawmarket/shared';
import { matchesPaymentNetwork } from '@clawmarket/shared';

/** A provider scored by the underlying ConsumerRouter. */
export interface ScoredProvider {
  announcement: ProviderAnnouncement;
  modelPricing: ModelPricing;
  score: number;
}

/** Failure entry for a peer. */
interface FailureRecord {
  count: number;
  lastFailure: number;
}

interface ModelCooldownRecord {
  reason: string;
  unavailableUntil: number;
}

interface PeerCooldownRecord {
  reason: string;
  unavailableUntil: number;
}

export interface ProviderObservation {
  peerId: string;
  loadHint?: number;
  inflight?: number;
  queueDepth?: number;
  retryAfterSeconds?: number;
  observedLatencyMs?: number;
  lastUpdatedAt: number;
}

const CACHE_TTL_MS = 60_000;
const CACHE_TTL_JITTER_MS = 15_000;
const FAILURE_COOLDOWN_MS = 120_000; // 2 minutes
const MAX_FAILURES = 3; // exclude after this many consecutive failures
const PROVIDER_OBSERVATION_TTL_MS = 120_000;
const PEER_DIAL_COOLDOWN_MS = 90_000;

/**
 * Wraps ConsumerRouter with local caching, failure tracking, and fallback selection.
 */
export class P2PRouter {
  private consumerRouter: ConsumerRouter;
  private providerCache: Map<string, { providers: ScoredProvider[]; fetchedAt: number; ttlMs: number }> =
    new Map();
  private failures: Map<string, FailureRecord> = new Map();
  private modelCooldowns: Map<string, ModelCooldownRecord> = new Map();
  private peerCooldowns: Map<string, PeerCooldownRecord> = new Map();
  private providerObservations: Map<string, ProviderObservation> = new Map();
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly cacheJitterSeed: string;

  constructor(consumerRouter: ConsumerRouter, opts?: { cacheJitterSeed?: string }) {
    this.consumerRouter = consumerRouter;
    this.cacheJitterSeed = opts?.cacheJitterSeed ?? deriveCacheJitterSeed(consumerRouter);
  }

  /**
   * Find all available providers for a model, using local cache when fresh.
   * @param model - The model identifier (e.g. "claude-3-opus").
   * @returns Scored provider list, sorted best-first.
   */
  async findProviders(model: string): Promise<ScoredProvider[]> {
    const cached = this.providerCache.get(model);
    if (cached && Date.now() - cached.fetchedAt < cached.ttlMs) {
      return this.filterExcluded(model, cached.providers);
    }

    try {
      const providers = (await this.consumerRouter.findProviders(model)) as ScoredProvider[];
      this.rememberProviders(model, providers);
      return this.filterExcluded(model, providers);
    } catch (err) {
      console.error(`[ConsumerGateway] P2PRouter: findProviders failed for ${model}:`, err);
      // Fall back to stale cache if available
      if (cached) {
        console.warn('[ConsumerGateway] P2PRouter: using stale cache');
        return this.filterExcluded(model, cached.providers);
      }
      return [];
    }
  }

  /**
   * List visible models from known providers and optional discovery hints.
   */
  async listModels(modelHints: string[] = []): Promise<string[]> {
    const models = new Set(modelHints.map((item) => item.trim()).filter(Boolean));

    for (const [model, cacheEntry] of this.providerCache) {
      if (cacheEntry.providers.length > 0) {
        models.add(model);
      }
    }

    try {
      const discovered = await this.consumerRouter.listModels(Array.from(models));
      for (const model of discovered) {
        models.add(model);
      }
    } catch (err) {
      console.error('[ConsumerGateway] P2PRouter: listModels failed:', err);
    }

    return Array.from(models).sort((left, right) => left.localeCompare(right));
  }

  /**
   * Return models known from the local cache without doing DHT/network lookups.
   * This is intended for status endpoints where stale-but-fast is better than
   * blocking the TUI on multi-model discovery.
   */
  listCachedModels(modelHints: string[] = []): string[] {
    const models = new Set(modelHints.map((item) => item.trim()).filter(Boolean));
    for (const [model, cacheEntry] of this.providerCache) {
      if (cacheEntry.providers.length > 0) {
        models.add(model);
      }
      for (const provider of cacheEntry.providers) {
        for (const pricing of provider.announcement.models) {
          if (pricing.model?.trim()) {
            models.add(pricing.model.trim());
          }
        }
      }
    }
    return Array.from(models).sort((left, right) => left.localeCompare(right));
  }

  /**
   * Return cached providers for a model without triggering DHT discovery.
   */
  getCachedProviders(model: string): ScoredProvider[] {
    const byPeer = new Map<string, ScoredProvider>();
    const direct = this.providerCache.get(model);
    if (direct) {
      for (const provider of direct.providers) {
        byPeer.set(provider.announcement.peerId, provider);
      }
    }

    for (const cacheEntry of this.providerCache.values()) {
      for (const provider of cacheEntry.providers) {
        const pricing = provider.announcement.models.find((item) => item.model === model);
        if (!pricing) {
          continue;
        }
        byPeer.set(provider.announcement.peerId, {
          announcement: provider.announcement,
          modelPricing: pricing,
          score: provider.score,
        });
      }
    }

    return this.filterExcluded(model, Array.from(byPeer.values()).sort((left, right) => right.score - left.score));
  }

  /**
   * Select the best provider for a model with automatic fallback.
   * If the top provider is excluded due to failures, the next best is returned.
   * @param model - The model identifier.
   * @returns The best available provider or null.
   */
  async selectBest(model: string): Promise<ScoredProvider | null> {
    const providers = await this.findProviders(model);
    if (providers.length === 0) {
      console.warn(`[ConsumerGateway] P2PRouter: no providers available for ${model}`);
      return null;
    }
    return providers[0] ?? null;
  }

  /**
   * Select the best provider for a model excluding peers already tried for the same request.
   * @param model - The model identifier.
   * @param excludedPeerIds - Peer IDs to skip for this selection.
   * @returns The best available non-excluded provider or null.
   */
  async selectBestExcluding(
    model: string,
    excludedPeerIds: Set<string>,
  ): Promise<ScoredProvider | null> {
    const providers = mergeProviders(
      await this.findProviders(model),
      this.getCachedProviders(model),
    );
    return (
      providers.find((provider) => !excludedPeerIds.has(provider.announcement.peerId)) ?? null
    );
  }

  async selectTopN(
    model: string,
    n: number,
    excludedPeerIds?: Set<string>,
  ): Promise<ScoredProvider[]> {
    const providers = await this.findProviders(model);
    const filtered = excludedPeerIds
      ? providers.filter((provider) => !excludedPeerIds.has(provider.announcement.peerId))
      : providers;
    return filtered.slice(0, Math.max(0, n));
  }

  async isProviderAvailable(model: string, peerId: string): Promise<boolean> {
    const providers = await this.findProviders(model);
    return providers.some((provider) => provider.announcement.peerId === peerId);
  }

  /**
   * Mark a provider as having failed a request.
   * After MAX_FAILURES consecutive failures, the provider is temporarily excluded.
   * @param peerId - The peer ID of the failed provider.
   */
  markFailed(peerId: string): void {
    const existing = this.failures.get(peerId);
    if (existing) {
      existing.count++;
      existing.lastFailure = Date.now();
    } else {
      this.failures.set(peerId, { count: 1, lastFailure: Date.now() });
    }
    const count = this.failures.get(peerId)!.count;
    console.warn(
      `[ConsumerGateway] P2PRouter: marked ${peerId} as failed (${count}/${MAX_FAILURES})`,
    );
  }

  /**
   * Reset the failure counter for a provider (e.g. after a successful request).
   * @param peerId - The peer ID.
   */
  markSuccess(peerId: string): void {
    this.failures.delete(peerId);
    this.peerCooldowns.delete(peerId);
  }

  markPeerReachable(peerId: string): void {
    this.peerCooldowns.delete(peerId);
  }

  markPeerUnreachable(peerId: string, cooldownMs: number = PEER_DIAL_COOLDOWN_MS, reason = 'dial_failed'): void {
    this.peerCooldowns.set(peerId, {
      reason,
      unavailableUntil: Date.now() + Math.max(1_000, cooldownMs),
    });
  }

  markDegraded(peerId: string, multiplier: number, durationMs: number): void {
    this.observeProvider(peerId, {
      loadHint: clampNumber(multiplier, 0, 1),
      retryAfterSeconds: Math.max(1, Math.ceil(durationMs / 1000)),
    });
  }

  markTemporarilyUnavailable(
    peerId: string,
    model: string,
    cooldownMs: number,
    reason: string,
  ): void {
    const unavailableUntil = Date.now() + Math.max(cooldownMs, 1_000);
    this.modelCooldowns.set(modelCooldownKey(peerId, model), {
      reason,
      unavailableUntil,
    });
    this.observeProvider(peerId, {
      loadHint: 1,
      retryAfterSeconds: Math.max(1, Math.ceil(cooldownMs / 1000)),
    });
    console.warn(
      `[ConsumerGateway] P2PRouter: marked ${peerId} unavailable for ${model} for ${Math.ceil(cooldownMs / 1000)}s (${reason})`,
    );
  }

  observeProvider(
    peerId: string,
    observation: Partial<Omit<ProviderObservation, 'peerId' | 'lastUpdatedAt'>>,
  ): void {
    const now = Date.now();
    const existing = this.getLiveObservation(peerId);
    const next: ProviderObservation = {
      peerId,
      loadHint:
        typeof observation.loadHint === 'number'
          ? clampNumber(observation.loadHint, 0, 1)
          : existing?.loadHint,
      inflight:
        typeof observation.inflight === 'number'
          ? Math.max(0, Math.round(observation.inflight))
          : existing?.inflight,
      queueDepth:
        typeof observation.queueDepth === 'number'
          ? Math.max(0, Math.round(observation.queueDepth))
          : existing?.queueDepth,
      retryAfterSeconds:
        typeof observation.retryAfterSeconds === 'number'
          ? Math.max(1, Math.round(observation.retryAfterSeconds))
          : existing?.retryAfterSeconds,
      observedLatencyMs: blendLatency(existing?.observedLatencyMs, observation.observedLatencyMs),
      lastUpdatedAt: now,
    };
    this.providerObservations.set(peerId, next);
  }

  recordObservedLatency(peerId: string, latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs <= 0) {
      return;
    }
    this.observeProvider(peerId, { observedLatencyMs: latencyMs });
  }

  getProviderObservation(peerId: string): ProviderObservation | null {
    const observation = this.getLiveObservation(peerId);
    return observation ? { ...observation } : null;
  }

  /**
   * Start a background refresh loop that keeps the cache warm.
   * @param models     - List of model IDs to refresh.
   * @param intervalMs - Refresh interval (default 60s).
   */
  startRefreshLoop(models: string[], intervalMs: number = CACHE_TTL_MS): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(async () => {
      for (const model of models) {
        try {
          // Keep the last known directory visible while the network lookup is pending.
          const providers = await this.consumerRouter.findProviders(model);
          this.rememberProviders(model, providers);
        } catch (err) {
          console.error(`[ConsumerGateway] P2PRouter: refresh failed for ${model}:`, err);
        }
      }
      // Also clean up expired failure records
      this.cleanupFailures();
      this.cleanupModelCooldowns();
      this.cleanupPeerCooldowns();
      this.cleanupProviderObservations();
    }, intervalMs);
  }

  /**
   * Stop the background refresh loop.
   */
  stopRefreshLoop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // ---- private helpers ----

  /** Filter out providers that have exceeded the failure threshold and are still in cooldown. */
  private filterExcluded(model: string, providers: ScoredProvider[]): ScoredProvider[] {
    return providers.filter((p) => {
      if (!matchesPaymentNetwork(p.announcement)) return false;
      const cooldown = this.modelCooldowns.get(modelCooldownKey(p.announcement.peerId, model));
      if (cooldown) {
        if (Date.now() >= cooldown.unavailableUntil) {
          this.modelCooldowns.delete(modelCooldownKey(p.announcement.peerId, model));
        } else {
          return false;
        }
      }

      const peerCooldown = this.peerCooldowns.get(p.announcement.peerId);
      if (peerCooldown) {
        if (Date.now() >= peerCooldown.unavailableUntil) {
          this.peerCooldowns.delete(p.announcement.peerId);
        } else {
          return false;
        }
      }

      const record = this.failures.get(p.announcement.peerId);
      if (!record) return true;
      if (record.count < MAX_FAILURES) return true;
      // Excluded — but check if cooldown has passed
      if (Date.now() - record.lastFailure > FAILURE_COOLDOWN_MS) {
        this.failures.delete(p.announcement.peerId);
        return true;
      }
      return false;
    });
  }

  /** Remove stale failure records that are past the cooldown window. */
  private cleanupFailures(): void {
    const now = Date.now();
    for (const [peerId, record] of this.failures) {
      if (now - record.lastFailure > FAILURE_COOLDOWN_MS) {
        this.failures.delete(peerId);
      }
    }
  }

  private cleanupModelCooldowns(): void {
    const now = Date.now();
    for (const [key, record] of this.modelCooldowns) {
      if (now >= record.unavailableUntil) {
        this.modelCooldowns.delete(key);
      }
    }
  }

  private cleanupPeerCooldowns(): void {
    const now = Date.now();
    for (const [peerId, record] of this.peerCooldowns) {
      if (now >= record.unavailableUntil) {
        this.peerCooldowns.delete(peerId);
      }
    }
  }

  private cleanupProviderObservations(): void {
    const now = Date.now();
    for (const [peerId, record] of this.providerObservations) {
      if (now - record.lastUpdatedAt > PROVIDER_OBSERVATION_TTL_MS) {
        this.providerObservations.delete(peerId);
      }
    }
  }

  private getLiveObservation(peerId: string): ProviderObservation | null {
    const observation = this.providerObservations.get(peerId);
    if (!observation) {
      return null;
    }
    if (Date.now() - observation.lastUpdatedAt > PROVIDER_OBSERVATION_TTL_MS) {
      this.providerObservations.delete(peerId);
      return null;
    }
    return observation;
  }

  private rememberProviders(model: string, providers: ScoredProvider[]): void {
    const now = Date.now();
    this.providerCache.set(model, {
      providers,
      fetchedAt: now,
      ttlMs: this.getCacheTtlMs(model),
    });

    for (const provider of providers) {
      for (const pricing of provider.announcement.models) {
        const modelId = pricing.model?.trim();
        if (!modelId || modelId === model) {
          continue;
        }
        const existing = this.providerCache.get(modelId);
        const nextProvider = {
          announcement: provider.announcement,
          modelPricing: pricing,
          score: provider.score,
        };
        const nextProviders = upsertProvider(existing?.providers ?? [], nextProvider);
        this.providerCache.set(modelId, {
          providers: nextProviders,
          fetchedAt: existing?.fetchedAt ?? now,
          ttlMs: existing?.ttlMs ?? this.getCacheTtlMs(modelId),
        });
      }
    }
  }

  private getCacheTtlMs(model: string): number {
    const digest = createHash('sha256')
      .update(`${this.cacheJitterSeed}:${model}`)
      .digest();
    const offset = (digest.readUInt32BE(0) % (CACHE_TTL_JITTER_MS * 2 + 1)) - CACHE_TTL_JITTER_MS;
    return CACHE_TTL_MS + offset;
  }
}

function upsertProvider(providers: ScoredProvider[], provider: ScoredProvider): ScoredProvider[] {
  const next = providers.filter((item) => item.announcement.peerId !== provider.announcement.peerId);
  next.push(provider);
  return next.sort((left, right) => right.score - left.score);
}

function mergeProviders(primary: ScoredProvider[], secondary: ScoredProvider[]): ScoredProvider[] {
  const byPeer = new Map<string, ScoredProvider>();
  for (const provider of [...primary, ...secondary]) {
    const existing = byPeer.get(provider.announcement.peerId);
    if (!existing || provider.score > existing.score) {
      byPeer.set(provider.announcement.peerId, provider);
    }
  }
  return Array.from(byPeer.values()).sort((left, right) => right.score - left.score);
}

function modelCooldownKey(peerId: string, model: string): string {
  return `${peerId}::${model}`;
}

function deriveCacheJitterSeed(consumerRouter: ConsumerRouter): string {
  const peerId = (consumerRouter as any)?.libp2p?.peerId?.toString?.();
  if (typeof peerId === 'string' && peerId.length > 0) {
    return peerId;
  }
  return process.env.CLAW_CACHE_JITTER_SEED ?? os.hostname();
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function blendLatency(previous: number | undefined, next: number | undefined): number | undefined {
  if (!Number.isFinite(next) || next == null || next <= 0) {
    return previous;
  }
  if (!Number.isFinite(previous) || previous == null || previous <= 0) {
    return next;
  }
  return previous * 0.7 + next * 0.3;
}

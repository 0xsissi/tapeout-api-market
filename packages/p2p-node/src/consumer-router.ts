/**
 * Consumer Router — Discover and select optimal providers from the DHT.
 * Implements the scoring algorithm: price(30%) + latency(25%) + reputation(25%) + stability(20%).
 */

import type { Libp2p } from 'libp2p';
import type { ProviderAnnouncement, ModelPricing, ReputationInfo } from '@clawmarket/shared';
import { matchesPaymentNetwork, PAYMENT_TOKEN } from '@clawmarket/shared';
import { findModelProviders } from './discovery.js';
import { ProviderRegistry } from './provider-registry.js';
import { requestProviderAnnouncement } from './provider-discovery.js';

export interface RouterConfig {
  maxPriceInputPer1m?: number;
  maxPriceOutputPer1m?: number;
  strategy?: 'lowest_price' | 'lowest_latency' | 'highest_reputation' | 'balanced';
}

interface ScoredProvider {
  announcement: ProviderAnnouncement;
  modelPricing: ModelPricing;
  score: number;
}

const DEFAULT_MAX_PRICE = 100; // $/1M tokens
const MAX_PROVIDER_ANNOUNCEMENT_AGE_MS = 120_000;

/**
 * Discovers providers via DHT and ranks them using a weighted scoring algorithm.
 */
export class ConsumerRouter {
  private libp2p: Libp2p;
  private registry: ProviderRegistry;
  private config: RouterConfig;
  private providerCache: Map<string, { announcement: ProviderAnnouncement; fetchedAt: number }> =
    new Map();
  private refreshInterval: NodeJS.Timeout | null = null;

  constructor(libp2p: Libp2p, registry: ProviderRegistry, config: RouterConfig = {}) {
    this.libp2p = libp2p;
    this.registry = registry;
    this.config = config;
  }

  /**
   * Find all available providers for a given model, scored and sorted.
   */
  async findProviders(model: string): Promise<ScoredProvider[]> {
    const announcements = await this.collectProviderAnnouncements([model]);

    // Step 3: Filter by model + price limits
    const maxInput = this.config.maxPriceInputPer1m ?? DEFAULT_MAX_PRICE;
    const maxOutput = this.config.maxPriceOutputPer1m ?? DEFAULT_MAX_PRICE;

    const candidates: ScoredProvider[] = [];
    for (const ann of announcements) {
      if (!isAnnouncementFresh(ann)) continue;
      const mp = ann.models.find((m) => m.model === model);
      if (!mp) continue;
      if (mp.inputPer1m > maxInput || mp.outputPer1m > maxOutput) continue;

      const score = this.calculateScore(ann, mp);
      candidates.push({ announcement: ann, modelPricing: mp, score });
    }

    // Step 4: Sort by score descending
    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }

  /**
   * List models currently visible from known/connected providers plus any hinted DHT lookups.
   */
  async listModels(modelHints: string[] = []): Promise<string[]> {
    const announcements = await this.collectProviderAnnouncements(modelHints);
    const models = new Set<string>();

    for (const announcement of announcements) {
      if (!isAnnouncementFresh(announcement)) {
        continue;
      }
      for (const model of announcement.models) {
        if (model?.model?.trim()) {
          models.add(model.model.trim());
        }
      }
    }

    return Array.from(models).sort((left, right) => left.localeCompare(right));
  }

  /**
   * Select the single best provider for a given model.
   * Returns null if no suitable provider is found.
   */
  async selectBest(model: string): Promise<ScoredProvider | null> {
    const providers = await this.findProviders(model);
    return providers[0] ?? null;
  }

  /**
   * Calculate a weighted score for a provider.
   * Score range: 0-100
   */
  private calculateScore(ann: ProviderAnnouncement, mp: ModelPricing): number {
    const strategy = this.config.strategy ?? 'balanced';

    // Normalize each dimension to 0-100
    const priceScore = this.scorePriceDimension(mp);
    const latencyScore = this.scoreLatencyDimension(ann.reputation.avgLatencyMs);
    const reputationScore = this.scoreReputationDimension(ann.reputation);
    const stabilityScore = this.scoreStabilityDimension(ann);

    // Apply weights based on strategy
    switch (strategy) {
      case 'lowest_price':
        return priceScore * 0.6 + latencyScore * 0.15 + reputationScore * 0.15 + stabilityScore * 0.1;
      case 'lowest_latency':
        return priceScore * 0.15 + latencyScore * 0.6 + reputationScore * 0.15 + stabilityScore * 0.1;
      case 'highest_reputation':
        return priceScore * 0.15 + latencyScore * 0.15 + reputationScore * 0.6 + stabilityScore * 0.1;
      case 'balanced':
      default:
        return priceScore * 0.3 + latencyScore * 0.25 + reputationScore * 0.25 + stabilityScore * 0.2;
    }
  }

  private scorePriceDimension(mp: ModelPricing): number {
    // Normalize BEM prices against the configured token-denominated ceilings.
    const avgPrice = (mp.inputPer1m + mp.outputPer1m) / 2;
    const reference = PAYMENT_TOKEN.symbol === 'BEM' ? ((this.config.maxPriceInputPer1m ?? 20) + (this.config.maxPriceOutputPer1m ?? 20)) / 2 : 20;
    return Math.max(0, Math.min(100, (1 - avgPrice / Math.max(reference, 1e-8)) * 100));
  }

  private scoreLatencyDimension(avgLatencyMs: number): number {
    // Lower latency = higher score. 0ms = 100, 2000ms+ = 0
    if (avgLatencyMs <= 0) return 50; // Unknown
    return Math.max(0, Math.min(100, (1 - avgLatencyMs / 2000) * 100));
  }

  private scoreReputationDimension(rep: ReputationInfo): number {
    // Combine score and success rate
    const scoreComponent = Math.min(100, rep.score);
    const successComponent = rep.successRate * 100;
    return (scoreComponent + successComponent) / 2;
  }

  private scoreStabilityDimension(ann: ProviderAnnouncement): number {
    // Freshness of timestamp: recent = stable
    const ageMs = Date.now() - ann.timestamp;
    if (ageMs < 60_000) return 100; // Updated within last minute
    if (ageMs < 300_000) return 75; // Within 5 minutes
    if (ageMs < 600_000) return 50; // Within 10 minutes
    return 25; // Stale
  }

  /**
   * Start periodic cache refresh (default 60s).
   */
  startRefreshLoop(models: string[], intervalMs: number = 60_000): void {
    if (this.refreshInterval) return;
    this.refreshInterval = setInterval(async () => {
      for (const model of models) {
        try {
          await this.findProviders(model);
        } catch (err) {
          console.error(`[Router] Cache refresh failed for ${model}:`, err);
        }
      }
    }, intervalMs);
  }

  stopRefreshLoop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  private async collectProviderAnnouncements(modelHints: string[]): Promise<ProviderAnnouncement[]> {
    const connectedPeerIds = new Set(
      this.libp2p.getConnections().map((connection) => connection.remotePeer.toString()),
    );
    const candidatePeerIds = new Set<string>(connectedPeerIds);

    for (const announcement of this.registry.getKnownProviders()) {
      candidatePeerIds.add(announcement.peerId);
    }

    for (const model of modelHints.map((value) => value.trim()).filter(Boolean)) {
      try {
        const peerIds = await findModelProviders(this.libp2p, model);
        for (const peerId of peerIds) {
          candidatePeerIds.add(peerId);
        }
      } catch (err) {
        console.error(`[Router] DHT lookup failed for ${model}:`, err);
      }
    }

    const announcements = new Map<string, ProviderAnnouncement>();
    await Promise.all(
      Array.from(candidatePeerIds).map(async (peerId) => {
        const announcement = await this.fetchAnnouncement(peerId, connectedPeerIds);
        if (announcement && isAnnouncementFresh(announcement)) {
          announcements.set(peerId, announcement);
        }
      }),
    );

    return Array.from(announcements.values());
  }

  private async fetchAnnouncement(
    peerId: string,
    connectedPeerIds: Set<string>,
  ): Promise<ProviderAnnouncement | null> {
    let announcement = await this.registry.fetchProvider(peerId);
    if (!announcement && connectedPeerIds.has(peerId)) {
      announcement = await requestProviderAnnouncement(this.libp2p, peerId);
      if (announcement) {
        this.registry.rememberProvider(announcement);
      }
    }
    return announcement;
  }
}

function isAnnouncementFresh(announcement: ProviderAnnouncement, now = Date.now()): boolean {
  return matchesPaymentNetwork(announcement) && now - announcement.timestamp <= MAX_PROVIDER_ANNOUNCEMENT_AGE_MS;
}

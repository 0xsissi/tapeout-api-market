/**
 * Provider Registry — Publish and manage provider announcements on DHT.
 * Replaces V1's centralized Registry service (Go/PostgreSQL).
 */

import type { Libp2p } from 'libp2p';
import type { ProviderAnnouncement, ModelPricing, ReputationInfo } from '@clawmarket/shared';
import { PAYMENT_TOKEN, PAYMENT_POOL_ADDRESS, matchesPaymentNetwork } from '@clawmarket/shared';
import { announceModel, startPeriodicAnnounce } from './discovery.js';

const MAX_ANNOUNCEMENT_AGE_MS = 120_000;

/**
 * Manages provider registration and heartbeat on the P2P network.
 */
export class ProviderRegistry {
  private libp2p: Libp2p;
  private announcement: ProviderAnnouncement | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private announceInterval: NodeJS.Timeout | null = null;

  /** In-memory store of known providers (populated via DHT queries) */
  private knownProviders: Map<string, ProviderAnnouncement> = new Map();

  constructor(libp2p: Libp2p) {
    this.libp2p = libp2p;
  }

  /**
   * Announce this node as a provider on the DHT network.
   */
  async announce(announcement: ProviderAnnouncement): Promise<void> {
    announcement.paymentToken = PAYMENT_TOKEN;
    announcement.settlementPool = process.env.ESCROW_POOL_ADDRESS || (PAYMENT_TOKEN.chainId === 97 ? PAYMENT_POOL_ADDRESS : undefined);
    this.announcement = announcement;

    // Announce for each model on DHT
    for (const model of announcement.models) {
      await announceModel(this.libp2p, model.model);
    }

    // Store announcement as a DHT value (peers can query it)
    await this.publishAnnouncementRecord(announcement);

    console.log(
      `[ProviderRegistry] Announced ${announcement.models.length} model(s) from ${announcement.peerId}`
    );
  }

  /**
   * Remove this node's provider announcement.
   */
  async unannounce(): Promise<void> {
    this.stopHeartbeat();
    this.announcement = null;
    console.log('[ProviderRegistry] Unannounced');
  }

  /**
   * Start periodic heartbeat: re-announces models and refreshes DHT records.
   * @param intervalMs Heartbeat interval (default 30s)
   */
  startHeartbeat(intervalMs: number = 30_000): void {
    if (this.heartbeatInterval) return;

    if (!this.announcement) {
      throw new Error('Must announce before starting heartbeat');
    }

    const models = this.announcement.models.map((m) => m.model);
    this.announceInterval = startPeriodicAnnounce(this.libp2p, models, intervalMs);

    // Also re-publish the full announcement record periodically
    this.heartbeatInterval = setInterval(async () => {
      if (this.announcement) {
        this.announcement.timestamp = Date.now();
        await this.publishAnnouncementRecord(this.announcement).catch((err) =>
          console.error('[ProviderRegistry] Heartbeat publish failed:', err)
        );
      }
    }, intervalMs);

    console.log(`[ProviderRegistry] Heartbeat started (${intervalMs}ms interval)`);
  }

  /**
   * Stop the heartbeat loop.
   */
  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }
    console.log('[ProviderRegistry] Heartbeat stopped');
  }

  /**
   * Store a provider's full announcement as a DHT record.
   * Other nodes can retrieve this via the provider's PeerId.
   */
  private async publishAnnouncementRecord(announcement: ProviderAnnouncement): Promise<void> {
    const dht = (this.libp2p.services as Record<string, any>).dht;
    if (!dht) return;

    const key = new TextEncoder().encode(`/clawmarket/provider/${announcement.peerId}`);
    const value = new TextEncoder().encode(
      JSON.stringify(announcement, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
    );

    try {
      await dht.put(key, value);
    } catch (err) {
      console.warn('[ProviderRegistry] publishAnnouncementRecord failed:', err);
    }
  }

  /**
   * Fetch a provider's announcement from DHT by peerId.
   */
  async fetchProvider(peerId: string): Promise<ProviderAnnouncement | null> {
    // Check local cache first
    const cached = this.knownProviders.get(peerId);
    if (cached && isAnnouncementFresh(cached)) {
      return cached;
    }
    if (cached && !isAnnouncementFresh(cached)) {
      this.knownProviders.delete(peerId);
    }

    const dht = (this.libp2p.services as Record<string, any>).dht;
    if (!dht) return null;

    const key = new TextEncoder().encode(`/clawmarket/provider/${peerId}`);
    const iterator = dht.get(key)[Symbol.asyncIterator]();
    try {
      while (true) {
        const nextResult = await Promise.race([
          iterator.next(),
          timeoutAfter(5_000),
        ]);

        if (nextResult === TIMEOUT || nextResult.done) {
          break;
        }

        const event = nextResult.value;
        if (event.name !== 'VALUE') continue;

        const json = new TextDecoder().decode(event.value);
        const announcement = JSON.parse(json) as ProviderAnnouncement;
        announcement.stakeAmount = BigInt(announcement.stakeAmount as unknown as string);
        if (!isAnnouncementFresh(announcement)) {
          this.knownProviders.delete(peerId);
          return null;
        }
        this.knownProviders.set(peerId, announcement);
        return announcement;
      }
    } catch {
      // DHT get may fail; non-fatal
    } finally {
      if (typeof iterator.return === 'function') {
        try {
          void iterator.return();
        } catch {
          // best effort
        }
      }
    }
    return null;
  }

  /**
   * Get the current announcement (if this node is a provider).
   */
  getCurrentAnnouncement(): ProviderAnnouncement | null {
    return this.announcement;
  }

  /**
   * Cache a provider announcement learned via direct peer discovery.
   */
  rememberProvider(announcement: ProviderAnnouncement): void {
    if (!isAnnouncementFresh(announcement)) {
      this.knownProviders.delete(announcement.peerId);
      return;
    }
    this.knownProviders.set(announcement.peerId, announcement);
  }

  /**
   * Return provider announcements already learned by this node.
   */
  getKnownProviders(): ProviderAnnouncement[] {
    const now = Date.now();
    for (const [peerId, announcement] of this.knownProviders) {
      if (now - announcement.timestamp > MAX_ANNOUNCEMENT_AGE_MS) {
        this.knownProviders.delete(peerId);
      }
    }
    return Array.from(this.knownProviders.values()).filter(matchesPaymentNetwork);
  }
}

const TIMEOUT = Symbol('timeout');

function timeoutAfter(ms: number): Promise<typeof TIMEOUT> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(TIMEOUT), ms);
  });
}

function isAnnouncementFresh(announcement: ProviderAnnouncement, now = Date.now()): boolean {
  return matchesPaymentNetwork(announcement) && now - announcement.timestamp <= MAX_ANNOUNCEMENT_AGE_MS;
}

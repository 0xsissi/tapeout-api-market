import { paymentNetworkScope } from '@clawmarket/shared';
/**
 * Node discovery helpers — DHT provide/findProviders wrappers.
 * Generates CIDs from model names for DHT-based service discovery.
 */

import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as raw from 'multiformats/codecs/raw';
import type { Libp2p } from 'libp2p';

const DISCOVERY_DEBUG = process.env.CLAWMARKET_DISCOVERY_DEBUG === '1' || process.env.CLAWMARKET_DISCOVERY_DEBUG === 'true';

/**
 * Generate a deterministic CID from a model name.
 * Used as the DHT key for provider announcements.
 * e.g., "claude-opus-4-5" → CID
 */
export async function modelToCID(model: string): Promise<CID> {
  const prefix = `clawmarket:${paymentNetworkScope() ? paymentNetworkScope() + ':' : ''}model:${model}`;
  const bytes = new TextEncoder().encode(prefix);
  const hash = await sha256.digest(bytes);
  return CID.createV1(raw.code, hash);
}

/**
 * Announce that this node provides a specific model on the DHT.
 */
export async function announceModel(
  libp2p: Libp2p,
  model: string
): Promise<void> {
  const cid = await modelToCID(model);
  const dht = (libp2p.services as Record<string, any>).dht;
  if (!dht) throw new Error('DHT service not available');
  await dht.provide(cid);
  if (DISCOVERY_DEBUG) {
    console.log(`[Discovery] Announced model: ${model} (CID: ${cid.toString()})`);
  }
}

/**
 * Find providers for a specific model on the DHT.
 * Returns an array of PeerId strings.
 */
export async function findModelProviders(
  libp2p: Libp2p,
  model: string,
  maxProviders: number = 20,
  timeoutMs: number = 5_000,
): Promise<string[]> {
  const cid = await modelToCID(model);
  const dht = (libp2p.services as Record<string, any>).dht;
  if (!dht) throw new Error('DHT service not available');

  const providers: string[] = [];
  const iterator = dht.findProviders(cid)[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;

  try {
    while (providers.length < maxProviders) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }

      const nextResult = await Promise.race([
        iterator.next(),
        timeoutAfter(remainingMs),
      ]);

      if (nextResult === TIMEOUT) {
        break;
      }

      if (nextResult.done) {
        break;
      }

      const event = nextResult.value;
      if (event.name === 'PROVIDER') {
        for (const provider of event.providers) {
          providers.push(provider.id.toString());
          if (providers.length >= maxProviders) return providers;
        }
      }
    }
  } finally {
    if (typeof iterator.return === 'function') {
      try {
        void iterator.return();
      } catch {
        // best effort
      }
    }
  }

  return providers;
}

/**
 * Start periodic re-announcement of models.
 * Re-announces every intervalMs (default 30s) to keep DHT records fresh.
 */
export function startPeriodicAnnounce(
  libp2p: Libp2p,
  models: string[],
  intervalMs: number = 30_000
): NodeJS.Timeout {
  const interval = setInterval(async () => {
    for (const model of models) {
      try {
        await announceModel(libp2p, model);
      } catch (err) {
        console.error(`[Discovery] Failed to re-announce ${model}:`, err);
      }
    }
  }, intervalMs);

  // Initial announce
  for (const model of models) {
    announceModel(libp2p, model).catch((err) =>
      console.error(`[Discovery] Initial announce failed for ${model}:`, err)
    );
  }

  return interval;
}

const TIMEOUT = Symbol('timeout');

function timeoutAfter(ms: number): Promise<typeof TIMEOUT> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(TIMEOUT), ms);
  });
}

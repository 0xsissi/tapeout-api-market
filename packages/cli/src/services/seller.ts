import { readFile } from 'node:fs/promises';

import type {
  BuyerNetworkStatus,
  FlushClaimsResponse,
  NetworkProviderSummary,
  SellerStatusPayload,
} from '../types.js';
import { normalizeUrl, sleep } from '../utils.js';
import { fetchJson, postJson } from './http.js';
import { CONTRACTS, PAYMENT_TOKEN, matchesPaymentNetwork } from '@clawmarket/shared';
import { assertGatewaySettlement, checkGatewaySettlement } from '../payment/gateway.js';

export async function loadSellerSummary(url: string): Promise<SellerStatusPayload> {
  const status = await fetchJson<SellerStatusPayload>(`${normalizeUrl(url)}/v1/seller/status`);
  assertGatewaySettlement(status);
  return status;
}

export async function executeFlushClaims(url: string): Promise<FlushClaimsResponse> {
  await checkGatewaySettlement(url, 'seller');
  return await postJson<FlushClaimsResponse>(`${normalizeUrl(url)}/v1/seller/claims/flush`, {}, { timeoutMs: 180_000 });
}

export async function loadSeededNetworkStatus(
  filePath: string,
  defaultModel: string,
): Promise<BuyerNetworkStatus | null> {
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(content);
    const bundles = Array.isArray(parsed) ? parsed : [parsed];
    const providers = bundles.flatMap((bundle) => {
      const announcement = bundle?.announcement;
      if (!announcement || !Array.isArray(announcement.models)) {
        return [] as NetworkProviderSummary[];
      }

      if (!matchesPaymentNetwork(announcement) || (announcement.settlementPool && announcement.settlementPool.toLowerCase() !== (process.env.ESCROW_POOL_ADDRESS ?? CONTRACTS.ESCROW_POOL).toLowerCase())) return [];
      return announcement.models.map((model: Record<string, unknown>) => {
        const p0 = Number(model.p0);
        const alpha = Number(model.alpha);
        return {
        peerId: String(announcement.peerId ?? ''),
        walletAddress: String(announcement.walletAddress ?? ''),
        region: typeof announcement.region === 'string' ? announcement.region : 'seed',
        score: 90,
        model: String(model.model ?? defaultModel),
        inputPer1m: Number(model.inputPer1m ?? 0),
        outputPer1m: Number(model.outputPer1m ?? 0),
        p0: Number.isFinite(p0) ? p0 : undefined,
        alpha: Number.isFinite(alpha) ? alpha : undefined,
        maxConcurrent: Number(announcement.maxConcurrent ?? 0),
        updatedAt: Number(announcement.timestamp ?? Date.now()),
        multiaddrs: Array.isArray(bundle.multiaddrs) ? bundle.multiaddrs.map(String) : [],
        source: 'seed' as const,
        };
      });
    }).filter((provider) => provider.peerId && provider.walletAddress);

    if (providers.length === 0) return null;
    const models = providers.map((provider) => ({
      model: provider.model,
      providerCount: 1,
      bestProvider: provider,
      providers: [provider],
    }));

    return {
      object: 'clawmarket.network_status',
      paymentToken: PAYMENT_TOKEN,
      settlementPool: process.env.ESCROW_POOL_ADDRESS ?? CONTRACTS.ESCROW_POOL,
      updatedAt: Date.now(),
      routingStrategy: 'seeded',
      maxPriceInputPer1m: Math.max(...providers.map((provider) => provider.inputPer1m), 0),
      maxPriceOutputPer1m: Math.max(...providers.map((provider) => provider.outputPer1m), 0),
      source: 'seed',
      bestProvider: providers[0] ?? null,
      models,
    };
  } catch {
    return null;
  }
}

export async function waitForSellerReachability(url: string, timeoutMs: number): Promise<SellerStatusPayload | null> {
  const targetUrl = normalizeUrl(url);
  const deadline = Date.now() + timeoutMs;
  let latest: SellerStatusPayload | null = null;

  while (Date.now() < deadline) {
    latest = await loadSellerSummary(targetUrl).catch(() => latest);
    if (latest?.reachability && latest.reachability.status !== 'not_reachable') {
      return latest;
    }
    await sleep(750);
  }

  return latest;
}

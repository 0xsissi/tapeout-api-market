import './lib/bsc-testnet-only.mjs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  importDist,
  runBuild,
  parseBootstrapPeers,
  createAnnounceAddresses,
  resolveBootstrapPeers,
  startBootstrapMaintenance,
  waitForShutdown,
  DEFAULT_CHAIN_ID,
  DEFAULT_ESCROW_POOL_ADDRESS,
  DEFAULT_RPC_URL,
  DEFAULT_BOOTSTRAP_MANIFEST_URL,
} from './lib/testnet-runtime.mjs';
import { readCsvEnv, readOptionalEnv } from './lib/env.mjs';
import { reportStartupStage } from './lib/startup-progress.mjs';

const buyerWalletPrivateKey = process.env.BUYER_PRIVATE_KEY;
const gatewayPort = Number(process.env.CONSUMER_PORT ?? '8080');
const listenHost = process.env.P2P_LISTEN_HOST ?? '0.0.0.0';
const listenPort = Number(process.env.P2P_LISTEN_PORT ?? '9090');
const announceHost = process.env.ANNOUNCE_HOST ?? '';
const staticBootstrapPeers = parseBootstrapPeers(process.env.BOOTSTRAP_PEERS ?? '');
const bootstrapManifestUrls = process.env.BOOTSTRAP_MANIFEST_URLS ?? DEFAULT_BOOTSTRAP_MANIFEST_URL;
const bootstrapManifestFiles = process.env.BOOTSTRAP_MANIFEST_FILES ?? '';
const bootstrapCachePath = process.env.BOOTSTRAP_CACHE_PATH ?? '';
const bootstrapPeerCachePath =
  process.env.BOOTSTRAP_PEER_CACHE_PATH ??
  path.join(process.env.TAM_HOME ?? process.env.HOME ?? os.homedir(), '.clawmarket', 'known-public-peers.buyer.json');
const bootstrapRefreshMs = Number(process.env.BOOTSTRAP_REFRESH_MS ?? '60000');
const identityPath = process.env.P2P_IDENTITY_PATH ?? '';
const escrowPoolAddress = process.env.ESCROW_POOL_ADDRESS ?? DEFAULT_ESCROW_POOL_ADDRESS;
const rpcUrl = process.env.RPC_URL ?? DEFAULT_RPC_URL;
const chainId = Number(process.env.CHAIN_ID ?? DEFAULT_CHAIN_ID);
const maxPriceInputPer1m = Number(process.env.MAX_PRICE_INPUT_PER_1M ?? '100');
const maxPriceOutputPer1m = Number(process.env.MAX_PRICE_OUTPUT_PER_1M ?? '100');
const routingStrategy = process.env.ROUTING_STRATEGY ?? 'balanced';
const refreshModels = readCsvEnv('REFRESH_MODELS');
const seedProvidersJson = process.env.SEED_PROVIDERS_JSON ?? '';
const seedProvidersFile = process.env.SEED_PROVIDERS_FILE ?? '';
const disableBootstrapMaintenance = process.env.DISABLE_BOOTSTRAP_MAINTENANCE === '1';
const aimmQuoteNetworkId = readOptionalEnv('AIMM_QUOTE_NETWORK_ID');
const discoverableModels = readCsvEnv('DISCOVERABLE_MODELS');
const softmaxBeta = Number(process.env.AIMM_SOFTMAX_BETA ?? '3');

async function main() {
  let node = null, gateway = null, quoteCache = null, quoteSubscriber = null, router = null;
  let bootstrapMaintenance = { stop: async () => {} };
  let stopped = false;
  const cleanup = async () => {
    stopped = true;
    await bootstrapMaintenance.stop().catch(() => {});
    await quoteSubscriber?.stop().catch(() => {});
    quoteCache?.stop();
    router?.stopRefreshLoop();
    await gateway?.stop().catch(() => {});
    await node?.stop().catch(() => {});
  };
  try {
  if (!buyerWalletPrivateKey) {
    throw new Error('BUYER_PRIVATE_KEY is required');
  }
  if (refreshModels.length === 0) {
    throw new Error('REFRESH_MODELS is required and must include at least one subscribed model.');
  }

  reportStartupStage('buyer', 'network');
  await runBuild();

  const consumerPkg = await importDist('packages/consumer-gateway/dist/index.js');
  const p2pPkg = await importDist('packages/p2p-node/dist/index.js');
  const sharedPkg = await importDist('packages/shared/dist/index.js');
  reportStartupStage('buyer', 'clock');
  await checkClockSkew(sharedPkg);
  reportStartupStage('buyer', 'network');
  const bootstrapResolution = await resolveBootstrapPeers({
    staticPeers: staticBootstrapPeers,
    manifestUrls: bootstrapManifestUrls,
    manifestFiles: bootstrapManifestFiles,
    cachePath: bootstrapCachePath,
    peerCachePath: bootstrapPeerCachePath,
  });
  for (const error of bootstrapResolution.errors) {
    console.warn(error);
  }
  const bootstrapPeers = bootstrapResolution.peers.length > 0
    ? bootstrapResolution.peers
    : sharedPkg.DEFAULT_BOOTSTRAP_PEERS;
  const nodePrivateKey = await p2pPkg.loadOrCreateNodeIdentity(identityPath);

  node = await p2pPkg.createNode({
    privateKey: nodePrivateKey,
    listenHost,
    listenPort,
    bootstrapPeers,
    announceAddresses: createAnnounceAddresses(announceHost, listenPort),
  });
  await node.start();
  const registry = new p2pPkg.ProviderRegistry(node.libp2p);
  const discoveryRouter = new p2pPkg.ConsumerRouter(node.libp2p, registry, {
    maxPriceInputPer1m,
    maxPriceOutputPer1m,
    strategy: routingStrategy,
  });
  const baseRouter = new consumerPkg.P2PRouter(discoveryRouter);
  const seededProviders = (await loadSeededProviders(seedProvidersJson, seedProvidersFile))
    .filter(provider => sharedPkg.matchesPaymentNetwork(provider.announcement));
  router = new SeededRouter(baseRouter, seededProviders);
  const startDiscovery = async () => {
    bootstrapMaintenance = disableBootstrapMaintenance
      ? { stop: async () => {} }
      : await startBootstrapMaintenance({
        node,
        dialPeer: (peer) => p2pPkg.dialPeerAddress(node.libp2p, peer),
        discoverPeers: (peer) => requestBootstrapPeersFromAddress(p2pPkg, node.libp2p, peer),
        onPeerReachable: (peer) => {
          const peerId = peerIdFromAddress(peer);
          if (peerId) {
            baseRouter.markPeerReachable(peerId);
          }
        },
        onPeerUnreachable: (peer, reason) => {
          const peerId = peerIdFromAddress(peer);
          if (peerId) {
            baseRouter.markPeerUnreachable(peerId, 90_000, reason);
          }
        },
        staticPeers: bootstrapPeers,
        manifestUrls: bootstrapManifestUrls,
        manifestFiles: bootstrapManifestFiles,
        cachePath: bootstrapCachePath,
        peerCachePath: bootstrapPeerCachePath,
        refreshMs: bootstrapRefreshMs,
        logLabel: 'buyer bootstrap',
        waitForInitialRefresh: false,
      });
    if (stopped) { await bootstrapMaintenance.stop(); return; }
    await connectSeededProviders(p2pPkg, node.libp2p, seededProviders, () => stopped);
    if (stopped) return;
    await warmRouterCache(router, refreshModels, () => stopped);
    if (!stopped && refreshModels.length > 0) router.startRefreshLoop(refreshModels, 30_000);
  };

  const wallet = new consumerPkg.WalletManager(rpcUrl, chainId);
  const streamHandler = new p2pPkg.StreamHandler(node.libp2p);
  quoteCache = new consumerPkg.LocalQuoteCache();
  const quoteModels = refreshModels;
  const effectiveDiscoverableModels = discoverableModels.length > 0 ? discoverableModels : refreshModels;
  quoteSubscriber = new consumerPkg.QuoteSubscriber(
    node,
    quoteCache,
    quoteModels,
    aimmQuoteNetworkId,
  );
  quoteCache.start();
  await quoteSubscriber.start();
  gateway = new consumerPkg.ConsumerGateway(
    {
      privateKey: buyerWalletPrivateKey,
      port: gatewayPort,
      maxRequestCostToken: process.env.MAX_REQUEST_COST_TOKEN ? Number(process.env.MAX_REQUEST_COST_TOKEN) : undefined,
      inputOverheadTokens: process.env.INPUT_OVERHEAD_TOKENS ? Number(process.env.INPUT_OVERHEAD_TOKENS) : undefined,
      maxPriceInputPer1m,
      maxPriceOutputPer1m,
      routingStrategy,
      discoverableModels: effectiveDiscoverableModels,
      escrowPoolAddress,
      rpcUrl,
      chainId,
      bootstrapPeers,
    },
    router,
    wallet,
    streamHandler,
    undefined,
    {
      quoteCache,
      softmaxBeta,
    },
  );

  reportStartupStage('buyer', 'listening');
  await gateway.start();
  reportStartupStage('buyer', 'ready');
  console.log('[buyer] Local API is ready; seller discovery continues in the background.');
  void startDiscovery().catch(error => { if (!stopped) console.warn(`[buyer] Background discovery: ${error instanceof Error ? error.message : String(error)}`); });

  console.log('');
  console.log('BUYER GATEWAY READY');
  console.log(`Gateway:           http://127.0.0.1:${gatewayPort}`);
  console.log(`EscrowPool:        ${escrowPoolAddress}`);
  console.log(`RPC:               ${rpcUrl}`);
  if (identityPath) {
    console.log(`P2P identity:      ${identityPath}`);
  }
  if (bootstrapPeers.length > 0) {
    console.log('Bootstrap peers:');
    for (const peer of bootstrapPeers) {
      console.log(peer);
    }
  }
  if (bootstrapManifestUrls || bootstrapManifestFiles) {
    console.log(`Bootstrap sources: ${[bootstrapManifestUrls, bootstrapManifestFiles].filter(Boolean).join(' | ')}`);
  }
  if (bootstrapPeerCachePath) {
    console.log(`Peer cache:        ${bootstrapPeerCachePath}`);
  }
  if (disableBootstrapMaintenance) {
    console.log('Bootstrap maint:   disabled');
  }
  if (refreshModels.length > 0) {
    console.log(`Refresh models:    ${refreshModels.join(', ')}`);
  }
  console.log(`Quote models:      ${quoteModels.join(', ')}`);
  console.log(`Discoverable:      ${effectiveDiscoverableModels.join(', ')}`);
  if (seededProviders.length > 0) {
    console.log(`Seeded providers:  ${seededProviders.map((item) => item.announcement.peerId).join(', ')}`);
  }
  console.log('Health check:      curl http://127.0.0.1:' + gatewayPort + '/health');
  console.log('List models:       curl http://127.0.0.1:' + gatewayPort + '/v1/models');

  await waitForShutdown(cleanup);
  } catch (error) { await cleanup(); throw error; }
}

async function checkClockSkew(sharedPkg) {
  const urls = (process.env.CLOCK_SKEW_URLS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const result = await sharedPkg.checkClockSkew({
    urls: urls.length > 0 ? urls : undefined,
  });
  if (!result.reachable) {
    console.warn(`[clock] startup skew probe unavailable: ${result.reason}`);
    return null;
  }

  const summary = `${sharedPkg.formatClockSkewMs(result.skewMs)} via ${result.source}`;
  if (result.fatal) {
    throw new Error(`clock skew ${summary} exceeds 5min, refusing to start`);
  }
  if (result.warning) {
    console.warn(`[clock] skew warning: ${summary}`);
  } else {
    console.log(`[clock] skew ${summary}`);
  }
  return result.skewMs;
}

async function requestBootstrapPeersFromAddress(p2pPkg, libp2p, peerAddress) {
  const peerId = peerIdFromAddress(peerAddress);
  if (!peerId) {
    return [];
  }
  return await p2pPkg.requestBootstrapPeers(libp2p, peerId);
}

async function warmRouterCache(router, models, isStopped = () => false) {
  for (const model of models) {
    if (isStopped()) return;
    try {
      await router.findProviders(model);
    } catch (error) {
      console.warn(
        `[buyer bootstrap] failed to warm providers for ${model}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function peerIdFromAddress(peerAddress) {
  if (!peerAddress || typeof peerAddress !== 'string') {
    return null;
  }
  const marker = '/p2p/';
  const segments = peerAddress
    .split(marker)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length < 2) {
    return null;
  }
  return segments[segments.length - 1] || null;
}

main().catch((error) => {
  console.error('BUYER GATEWAY FAILED');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

class SeededRouter {
  constructor(baseRouter, seededProviders) {
    this.baseRouter = baseRouter;
    this.seededProviders = seededProviders;
  }

  async findProviders(model) {
    const discovered = await this.baseRouter.findProviders(model);
    const cached = typeof this.baseRouter.getCachedProviders === 'function'
      ? this.baseRouter.getCachedProviders(model)
      : [];
    const discoveredByPeer = new Map();
    for (const provider of [...discovered, ...cached]) {
      const existing = discoveredByPeer.get(provider.announcement.peerId);
      if (!existing || provider.score > existing.score) {
        discoveredByPeer.set(provider.announcement.peerId, provider);
      }
    }
    const mergedDiscovered = Array.from(discoveredByPeer.values()).sort((left, right) => right.score - left.score);
    const seen = new Set(mergedDiscovered.map((item) => item.announcement.peerId));
    const seeded = this.seededProviders
      .filter((item) => item.modelPricing.model === model && !seen.has(item.announcement.peerId))
      .map((item) => ({
        announcement: item.announcement,
        modelPricing: item.modelPricing,
        score: 90,
      }));
    return [...mergedDiscovered, ...seeded];
  }

  async selectBest(model) {
    const providers = await this.findProviders(model);
    return providers[0] ?? null;
  }

  async listModels(modelHints = []) {
    const discovered = typeof this.baseRouter.listModels === 'function'
      ? await this.baseRouter.listModels(modelHints)
      : [...modelHints];
    const models = new Set(discovered);
    for (const provider of this.seededProviders) {
      if (provider?.modelPricing?.model) {
        models.add(provider.modelPricing.model);
      }
    }
    return Array.from(models).sort();
  }

  listCachedModels(modelHints = []) {
    const cached = typeof this.baseRouter.listCachedModels === 'function'
      ? this.baseRouter.listCachedModels(modelHints)
      : [...modelHints];
    const models = new Set(cached);
    for (const provider of this.seededProviders) {
      if (provider?.modelPricing?.model) {
        models.add(provider.modelPricing.model);
      }
    }
    return Array.from(models).sort();
  }

  getCachedProviders(model) {
    const cached = typeof this.baseRouter.getCachedProviders === 'function'
      ? this.baseRouter.getCachedProviders(model)
      : [];
    const seen = new Set(cached.map((item) => item.announcement.peerId));
    const seeded = this.seededProviders
      .filter((item) => item.modelPricing.model === model && !seen.has(item.announcement.peerId))
      .map((item) => ({
        announcement: item.announcement,
        modelPricing: item.modelPricing,
        score: 90,
      }));
    return [...cached, ...seeded].sort((left, right) => right.score - left.score);
  }

  async selectBestExcluding(model, excludedPeerIds) {
    const providers = await this.findProviders(model);
    return providers.find((provider) => !excludedPeerIds.has(provider.announcement.peerId)) ?? null;
  }

  async isProviderAvailable(model, peerId) {
    const providers = await this.findProviders(model);
    return providers.some((provider) => provider.announcement.peerId === peerId);
  }

  markFailed(peerId) {
    this.baseRouter.markFailed(peerId);
  }

  markSuccess(peerId) {
    this.baseRouter.markSuccess(peerId);
  }

  markTemporarilyUnavailable(peerId, model, cooldownMs, reason) {
    this.baseRouter.markTemporarilyUnavailable(peerId, model, cooldownMs, reason);
  }

  markPeerReachable(peerId) {
    if (typeof this.baseRouter.markPeerReachable === 'function') {
      this.baseRouter.markPeerReachable(peerId);
    }
  }

  markPeerUnreachable(peerId, cooldownMs, reason) {
    if (typeof this.baseRouter.markPeerUnreachable === 'function') {
      this.baseRouter.markPeerUnreachable(peerId, cooldownMs, reason);
    }
  }

  observeProvider(peerId, observation) {
    if (typeof this.baseRouter.observeProvider === 'function') {
      this.baseRouter.observeProvider(peerId, observation);
    }
  }

  recordObservedLatency(peerId, latencyMs) {
    if (typeof this.baseRouter.recordObservedLatency === 'function') {
      this.baseRouter.recordObservedLatency(peerId, latencyMs);
    }
  }

  getProviderObservation(peerId) {
    return typeof this.baseRouter.getProviderObservation === 'function'
      ? this.baseRouter.getProviderObservation(peerId)
      : null;
  }

  startRefreshLoop(models, intervalMs) {
    this.baseRouter.startRefreshLoop(models, intervalMs);
  }

  stopRefreshLoop() {
    this.baseRouter.stopRefreshLoop();
  }
}

async function loadSeededProviders(rawJson, filePath) {
  const sources = [];
  if (rawJson.trim()) {
    sources.push(rawJson);
  }
  if (filePath.trim()) {
    sources.push(await readFile(filePath, 'utf8'));
  }

  const bundles = [];
  for (const source of sources) {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) {
      bundles.push(...parsed);
    } else {
      bundles.push(parsed);
    }
  }

  return bundles.flatMap((bundle) => {
    if (!bundle?.announcement || !Array.isArray(bundle.multiaddrs)) {
      return [];
    }

    const announcement = {
      ...bundle.announcement,
      stakeAmount: BigInt(bundle.announcement.stakeAmount ?? '0'),
      multiaddrs: Array.isArray(bundle.announcement.multiaddrs)
        ? bundle.announcement.multiaddrs
        : bundle.multiaddrs,
    };

    return announcement.models.map((modelPricing) => ({
      announcement,
      multiaddrs: bundle.multiaddrs,
      modelPricing,
    }));
  });
}

async function connectSeededProviders(p2pPkg, libp2p, seededProviders, isStopped = () => false) {
  const seen = new Set();
  for (const provider of seededProviders) {
    for (const addr of provider.multiaddrs) {
      if (isStopped()) return;
      if (seen.has(addr)) continue;
      seen.add(addr);
      try {
        await p2pPkg.dialPeerAddress(libp2p, addr);
        break;
      } catch (error) {
        console.warn(`[buyer] Failed to dial seeded provider ${addr}:`, error);
      }
    }
  }
}

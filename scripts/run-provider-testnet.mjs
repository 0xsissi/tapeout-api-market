import './lib/bsc-testnet-only.mjs';
import './lib/promise-with-resolvers.mjs';
import { ethers } from '../packages/provider-gateway/node_modules/ethers/lib.esm/index.js';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  importDist,
  runBuild,
  parseBootstrapPeers,
  createAnnounceAddresses,
  createProviderNodeAdapter,
  isShareablePeerAddress,
  resolveBootstrapPeers,
  startRelayReservationMaintenance,
  startBootstrapMaintenance,
  waitForShutdown,
  DEFAULT_CHAIN_ID,
  DEFAULT_ESCROW_POOL_ADDRESS,
  DEFAULT_RPC_URL,
  DEFAULT_BOOTSTRAP_MANIFEST_URL,
} from './lib/testnet-runtime.mjs';
import { isEmbeddedCliproxyEnabled, startEmbeddedCliproxy } from './lib/embedded-cliproxy.mjs';
import { readOptionalEnv } from './lib/env.mjs';
import { resolveProviderBackend } from './lib/provider-backend.mjs';
import { startAdmissionSync } from './lib/admission-sync.mjs';
import { reportStartupStage } from './lib/startup-progress.mjs';

const providerWalletPrivateKey = process.env.PROVIDER_PRIVATE_KEY;
const signingPrivateKeyFromEnv = process.env.SIGNING_PRIVATE_KEY ?? '';
const listenHost = process.env.P2P_LISTEN_HOST ?? '0.0.0.0';
const listenPort = Number(process.env.P2P_LISTEN_PORT ?? '9090');
const announceHost = process.env.ANNOUNCE_HOST ?? '';
const staticBootstrapPeers = parseBootstrapPeers(process.env.BOOTSTRAP_PEERS ?? '');
const bootstrapManifestUrls = process.env.BOOTSTRAP_MANIFEST_URLS ?? DEFAULT_BOOTSTRAP_MANIFEST_URL;
const bootstrapManifestFiles = process.env.BOOTSTRAP_MANIFEST_FILES ?? '';
const bootstrapCachePath = process.env.BOOTSTRAP_CACHE_PATH ?? '';
const bootstrapPeerCachePath =
  process.env.BOOTSTRAP_PEER_CACHE_PATH ??
  path.join(process.env.TAM_HOME ?? process.env.HOME ?? os.homedir(), '.clawmarket', 'known-public-peers.seller.json');
const bootstrapRefreshMs = Number(process.env.BOOTSTRAP_REFRESH_MS ?? '60000');
const identityPath = process.env.P2P_IDENTITY_PATH ?? '';
const signingIdentityPath =
  process.env.SIGNING_IDENTITY_PATH ??
  path.join(process.env.TAM_HOME ?? process.env.HOME ?? os.homedir(), '.clawmarket', 'seller-signing.key.json');
const e2eeIdentityPath =
  process.env.E2EE_IDENTITY_PATH ??
  path.join(process.env.TAM_HOME ?? process.env.HOME ?? os.homedir(), '.clawmarket', 'seller-e2ee.key');
const escrowPoolAddress = process.env.ESCROW_POOL_ADDRESS ?? DEFAULT_ESCROW_POOL_ADDRESS;
const rpcUrl = process.env.RPC_URL ?? DEFAULT_RPC_URL;
const chainId = Number(process.env.CHAIN_ID ?? DEFAULT_CHAIN_ID);
const heartbeatMs = Number(process.env.HEARTBEAT_MS ?? '30000');
const announcementOut = process.env.ANNOUNCEMENT_OUT ?? '';
const sellerStatusPort = Number(process.env.SELLER_STATUS_PORT ?? '0');
const sellerStatusHost = process.env.SELLER_STATUS_HOST ?? '127.0.0.1';
const miningRewardsAddress = process.env.MINING_REWARDS_ADDRESS ?? '';
const maxConcurrent = Number(process.env.MAX_CONCURRENT ?? '5');
const aimmQuoteNetworkId = readOptionalEnv('AIMM_QUOTE_NETWORK_ID');
const aimmCliproxyManagementUrl = readOptionalEnv('AIMM_CLIPROXY_MANAGEMENT_URL');
const aimmQuotaPollIntervalMs = Number(process.env.AIMM_QUOTA_POLL_INTERVAL_MS ?? '10000');
const aimmAccountTiers = parseAimmAccountTiers(process.env.AIMM_ACCOUNT_TIERS_JSON ?? '');
const sellerUpstream = process.env.SELLER_UPSTREAM ?? '';

async function main() {
  reportStartupStage('seller', 'account');
  if (!providerWalletPrivateKey) {
    throw new Error('PROVIDER_PRIVATE_KEY is required');
  }
  if (process.env.TAM_ADMISSION_ORIGIN) {
    await startAdmissionSync({ origin: process.env.TAM_ADMISSION_ORIGIN, file: process.env.CLAWMARKET_TRUSTED_BUYERS_FILE });
  }

  let embeddedCliproxy = null;
  let node = null;
  let gateway = null;
  let sellerStatusServer = null;
  let bootstrapMaintenance = null;
  let registry = null;
  let announcementSyncTimer = null;
  let stopRelayReservationMaintenance = () => {};
  const cleanup = async () => {
    if (announcementSyncTimer) clearInterval(announcementSyncTimer);
    stopRelayReservationMaintenance();
    registry?.stopHeartbeat();
    await bootstrapMaintenance?.stop().catch(() => {});
    await sellerStatusServer?.stop().catch(() => {});
    await gateway?.stop().catch(() => {});
    await node?.stop().catch(() => {});
    await embeddedCliproxy?.stop().catch(() => {});
  };
  try {
    const backendEnv = { ...process.env };
    if (isEmbeddedCliproxyEnabled(process.env)) {
      embeddedCliproxy = await startEmbeddedCliproxy(process.env);
      backendEnv.PROXY_URL = embeddedCliproxy.backendUrl;
      delete backendEnv.PROXY_HEADERS_JSON;
      if (!backendEnv.MODELS_JSON && embeddedCliproxy.discoveredModels.length > 0) {
        backendEnv.MODELS_JSON = JSON.stringify(embeddedCliproxy.discoveredModels);
      }
      if (!backendEnv.MODELS_JSON && embeddedCliproxy.discoveredModels.length === 0) {
        throw new Error(
          'Embedded cliproxy started but exposed no models. Run `pnpm seller:codex-login` or set MODELS_JSON explicitly.',
        );
      }
    }

    const backend = await resolveProviderBackend(backendEnv);
    const proxyUrl = backend.backendUrl;
    const proxyHeaders = backend.backendHeaders;
    const dailyLimitUsd = backend.dailyLimitUsd;
    const region = backend.region;

    await runBuild();

    const providerPkg = await importDist('packages/provider-gateway/dist/index.js');
    const p2pPkg = await importDist('packages/p2p-node/dist/index.js');
    const sharedPkg = await importDist('packages/shared/dist/index.js');
    const models = backend.models.map(model => sharedPkg.normalizeModelPricing(model));
    reportStartupStage('seller', 'clock');
    const clockSkew = await checkClockSkew(sharedPkg);
    reportStartupStage('seller', 'network');
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
    const relayReservationPeers = staticBootstrapPeers.length > 0
      ? staticBootstrapPeers
      : sharedPkg.DEFAULT_BOOTSTRAP_PEERS;
    const relayListenAddrs = createRelayReservationListenAddrs(relayReservationPeers);
    const nodePrivateKey = await p2pPkg.loadOrCreateNodeIdentity(identityPath);
    const e2eePrivateKey = await loadOrCreateProviderE2eePrivateKey(e2eeIdentityPath);

    node = await p2pPkg.createNode({
      privateKey: nodePrivateKey,
      listenHost,
      listenPort,
      bootstrapPeers,
      relayListenAddrs,
      announceAddresses: createAnnounceAddresses(announceHost, listenPort),
    });

    const walletAddress = new ethers.Wallet(providerWalletPrivateKey).address;
    const signingKey = signingPrivateKeyFromEnv
      ? {
          privateKey: normalizeHexPrivateKey(signingPrivateKeyFromEnv),
          address: new ethers.Wallet(normalizeHexPrivateKey(signingPrivateKeyFromEnv)).address,
          rotated: false,
        }
      : await p2pPkg.ensureQuoteSigningKey(signingIdentityPath);
    const signingDelegation = sharedPkg.createQuoteSignerDelegation(
      signingKey.address,
      providerWalletPrivateKey,
    );
    const resolvedAimmAccountTiers = aimmAccountTiers
      ?? (sharedPkg.PAYMENT_TOKEN.symbol === 'USDC' ? await autoProbeAimmAccountTiers({
        providerPkg,
        backendUrl: embeddedCliproxy?.backendUrl ?? proxyUrl,
        authDir: embeddedCliproxy?.authDir ?? process.env.CLIPROXY_AUTH_DIR ?? '',
        upstream: sellerUpstream,
      }) : undefined);
    const fallbackAimmManagementUrl = resolvedAimmAccountTiers
      ? (embeddedCliproxy?.backendUrl ?? proxyUrl)
      : undefined;
    const resolvedAimmCliproxyManagementUrl = aimmCliproxyManagementUrl ?? fallbackAimmManagementUrl;
    gateway = new providerPkg.ProviderGateway(
      {
        privateKey: providerWalletPrivateKey,
        signingPrivateKey: signingKey.privateKey,
        signingDelegation,
        e2eePrivateKey,
        proxyUrl,
        proxyHeaders,
        models,
        maxConcurrent,
        aimmQuoteNetworkId,
        aimmCliproxyManagementUrl: resolvedAimmCliproxyManagementUrl,
        aimmQuotaPollIntervalMs,
        aimmAccountTiers: resolvedAimmAccountTiers,
        dailyLimitUsd,
        dailyLimitToken: process.env.DAILY_LIMIT_TOKEN ? Number(process.env.DAILY_LIMIT_TOKEN) : undefined,
        maxRequestCostToken: process.env.MAX_REQUEST_COST_TOKEN ? Number(process.env.MAX_REQUEST_COST_TOKEN) : undefined,
        maxUnconfirmedCreditToken: process.env.MAX_UNCONFIRMED_CREDIT_TOKEN ? Number(process.env.MAX_UNCONFIRMED_CREDIT_TOKEN) : undefined,
        escrowPoolAddress,
        rpcUrl,
        chainId,
        bootstrapPeers,
      },
      async () => createProviderNodeAdapter(node),
    );

    reportStartupStage('seller', 'settlement');
    await gateway.start();
    let latestAnnouncedMultiaddrs = [];
    if (sellerStatusPort > 0) {
      reportStartupStage('seller', 'listening');
      sellerStatusServer = new providerPkg.SellerStatusServer(
        {
          port: sellerStatusPort,
          host: sellerStatusHost,
          walletAddress,
          peerId: node.peerId.toString(),
          backendMode: embeddedCliproxy?.backendMode ?? backend.backendMode,
          backendUrl: proxyUrl,
          models,
          escrowPoolAddress,
          rpcUrl,
          chainId,
          miningRewardsAddress: miningRewardsAddress.trim() ? miningRewardsAddress : undefined,
          clockSkewMs: clockSkew,
          getMultiaddrs: () => stringifyNodeMultiaddrs(node),
          getAnnouncedMultiaddrs: () => latestAnnouncedMultiaddrs,
        },
        gateway,
      );
      await sellerStatusServer.start();
      reportStartupStage('seller', 'reachability');
    }
    if (relayListenAddrs.length > 0) {
      stopRelayReservationMaintenance = startRelayReservationMaintenance(node, {
        logLabel: '[seller relay]',
      });
    }
    bootstrapMaintenance = await startBootstrapMaintenance({
      node,
      dialPeer: (peer) => p2pPkg.dialPeerAddress(node.libp2p, peer),
      discoverPeers: (peer) => requestBootstrapPeersFromAddress(p2pPkg, node.libp2p, peer),
      staticPeers: bootstrapPeers,
      manifestUrls: bootstrapManifestUrls,
      manifestFiles: bootstrapManifestFiles,
      cachePath: bootstrapCachePath,
      peerCachePath: bootstrapPeerCachePath,
      refreshMs: bootstrapRefreshMs,
      logLabel: 'seller bootstrap',
    });

    registry = new p2pPkg.ProviderRegistry(node.libp2p);
    const announcement = {
      peerId: node.peerId.toString(),
      walletAddress,
      publicKey: gateway.publicKey,
      multiaddrs: [],
      models,
      region,
      maxConcurrent: gateway.protection.maxConcurrent,
      stakeAmount: 0n,
      reputation: {
        score: 100,
        totalTransactions: 0,
        successRate: 1,
        avgLatencyMs: 0,
      },
      timestamp: Date.now(),
      signature: '0xprovider',
    };

    syncAnnouncementMultiaddrs(announcement, node);
    await registry.announce(announcement);
    p2pPkg.registerBootstrapPeerExchangeHandler(node.libp2p, () =>
      Array.from(
        new Set([
          ...createShareableNodeMultiaddrs(node),
        ]),
      ),
    );
    p2pPkg.registerProviderDiscoveryHandler(node.libp2p, () => registry.getCurrentAnnouncement());
    registry.startHeartbeat(heartbeatMs);

    let serializedSeedBundle = '';
    const persistSeedBundle = async () => {
      syncAnnouncementMultiaddrs(announcement, node);
      latestAnnouncedMultiaddrs = announcement.multiaddrs ?? [];
      const seedBundle = {
        announcement,
        multiaddrs: announcement.multiaddrs ?? [],
      };
      const nextSerializedSeedBundle = JSON.stringify(
        seedBundle,
        (_, value) => (typeof value === 'bigint' ? value.toString() : value),
        2,
      );
      if (announcementOut && nextSerializedSeedBundle !== serializedSeedBundle) {
        await writeFile(announcementOut, `${nextSerializedSeedBundle}\n`, 'utf8');
      }
      serializedSeedBundle = nextSerializedSeedBundle;
      return seedBundle;
    };
    const seedBundle = await persistSeedBundle();
    const shareableMultiaddrs = seedBundle.multiaddrs;
    announcementSyncTimer = setInterval(() => {
      persistSeedBundle().catch((error) => {
        console.warn(
          `[seller announcement] Failed to refresh announced addresses: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, 5_000);

    console.log('');
    console.log('SELLER NODE READY');
    console.log(`Wallet:            ${walletAddress}`);
    console.log(`Peer ID:           ${node.peerId.toString()}`);
    console.log(`Backend mode:      ${embeddedCliproxy?.backendMode ?? backend.backendMode}`);
    console.log(`Backend URL:       ${proxyUrl}`);
    if (sellerStatusServer) {
      console.log(`Seller status API: ${sellerStatusServer.getUrl()}`);
    }
    if (embeddedCliproxy) {
      console.log(`Cliproxy source:   ${embeddedCliproxy.sourceDir}`);
      console.log(`Cliproxy config:   ${embeddedCliproxy.configPath}`);
      console.log(`Cliproxy auth dir: ${embeddedCliproxy.authDir}`);
    }
    if (proxyHeaders && Object.keys(proxyHeaders).length > 0) {
      console.log(`Backend headers:   ${Object.keys(proxyHeaders).join(', ')}`);
    }
    if (backend.sellerProfilePath) {
      console.log(`Seller profile:    ${backend.sellerProfilePath}`);
    }
    if (identityPath) {
      console.log(`P2P identity:      ${identityPath}`);
    }
    if (signingIdentityPath) {
      console.log(`Signing identity:  ${signingIdentityPath}`);
      console.log(`Quote signer:      ${signingKey.address}${signingKey.rotated ? ' (rotated)' : ''}`);
    }
    if (e2eeIdentityPath) {
      console.log(`E2EE identity:     ${e2eeIdentityPath}`);
    }
    const reachability = describeSellerReachability(stringifyNodeMultiaddrs(node), shareableMultiaddrs);
    console.log(`Reachability:      ${reachability.label}`);
    console.log(`Connect hint:      ${reachability.summary}`);
    console.log(`EscrowPool:        ${escrowPoolAddress}`);
    console.log(`RPC:               ${rpcUrl}`);
    console.log(`Models:            ${models.map((item) => item.model).join(', ')}`);
    console.log('Reachable multiaddrs:');
    for (const addr of shareableMultiaddrs) {
      console.log(addr);
    }
    console.log('Seed bundle for buyers:');
    console.log(serializedSeedBundle);
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
    if (announcementOut) {
      console.log(`Seed bundle written to: ${announcementOut}`);
    }

    await waitForShutdown(cleanup);
  } catch (error) {
    // Close partially created resources too, preserving the original startup error.
    await cleanup();
    throw error;
  }
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

function parseAimmAccountTiers(raw) {
  if (!raw?.trim()) {
    return undefined;
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('AIMM_ACCOUNT_TIERS_JSON must be a JSON array');
  }

  return parsed
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      authIndex: String(item.authIndex ?? '').trim(),
      tier: String(item.tier ?? '').trim(),
    }))
    .filter((item) => item.authIndex && item.tier);
}

async function autoProbeAimmAccountTiers({ providerPkg, backendUrl, authDir, upstream }) {
  if (!backendUrl || !authDir || !upstream) {
    return undefined;
  }

  const accounts = await listAuthAccounts(authDir, upstream);
  if (accounts.length === 0) {
    return undefined;
  }

  const results = await providerPkg.probeAllAccounts(accounts, backendUrl).catch((error) => {
    console.warn(`[seller AIMM] auto tier probe failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  });

  const detected = results
    .filter((item) => item.result?.ok)
    .map((item) => ({ authIndex: item.authIndex, tier: item.result.tier }));

  if (detected.length > 0) {
    console.log(`[seller AIMM] detected tiers: ${detected.map((item) => `${item.authIndex}=${item.tier}`).join(', ')}`);
    return detected;
  }

  return undefined;
}

async function listAuthAccounts(authDir, upstream) {
  const files = await collectJsonFiles(authDir);
  return files.map((filePath) => ({
    authIndex: path.basename(filePath, '.json'),
    upstream,
    authFile: filePath,
  }));
}

async function collectJsonFiles(root) {
  const results = [];

  async function visit(current) {
    try {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) {
          continue;
        }
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await visit(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
          results.push(fullPath);
        }
      }
    } catch {
      return;
    }
  }

  await visit(root);
  return results.sort();
}

main().catch((error) => {
  console.error('SELLER NODE FAILED');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

async function requestBootstrapPeersFromAddress(p2pPkg, libp2p, peerAddress) {
  const peerId = peerIdFromAddress(peerAddress);
  if (!peerId) {
    return [];
  }
  return await p2pPkg.requestBootstrapPeers(libp2p, peerId);
}

function peerIdFromAddress(peerAddress) {
  const marker = '/p2p/';
  const index = peerAddress.indexOf(marker);
  if (index === -1) {
    return null;
  }
  return peerAddress.slice(index + marker.length).trim() || null;
}

function createShareableNodeMultiaddrs(node) {
  const peerId = node.peerId.toString();
  return Array.from(
    new Set(
      node.getMultiaddrs()
        .map((addr) => addr?.toString?.() ?? String(addr))
        .filter(isShareablePeerAddress)
        .map((addr) => (addr.includes('/p2p/') ? addr : `${addr}/p2p/${peerId}`)),
    ),
  );
}

function stringifyNodeMultiaddrs(node) {
  return node.getMultiaddrs().map((addr) => addr?.toString?.() ?? String(addr));
}

function createRelayReservationListenAddrs(peers) {
  const seenPeerIds = new Set();
  const relayAddrs = [];

  for (const peer of peers) {
    const peerId = peerIdFromAddress(peer);
    if (!peerId || seenPeerIds.has(peerId)) {
      continue;
    }
    seenPeerIds.add(peerId);
    relayAddrs.push(peer.includes('/p2p-circuit') ? peer : `${peer}/p2p-circuit`);
  }

  return relayAddrs;
}

function syncAnnouncementMultiaddrs(announcement, node) {
  announcement.multiaddrs = createShareableNodeMultiaddrs(node);
}

function describeSellerReachability(rawMultiaddrs, announcedMultiaddrs) {
  const source = Array.from(new Set([...announcedMultiaddrs, ...rawMultiaddrs]));
  const hasRelay = source.some((addr) => addr.includes('/p2p-circuit'));
  const hasPublicDirect = source.some((addr) => !addr.includes('/p2p-circuit') && isPublicMultiaddr(addr));

  if (hasPublicDirect) {
    return {
      label: '公网可直连',
      summary: '买家可以优先直接拨入；relay 地址会作为备用连接路径。',
    };
  }

  if (hasRelay) {
    return {
      label: 'relay 可连接',
      summary: '这台 seller 可以通过公网 relay 被买家连接，适合内网机器卖 token。',
    };
  }

  return {
    label: '暂不可被买家连接',
    summary: '当前没有公网直连或 relay 地址，买家大概率无法拨入这台 seller。',
  };
}

function isPublicMultiaddr(value) {
  const dnsHost = extractMultiaddrSegment(value, 'dns4') ?? extractMultiaddrSegment(value, 'dns6');
  if (dnsHost) {
    return true;
  }

  const ipv4Host = extractMultiaddrSegment(value, 'ip4');
  if (ipv4Host) {
    return isPublicIpv4(ipv4Host);
  }

  const ipv6Host = extractMultiaddrSegment(value, 'ip6');
  if (ipv6Host) {
    return isPublicIpv6(ipv6Host);
  }

  return false;
}

function extractMultiaddrSegment(value, protocol) {
  const marker = `/${protocol}/`;
  const start = value.indexOf(marker);
  if (start === -1) {
    return null;
  }

  const rest = value.slice(start + marker.length);
  const end = rest.indexOf('/');
  return end === -1 ? rest : rest.slice(0, end);
}

function isPublicIpv4(host) {
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b, c] = parts;
  if (a === undefined || b === undefined || c === undefined) return false;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIpv6(host) {
  const normalised = host.toLowerCase();
  if (normalised === '::' || normalised === '::1') {
    return false;
  }
  if (normalised.startsWith('fc') || normalised.startsWith('fd')) {
    return false;
  }
  if (
    normalised.startsWith('fe8') ||
    normalised.startsWith('fe9') ||
    normalised.startsWith('fea') ||
    normalised.startsWith('feb')
  ) {
    return false;
  }
  return true;
}

async function loadOrCreateProviderE2eePrivateKey(identityPath) {
  if (!identityPath) {
    throw new Error('E2EE identity path is required');
  }

  try {
    const existing = (await readFile(identityPath, 'utf8')).trim();
    if (existing) {
      return normalizeHexPrivateKey(existing);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  const cryptoPkg = await importDist('packages/crypto/dist/index.js');
  const generated = cryptoPkg.bytesToHex(cryptoPkg.generateKeyPair().privateKey);
  await mkdir(path.dirname(identityPath), { recursive: true });
  await writeFile(identityPath, `${generated}\n`, 'utf8');
  return generated;
}

function normalizeHexPrivateKey(value) {
  const trimmed = String(value ?? '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(`Invalid provider E2EE private key in identity file: ${trimmed}`);
  }
  return trimmed.toLowerCase();
}

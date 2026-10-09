import os from 'node:os';
import path from 'node:path';

import { P2PRouter } from '@clawmarket/consumer-gateway';
import {
  ConsumerRouter,
  ProviderRegistry,
  StreamHandler,
  createNode,
  loadOrCreateNodeIdentity,
} from '@clawmarket/p2p-node';
import {
  CONTRACTS,
  DEFAULT_BOOTSTRAP_PEERS,
  DEFAULT_CHAIN_ID,
  DEFAULT_P2P_PORT,
  DEFAULT_RPC_URL,
} from '@clawmarket/shared';
import {
  generateKeyPair,
  getPublicKey,
  hexToBytes,
  type KeyPair,
} from '@clawmarket/crypto';

import { HostedGateway } from './server.js';

async function main(): Promise<void> {
  const port = Number(process.env.HOSTED_GATEWAY_PORT ?? process.env.PORT ?? '8787');
  const host = process.env.HOSTED_GATEWAY_HOST ?? '127.0.0.1';
  const publicBaseUrl = process.env.HOSTED_GATEWAY_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
  const listenHost = process.env.P2P_LISTEN_HOST ?? '0.0.0.0';
  const listenPort = Number(process.env.P2P_LISTEN_PORT ?? DEFAULT_P2P_PORT);
  const identityPath =
    process.env.P2P_IDENTITY_PATH ??
    path.join(os.homedir(), '.clawmarket', 'hosted-gateway.peer.key');
  const bootstrapPeers = parseBootstrapPeers(process.env.BOOTSTRAP_PEERS) ?? DEFAULT_BOOTSTRAP_PEERS;
  const rpcUrl = process.env.RPC_URL ?? DEFAULT_RPC_URL;
  const chainId = Number(process.env.CHAIN_ID ?? DEFAULT_CHAIN_ID);
  const escrowPoolAddress = (process.env.ESCROW_POOL_ADDRESS ?? CONTRACTS.ESCROW_POOL) as `0x${string}`;
  const discoverableModels = (process.env.REFRESH_MODELS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const nodePrivateKey = await loadOrCreateNodeIdentity(identityPath);
  const node = await createNode({
    privateKey: nodePrivateKey,
    listenHost,
    listenPort,
    bootstrapPeers,
  });
  await node.start();

  const registry = new ProviderRegistry(node.libp2p);
  const discoveryRouter = new ConsumerRouter(node.libp2p, registry, {
    maxPriceInputPer1m: Number(process.env.MAX_PRICE_INPUT_PER_1M ?? '100'),
    maxPriceOutputPer1m: Number(process.env.MAX_PRICE_OUTPUT_PER_1M ?? '100'),
    strategy: (process.env.ROUTING_STRATEGY as any) ?? 'balanced',
  });
  const router = new P2PRouter(discoveryRouter, { cacheJitterSeed: node.peerId.toString() });
  if (discoverableModels.length > 0) {
    router.startRefreshLoop(discoverableModels, 30_000);
  }

  const streamHandler = new StreamHandler(node.libp2p);
  const gateway = new HostedGateway(
    {
      port,
      host,
      publicBaseUrl,
      escrowPoolAddress,
      rpcUrl,
      chainId,
      relayerPrivateKey: normalizePrivateKey(process.env.HOSTED_GATEWAY_RELAYER_PRIVATE_KEY),
      discoverableModels,
      inputOverheadTokens: process.env.INPUT_OVERHEAD_TOKENS ? Number(process.env.INPUT_OVERHEAD_TOKENS) : undefined,
    },
    router,
    streamHandler,
    loadE2eeKeyPair(process.env.HOSTED_GATEWAY_E2EE_PRIVATE_KEY),
  );
  await gateway.start();

  console.log('');
  console.log('HOSTED GATEWAY READY');
  console.log(`HTTPS API:     ${publicBaseUrl}`);
  console.log(`P2P peer:      ${node.peerId.toString()}`);
  console.log(`EscrowPool:    ${escrowPoolAddress}`);
  console.log(`Gasless relay: ${process.env.HOSTED_GATEWAY_RELAYER_PRIVATE_KEY ? 'enabled' : 'disabled'}`);
  console.log(`Health:        ${publicBaseUrl}/health`);

  await waitForShutdown(async () => {
    router.stopRefreshLoop();
    await gateway.stop();
    await node.stop();
  });
}

function loadE2eeKeyPair(privateKeyHex: string | undefined): KeyPair {
  if (!privateKeyHex) {
    return generateKeyPair();
  }
  const privateKey = hexToBytes(privateKeyHex);
  const publicKey = getPublicKey(privateKey);
  return { privateKey, publicKey, secretKey: privateKey };
}

function normalizePrivateKey(value: string | undefined): `0x${string}` | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.startsWith('0x') ? value : `0x${value}`;
  return /^0x[a-fA-F0-9]{64}$/.test(normalized) ? normalized as `0x${string}` : undefined;
}

function parseBootstrapPeers(value: string | undefined): string[] | null {
  if (!value?.trim()) {
    return null;
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function waitForShutdown(cleanup: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    let stopped = false;
    const stop = async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      await cleanup().catch((error) => console.error('[HostedGateway] shutdown failed:', error));
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

main().catch((error) => {
  console.error('HOSTED GATEWAY FAILED');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

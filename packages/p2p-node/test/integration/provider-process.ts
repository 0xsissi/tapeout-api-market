/**
 * Integration test: Provider process.
 * Starts a libp2p node, registers as provider for "claude-opus-4-5",
 * and echoes a fake streamed response for any inference request.
 */

import { createLibp2p } from 'libp2p';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { kadDHT } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { ProviderRegistry } from '../../src/provider-registry.js';
import { StreamHandler } from '../../src/stream-handler.js';
import type { ProviderAnnouncement } from '@clawmarket/shared';

// Deterministic key: 32-byte Ed25519 seed. Hardcoded so PeerId is stable.
const DEFAULT_PROVIDER_KEY_HEX =
  '1111111111111111111111111111111111111111111111111111111111111111';

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function deterministicPrivateKey() {
  const hex = process.env.PROVIDER_KEY ?? DEFAULT_PROVIDER_KEY_HEX;
  const seed = hexToBytes(hex);
  if (seed.length !== 32) {
    throw new Error(`PROVIDER_KEY must be 32 bytes hex; got ${seed.length}`);
  }
  return await generateKeyPairFromSeed('Ed25519', seed);
}

async function main() {
  const privateKey = await deterministicPrivateKey();
  const peerId = peerIdFromPrivateKey(privateKey);

  const isPublic = process.env.PROVIDER_PUBLIC === '1';
  const listenAddrs = isPublic
    ? ['/ip4/0.0.0.0/tcp/4101', '/ip4/0.0.0.0/tcp/4102/ws']
    : ['/ip4/127.0.0.1/tcp/4101', '/ip4/127.0.0.1/tcp/4102/ws'];

  const node = await createLibp2p({
    privateKey,
    addresses: {
      listen: listenAddrs,
    },
    transports: [tcp(), webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      ping: ping(),
      dht: kadDHT({ clientMode: false }),
    },
  });

  await node.start();
  console.log(`[PROVIDER] PeerId: ${peerId.toString()}`);
  for (const ma of node.getMultiaddrs()) {
    console.log(`[PROVIDER] Listening: ${ma.toString()}`);
  }

  // Register the inference stream handler BEFORE announcing.
  const streamHandler = new StreamHandler(node);
  streamHandler.handleIncoming(async (request, writer) => {
    console.log(`[PROVIDER] Got request ${request.requestId} for model ${request.model}`);
    await writer.sendStreamStart(request.requestId);
    for (let i = 1; i <= 3; i++) {
      await writer.sendStreamChunk(request.requestId, `hello chunk ${i}`);
    }
    await writer.sendStreamEnd(request.requestId, {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    });
    console.log(`[PROVIDER] Completed request ${request.requestId}`);
  });

  // Announce a fake provider record.
  const registry = new ProviderRegistry(node);
  const announcement: ProviderAnnouncement = {
    peerId: peerId.toString(),
    walletAddress: '0x000000000000000000000000000000000000dEaD',
    publicKey: '0x'.padEnd(66, '0'),
    models: [
      {
        model: 'claude-opus-4-5',
        inputPer1m: 1,
        outputPer1m: 5,
      },
    ],
    region: 'local',
    maxConcurrent: 10,
    stakeAmount: 0n,
    reputation: {
      score: 100,
      totalTransactions: 0,
      successRate: 1,
      avgLatencyMs: 50,
    },
    timestamp: Date.now(),
    signature: '0xfake',
  };

  try {
    await registry.announce(announcement);
  } catch (err) {
    console.error('[PROVIDER] announce failed (non-fatal in 2-node net):', (err as Error).message);
  }

  try {
    registry.startHeartbeat(10_000);
  } catch (err) {
    console.error('[PROVIDER] heartbeat failed:', (err as Error).message);
  }

  console.log('[PROVIDER] READY');

  const shutdown = async () => {
    console.log('[PROVIDER] Shutting down...');
    registry.stopHeartbeat();
    await node.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[PROVIDER] fatal:', err);
  process.exit(1);
});

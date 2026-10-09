/**
 * Integration test: Consumer process.
 * Dials a provider (multiaddr from argv[2]) and verifies the streamed
 * inference response sequence over /clawmarket/inference/2.0.0.
 */

import { createLibp2p } from 'libp2p';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { kadDHT } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { multiaddr } from '@multiformats/multiaddr';
import { randomUUID } from 'node:crypto';
import { StreamHandler } from '../../src/stream-handler.js';
import { ProviderRegistry } from '../../src/provider-registry.js';
import { ConsumerRouter } from '../../src/consumer-router.js';
import type { InferenceRequest, ProtocolMessage } from '@clawmarket/shared';
import { padHex } from 'viem';

async function main() {
  const providerMaStr = process.argv[2];
  if (!providerMaStr) {
    console.error('[CONSUMER] Usage: consumer-process.ts <providerMultiaddr>');
    process.exit(2);
  }

  const privateKey = await generateKeyPair('Ed25519');

  const node = await createLibp2p({
    privateKey,
    addresses: {
      listen: ['/ip4/127.0.0.1/tcp/4201', '/ip4/127.0.0.1/tcp/4202/ws'],
    },
    transports: [tcp(), webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      ping: ping(),
      dht: kadDHT({ clientMode: true }),
    },
  });

  await node.start();
  console.log(`[CONSUMER] PeerId: ${node.peerId.toString()}`);

  const providerMa = multiaddr(providerMaStr);
  const providerPeerIdStr = providerMa.getPeerId();
  if (!providerPeerIdStr) {
    console.error('[CONSUMER] provider multiaddr must include /p2p/<peerid>');
    process.exit(2);
  }

  console.log(`[CONSUMER] Dialing ${providerMaStr}`);
  await node.dial(providerMa);
  console.log('[CONSUMER] Connected to provider');

  // Give DHT a moment to settle (not strictly needed since we bypass DHT discovery).
  await new Promise((r) => setTimeout(r, 1500));

  // --- Optional DHT discovery check (non-fatal; 2-node DHT is often sparse) ---
  const registry = new ProviderRegistry(node);
  const router = new ConsumerRouter(node, registry);
  let dhtFoundCount = 0;
  try {
    const found = await Promise.race([
      router.findProviders('claude-opus-4-5'),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('dht timeout')), 5000)),
    ]);
    dhtFoundCount = found.length;
    console.log(`[CONSUMER] DHT findProviders returned ${dhtFoundCount} candidate(s)`);
  } catch (err) {
    console.log(`[CONSUMER] DHT discovery skipped/failed (non-fatal): ${(err as Error).message}`);
  }

  // --- Main assertion path: send request directly via StreamHandler ---
  const handler = new StreamHandler(node);
  const request: InferenceRequest = {
    type: 'request',
    requestId: randomUUID(),
    buyerPublicKey: '0x'.padEnd(66, '0'),
    buyerAddress: '0x000000000000000000000000000000000000bEEf',
    model: 'claude-opus-4-5',
    authorization: {
      buyer: '0x000000000000000000000000000000000000bEEf',
      seller: '0x000000000000000000000000000000000000cAFE',
      amount: 1000n,
      nonce: 1n,
      expiresAt: Math.floor(Date.now() / 1000) + 900,
      poolId: padHex('0x1', { size: 32 }),
      signature: ('0x' + 'b'.repeat(130)) as `0x${string}`,
    },
    payload: Buffer.from('test').toString('base64'),
    timestamp: Date.now(),
  };

  console.log(`[CONSUMER] Sending request ${request.requestId}`);
  const messages: ProtocolMessage[] = [];
  for await (const msg of handler.sendRequest(providerPeerIdStr, request)) {
    console.log(`[CONSUMER] <- ${msg.type}${msg.type === 'stream_chunk' ? ` payload="${msg.payload}"` : ''}`);
    messages.push(msg);
    if (messages.length > 10) break; // safety
  }

  // Assert sequence: stream_start -> 3x stream_chunk -> stream_end
  const types = messages.map((m) => m.type);
  const expected = ['stream_start', 'stream_chunk', 'stream_chunk', 'stream_chunk', 'stream_end'];
  const ok =
    types.length === expected.length && types.every((t, i) => t === expected[i]);

  // Also check chunk payloads
  const chunkPayloads = messages.filter((m) => m.type === 'stream_chunk').map((m) => m.payload);
  const chunkOk =
    chunkPayloads.length === 3 &&
    chunkPayloads.every((p, i) => p === `hello chunk ${i + 1}`);

  await node.stop().catch(() => {});

  if (ok && chunkOk) {
    console.log(`[CONSUMER] PASS — observed sequence: ${types.join(' -> ')}`);
    console.log(`[CONSUMER] DHT candidates found: ${dhtFoundCount}`);
    process.exit(0);
  } else {
    console.error(`[CONSUMER] FAIL — expected ${expected.join(' -> ')}, got ${types.join(' -> ')}`);
    console.error(`[CONSUMER] chunk payloads: ${JSON.stringify(chunkPayloads)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[CONSUMER] fatal:', err);
  process.exit(1);
});

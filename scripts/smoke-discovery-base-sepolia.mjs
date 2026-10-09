import http from 'node:http';
import net from 'node:net';
import { Wallet } from 'ethers';

import {
  importDist,
  runBuild,
  createAnnounceAddresses,
  createProviderNodeAdapter,
  createShareableBootstrapPeers,
  DEFAULT_CHAIN_ID,
  DEFAULT_ESCROW_POOL_ADDRESS,
  DEFAULT_RPC_URL,
} from './lib/testnet-runtime.mjs';

const MODEL_ID = 'gpt-4o-mini';

async function main() {
  const cleanupTasks = [];

  try {
    await runBuild();

    const buyerPrivateKey = process.env.BUYER_PRIVATE_KEY;
    const providerPrivateKey = process.env.PROVIDER_PRIVATE_KEY;
    if (!buyerPrivateKey || !providerPrivateKey) throw new Error('Provide signing keys through private runtime configuration');
    const buyerAddress = process.env.BUYER_ADDRESS ?? new Wallet(buyerPrivateKey).address;
    const providerAddress = process.env.PROVIDER_ADDRESS ?? new Wallet(providerPrivateKey).address;
    const escrowPoolAddress = process.env.ESCROW_POOL_ADDRESS ?? DEFAULT_ESCROW_POOL_ADDRESS;

    const consumerPkg = await importDist('packages/consumer-gateway/dist/index.js');
    const providerPkg = await importDist('packages/provider-gateway/dist/index.js');
    const p2pPkg = await importDist('packages/p2p-node/dist/index.js');

    const proxyServer = createFakeProxyServer();
    const proxyPort = await listenServer(proxyServer);
    cleanupTasks.push(() => closeServer(proxyServer));

    const bootstrapPort = await findAvailablePortPair();
    const providerPort = await findAvailablePortPair();
    const consumerPort = await findAvailablePortPair();
    const gatewayPort = await findAvailablePort();

    const bootstrapNode = await p2pPkg.createNode({
      listenHost: '127.0.0.1',
      listenPort: bootstrapPort,
      announceAddresses: createAnnounceAddresses('127.0.0.1', bootstrapPort),
      enableRelay: true,
      bootstrapPeers: [],
    });
    await bootstrapNode.start();
    cleanupTasks.push(() => bootstrapNode.stop());
    const bootstrapPeers = createShareableBootstrapPeers(bootstrapNode.peerId.toString(), '127.0.0.1', bootstrapPort);

    const beforeBalance = await callUint256(
      escrowPoolAddress,
      'getAvailableBalance(address)(uint256)',
      [buyerAddress],
    );
    const beforeNonce = await callUint256(
      escrowPoolAddress,
      'getNonce(address,address)(uint256)',
      [buyerAddress, providerAddress],
    );

    const providerNode = await p2pPkg.createNode({
      listenHost: '127.0.0.1',
      listenPort: providerPort,
      bootstrapPeers,
      announceAddresses: createAnnounceAddresses('127.0.0.1', providerPort),
    });
    const providerGateway = new providerPkg.ProviderGateway(
      {
        privateKey: providerPrivateKey,
        proxyUrl: `http://127.0.0.1:${proxyPort}`,
        models: [{ model: MODEL_ID, inputPer1m: 80, outputPer1m: 80 }],
        dailyLimitUsd: 250,
        escrowPoolAddress,
        claimBatchMaxSize: 1,
        claimFlushIntervalMs: 5_000,
        rpcUrl: DEFAULT_RPC_URL,
        chainId: DEFAULT_CHAIN_ID,
        bootstrapPeers,
      },
      async () => createProviderNodeAdapter(providerNode),
    );
    await providerGateway.start();
    cleanupTasks.push(() => providerGateway.stop());
    await providerNode.libp2p.dial(bootstrapNode.libp2p.getMultiaddrs()[0]);

    const providerRegistry = new p2pPkg.ProviderRegistry(providerNode.libp2p);
    await providerRegistry.announce({
      peerId: providerNode.peerId.toString(),
      walletAddress: providerAddress,
      publicKey: providerGateway.publicKey,
      models: [{ model: MODEL_ID, inputPer1m: 80, outputPer1m: 80 }],
      region: 'base-sepolia',
      maxConcurrent: 5,
      stakeAmount: 0n,
      reputation: {
        score: 100,
        totalTransactions: 0,
        successRate: 1,
        avgLatencyMs: 25,
      },
      timestamp: Date.now(),
      signature: '0xsmoke',
    });
    providerRegistry.startHeartbeat(15_000);

    const consumerNode = await p2pPkg.createNode({
      listenHost: '127.0.0.1',
      listenPort: consumerPort,
      bootstrapPeers,
      announceAddresses: createAnnounceAddresses('127.0.0.1', consumerPort),
    });
    await consumerNode.start();
    cleanupTasks.push(() => consumerNode.stop());
    await consumerNode.libp2p.dial(bootstrapNode.libp2p.getMultiaddrs()[0]);

    const consumerRegistry = new p2pPkg.ProviderRegistry(consumerNode.libp2p);
    const discoveryRouter = new p2pPkg.ConsumerRouter(consumerNode.libp2p, consumerRegistry, {
      maxPriceInputPer1m: 100,
      maxPriceOutputPer1m: 100,
      strategy: 'balanced',
    });
    const router = new consumerPkg.P2PRouter(discoveryRouter);

    await waitForProviderDiscovery(router, MODEL_ID);

    const wallet = new consumerPkg.WalletManager(DEFAULT_RPC_URL, DEFAULT_CHAIN_ID);
    const streamHandler = new p2pPkg.StreamHandler(consumerNode.libp2p);
    const consumerGateway = new consumerPkg.ConsumerGateway(
      {
        privateKey: buyerPrivateKey,
        port: gatewayPort,
        maxPriceInputPer1m: 100,
        maxPriceOutputPer1m: 100,
        routingStrategy: 'balanced',
        escrowPoolAddress,
        rpcUrl: DEFAULT_RPC_URL,
        chainId: DEFAULT_CHAIN_ID,
        bootstrapPeers,
      },
      router,
      wallet,
      streamHandler,
    );
    await consumerGateway.start();
    cleanupTasks.push(() => consumerGateway.stop());

    await waitForHealth(`http://127.0.0.1:${gatewayPort}/health`);
    const smokeResult = await runChatCompletionSmoke(gatewayPort);
    if (smokeResult.content !== 'Discovery smoke test passed.') {
      throw new Error(`Unexpected assistant content: ${smokeResult.content}`);
    }

    const afterNonce = await pollForNonceIncrease(beforeNonce, escrowPoolAddress, buyerAddress, providerAddress);
    const afterBalance = await callUint256(
      escrowPoolAddress,
      'getAvailableBalance(address)(uint256)',
      [buyerAddress],
    );

    console.log('');
    console.log('DISCOVERY + BASE SEPOLIA SMOKE PASSED');
    console.log(`Bootstrap peer:     ${bootstrapPeers[0]}`);
    console.log(`EscrowPool:         ${escrowPoolAddress}`);
    console.log(`Buyer:              ${buyerAddress}`);
    console.log(`Provider:           ${providerAddress}`);
    console.log(`Consumer gateway:   http://127.0.0.1:${gatewayPort}`);
    console.log(`Assistant reply:    ${smokeResult.content}`);
    console.log(`Nonce:              ${beforeNonce} -> ${afterNonce}`);
    console.log(`Pool balance:       ${beforeBalance} -> ${afterBalance}`);
  } finally {
    for (const cleanup of cleanupTasks.reverse()) {
      try {
        await cleanup();
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}

async function waitForProviderDiscovery(router, model) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const providers = await router.findProviders(model);
    if (providers.length > 0) {
      return providers;
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for provider discovery for ${model}`);
}

async function runChatCompletionSmoke(gatewayPort) {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      stream: true,
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: 'Say the exact phrase: Discovery smoke test passed.',
        },
      ],
    }),
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`Smoke request failed (${response.status}): ${text}`);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';
  let content = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const event of events) {
      const lines = event.split('\n').map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') continue;
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') {
          content += delta;
        }
        if (parsed.error) {
          throw new Error(parsed.error.message ?? 'Unknown upstream error');
        }
      }
    }
  }

  return { content };
}

async function pollForNonceIncrease(beforeNonce, escrowPoolAddress, buyerAddress, providerAddress) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = await callUint256(
      escrowPoolAddress,
      'getNonce(address,address)(uint256)',
      [buyerAddress, providerAddress],
    );
    if (current > beforeNonce) {
      return current;
    }
    await delay(1_000);
  }

  throw new Error('Timed out waiting for claim nonce to increase');
}

async function callUint256(contract, signature, args) {
  const { spawn } = await import('node:child_process');
  return await new Promise((resolve, reject) => {
    const child = spawn('cast', [
      'call',
      contract,
      signature,
      ...args,
      '--rpc-url',
      DEFAULT_RPC_URL,
    ], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: process.env,
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`cast call failed with code ${code}`));
        return;
      }
      resolve(BigInt(stdout.trim().split(' ')[0]));
    });
    child.on('error', reject);
  });
}

function createFakeProxyServer() {
  return http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    for await (const _chunk of req) {
      // consume request body
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    for (const chunk of ['Discovery ', 'smoke ', 'test ', 'passed.']) {
      res.write(`data: ${JSON.stringify({
        id: 'discovery-smoke-proxy',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
      })}\n\n`);
      await delay(25);
    }

    res.write(`data: ${JSON.stringify({
      usage: {
        prompt_tokens: 8,
        completion_tokens: 4,
        total_tokens: 12,
      },
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

async function listenServer(server) {
  return await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to determine listening port'));
        return;
      }
      resolve(address.port);
    });
    server.on('error', reject);
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function findAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate port'));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
    server.on('error', reject);
  });
}

async function findAvailablePortPair() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const base = 30000 + Math.floor(Math.random() * 20000);
    const first = await isPortAvailable(base);
    const second = await isPortAvailable(base + 1);
    if (first && second) return base;
  }
  throw new Error('Unable to find available port pair');
}

async function isPortAvailable(port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function waitForHealth(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error('');
  console.error('DISCOVERY + BASE SEPOLIA SMOKE FAILED');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

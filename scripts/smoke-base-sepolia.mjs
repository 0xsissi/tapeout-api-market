import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Wallet } from 'ethers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const RPC_URL = 'https://sepolia.base.org';
const CHAIN_ID = 84532;
const DEFAULT_ESCROW_POOL_ADDRESS = '0x8A392a77eb88f477FeF060033937a2e4692Eb56E';
const MODEL_ID = 'gpt-4o-mini';
const DEFAULT_PROMPT = 'Say the exact phrase: Base Sepolia smoke test passed.';
const DEFAULT_EXPECTED_REPLY = 'Base Sepolia smoke test passed.';

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
    const externalProxyUrl = process.env.PROXY_URL ?? '';
    const proxyHeaders = process.env.PROXY_HEADERS_JSON ? JSON.parse(process.env.PROXY_HEADERS_JSON) : undefined;
    const selectedModel = process.env.PROXY_MODEL ?? MODEL_ID;
    const smokePrompt = process.env.SMOKE_PROMPT ?? DEFAULT_PROMPT;
    const expectedReply = process.env.SMOKE_EXPECTED_REPLY ?? DEFAULT_EXPECTED_REPLY;

    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-base-smoke-'));
    cleanupTasks.push(() => rm(tempHome, { recursive: true, force: true }));
    process.env.HOME = tempHome;

    const consumerPkg = await importDist('packages/consumer-gateway/dist/index.js');
    const providerPkg = await importDist('packages/provider-gateway/dist/index.js');
    const p2pPkg = await importDist('packages/p2p-node/dist/index.js');

    let providerProxyUrl = externalProxyUrl;
    if (!providerProxyUrl) {
      const proxyServer = createFakeProxyServer();
      const proxyPort = await listenServer(proxyServer);
      cleanupTasks.push(() => closeServer(proxyServer));
      providerProxyUrl = `http://127.0.0.1:${proxyPort}`;
    }

    const providerPort = await findAvailablePortPair();
    const consumerPort = await findAvailablePortPair();
    const gatewayPort = await findAvailablePort();

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
      bootstrapPeers: [],
    });
    const providerNodeAdapter = createProviderNodeAdapter(providerNode);

    const providerGateway = new providerPkg.ProviderGateway(
      {
        privateKey: providerPrivateKey,
        proxyUrl: providerProxyUrl,
        proxyHeaders,
        models: [
          {
            model: selectedModel,
            inputPer1m: 80,
            outputPer1m: 80,
          },
        ],
        dailyLimitUsd: 250,
        escrowPoolAddress: escrowPoolAddress,
        claimBatchMaxSize: 1,
        claimFlushIntervalMs: 5_000,
        rpcUrl: RPC_URL,
        chainId: CHAIN_ID,
        bootstrapPeers: [],
      },
      async () => providerNodeAdapter,
    );
    await providerGateway.start();
    cleanupTasks.push(() => providerGateway.stop());

    const providerAnnouncement = {
      peerId: providerNode.peerId.toString(),
      walletAddress: providerAddress,
      publicKey: providerGateway.publicKey,
      models: [
        {
          model: selectedModel,
          inputPer1m: 80,
          outputPer1m: 80,
        },
      ],
      region: 'base-sepolia',
      maxConcurrent: 5,
      stakeAmount: 0n,
      reputation: {
        score: 100,
        totalTransactions: 0,
        successRate: 1,
        avgLatencyMs: 50,
      },
      timestamp: Date.now(),
      signature: '0xsmoke',
    };

    const consumerNode = await p2pPkg.createNode({
      listenHost: '127.0.0.1',
      listenPort: consumerPort,
      bootstrapPeers: [],
    });
    await consumerNode.start();
    cleanupTasks.push(() => consumerNode.stop());

    await consumerNode.libp2p.dial(providerNode.libp2p.getMultiaddrs()[0]);

    const router = new consumerPkg.P2PRouter({
      async findProviders(model) {
        if (model !== selectedModel) return [];
        return [
          {
            announcement: providerAnnouncement,
            modelPricing: providerAnnouncement.models[0],
            score: 100,
          },
        ];
      },
    });

    const wallet = new consumerPkg.WalletManager(RPC_URL, CHAIN_ID);
    const streamHandler = new p2pPkg.StreamHandler(consumerNode.libp2p);

    const consumerGateway = new consumerPkg.ConsumerGateway(
      {
        privateKey: buyerPrivateKey,
        port: gatewayPort,
        maxPriceInputPer1m: 100,
        maxPriceOutputPer1m: 100,
        routingStrategy: 'balanced',
        escrowPoolAddress: escrowPoolAddress,
        rpcUrl: RPC_URL,
        chainId: CHAIN_ID,
        bootstrapPeers: [],
      },
      router,
      wallet,
      streamHandler,
    );
    await consumerGateway.start();
    cleanupTasks.push(() => consumerGateway.stop());

    await waitForHealth(`http://127.0.0.1:${gatewayPort}/health`);
    const smokeResult = await runChatCompletionSmoke(gatewayPort, selectedModel, smokePrompt);
    if (smokeResult.content !== expectedReply) {
      throw new Error(`Unexpected assistant content: ${smokeResult.content}`);
    }

    const afterNonce = await pollForNonceIncrease(beforeNonce, escrowPoolAddress, buyerAddress, providerAddress);
    const afterBalance = await callUint256(
      escrowPoolAddress,
      'getAvailableBalance(address)(uint256)',
      [buyerAddress],
    );

    console.log('');
    console.log('BASE SEPOLIA SMOKE PASSED');
    console.log(`EscrowPool:         ${escrowPoolAddress}`);
    console.log(`Buyer:              ${buyerAddress}`);
    console.log(`Provider:           ${providerAddress}`);
    console.log(`Consumer gateway:   http://127.0.0.1:${gatewayPort}`);
    console.log(`Assistant reply:    ${smokeResult.content}`);
    console.log(`Usage:              prompt=${smokeResult.usage.prompt_tokens}, completion=${smokeResult.usage.completion_tokens}, total=${smokeResult.usage.total_tokens}`);
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

async function runBuild() {
  console.log('Building workspace packages...');
  await runCommand('corepack', ['pnpm', '-r', 'build']);
}

async function runChatCompletionSmoke(gatewayPort, model, prompt) {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: prompt,
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
  let usage = null;

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
        if (parsed.usage) {
          usage = parsed.usage;
        }
        if (parsed.error) {
          throw new Error(parsed.error.message ?? 'Unknown upstream error');
        }
      }
    }
  }

  if (!usage) {
    throw new Error('Smoke request completed without usage data');
  }

  return { content, usage };
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
  const output = await runCommandCapture('cast', [
    'call',
    contract,
    signature,
    ...args,
    '--rpc-url',
    RPC_URL,
  ]);
  return BigInt(output.trim().split(' ')[0]);
}

function createFakeProxyServer() {
  return http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    await readRequestBody(req);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const chunks = ['Base ', 'Sepolia ', 'smoke ', 'test ', 'passed.'];
    for (const chunk of chunks) {
      res.write(`data: ${JSON.stringify({
        id: 'base-sepolia-proxy',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
      })}\n\n`);
      await delay(25);
    }

    res.write(`data: ${JSON.stringify({
      usage: {
        prompt_tokens: 14,
        completion_tokens: 5,
        total_tokens: 19,
      },
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

function createProviderNodeAdapter(node) {
  return {
    peerId: node.peerId,
    async start() {
      await node.start();
    },
    async stop() {
      await node.stop();
    },
    handle(protocol, handler) {
      node.libp2p.handle(protocol, (stream, connection) => {
        const wrappedStream = {
          source: stream,
          async sink(source) {
            for await (const chunk of source) {
              const bytes = chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk);
              const ok = stream.send(bytes);
              if (!ok) {
                await stream.onDrain();
              }
            }
            await stream.close();
          },
          close() {
            return stream.close();
          },
        };

        return handler({ stream: wrappedStream, connection });
      });
    },
    getMultiaddrs() {
      return node.libp2p.getMultiaddrs();
    },
    contentRouting: {
      provide(key) {
        return node.libp2p.contentRouting.provide(key);
      },
    },
  };
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

async function importDist(relativePath) {
  const fullPath = path.join(repoRoot, relativePath);
  return import(`${pathToFileURL(fullPath).href}?t=${Date.now()}`);
}

async function runCommand(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`)));
    child.on('error', reject);
  });
}

async function runCommandCapture(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: process.env,
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.on('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`)));
    child.on('error', reject);
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

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error('');
  console.error('BASE SEPOLIA SMOKE FAILED');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

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

const buyerFixtureWallet = Wallet.createRandom(), providerFixtureWallet = Wallet.createRandom();
const BUYER_PRIVATE_KEY = buyerFixtureWallet.privateKey;
const BUYER_ADDRESS = buyerFixtureWallet.address;
const PROVIDER_PRIVATE_KEY = providerFixtureWallet.privateKey;
const PROVIDER_ADDRESS = providerFixtureWallet.address;
const ESCROW_POOL_ADDRESS = '0x1111111111111111111111111111111111111111';
const CHAIN_ID = 31337;
const MODEL_ID = 'gpt-4o-mini';
const GET_AVAILABLE_BALANCE_SELECTOR = '0x6c24a76f';
const GET_NONCE_SELECTOR = '0xd828435d';

async function main() {
  const cleanupTasks = [];

  try {
    await runBuild();

    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-smoke-'));
    cleanupTasks.push(() => rm(tempHome, { recursive: true, force: true }));
    process.env.HOME = tempHome;

    const consumerPkg = await importDist('packages/consumer-gateway/dist/index.js');
    const providerPkg = await importDist('packages/provider-gateway/dist/index.js');
    const p2pPkg = await importDist('packages/p2p-node/dist/index.js');

    const rpcState = {
      balances: new Map([[BUYER_ADDRESS.toLowerCase(), 25_000_000n]]),
      nonces: new Map(),
    };

    const rpcServer = createFakeRpcServer(rpcState);
    const rpcPort = await listenServer(rpcServer);
    cleanupTasks.push(() => closeServer(rpcServer));

    const proxyServer = createFakeProxyServer();
    const proxyPort = await listenServer(proxyServer);
    cleanupTasks.push(() => closeServer(proxyServer));

    const providerPort = await findAvailablePortPair();
    const consumerPort = await findAvailablePortPair();
    const gatewayPort = await findAvailablePort();

    const providerNode = await p2pPkg.createNode({
      listenHost: '127.0.0.1',
      listenPort: providerPort,
      bootstrapPeers: [],
    });
    const providerNodeAdapter = createProviderNodeAdapter(providerNode);

    const providerGateway = new providerPkg.ProviderGateway(
      {
        privateKey: PROVIDER_PRIVATE_KEY,
        proxyUrl: `http://127.0.0.1:${proxyPort}`,
        models: [
          {
            model: MODEL_ID,
            inputPer1m: 80,
            outputPer1m: 80,
          },
        ],
        dailyLimitUsd: 250,
        escrowPoolAddress: ESCROW_POOL_ADDRESS,
        claimBatchMaxSize: 999,
        claimFlushIntervalMs: 60_000,
        rpcUrl: `http://127.0.0.1:${rpcPort}`,
        chainId: CHAIN_ID,
        bootstrapPeers: [],
      },
      async () => providerNodeAdapter,
    );
    await providerGateway.start();
    cleanupTasks.push(() => providerGateway.stop());

    const providerAnnouncement = {
      peerId: providerNode.peerId.toString(),
      walletAddress: PROVIDER_ADDRESS,
      publicKey: providerGateway.publicKey,
      models: [
        {
          model: MODEL_ID,
          inputPer1m: 80,
          outputPer1m: 80,
        },
      ],
      region: 'local-smoke',
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

    const providerAddr = providerNode.libp2p.getMultiaddrs()[0];
    await consumerNode.libp2p.dial(providerAddr);

    const reliableConsumerRouter = {
      async findProviders(model) {
        if (model !== MODEL_ID) {
          return [];
        }
        return [
          {
            announcement: providerAnnouncement,
            modelPricing: providerAnnouncement.models[0],
            score: 100,
          },
        ];
      },
    };

    const router = new consumerPkg.P2PRouter(reliableConsumerRouter);
    const wallet = new consumerPkg.WalletManager(`http://127.0.0.1:${rpcPort}`, CHAIN_ID);
    const streamHandler = new p2pPkg.StreamHandler(consumerNode.libp2p);

    const consumerGateway = new consumerPkg.ConsumerGateway(
      {
        privateKey: BUYER_PRIVATE_KEY,
        port: gatewayPort,
        maxPriceInputPer1m: 100,
        maxPriceOutputPer1m: 100,
        routingStrategy: 'balanced',
        escrowPoolAddress: ESCROW_POOL_ADDRESS,
        rpcUrl: `http://127.0.0.1:${rpcPort}`,
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

    const modelsResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`);
    const modelsJson = await modelsResponse.json();
    const modelIds = new Set((modelsJson.data ?? []).map((item) => item.id));
    if (!modelIds.has(MODEL_ID)) {
      throw new Error(`/v1/models did not expose ${MODEL_ID}`);
    }

    const smokeResult = await runChatCompletionSmoke(gatewayPort);
    if (smokeResult.content !== 'Local smoke test passed.') {
      throw new Error(`Unexpected assistant content: ${smokeResult.content}`);
    }

    console.log('');
    console.log('SMOKE TEST PASSED');
    console.log(`Consumer gateway: http://127.0.0.1:${gatewayPort}`);
    console.log(`Provider proxy:    http://127.0.0.1:${proxyPort}`);
    console.log(`Fake RPC:          http://127.0.0.1:${rpcPort}`);
    console.log(`Models:            ${Array.from(modelIds).join(', ')}`);
    console.log(`Assistant reply:   ${smokeResult.content}`);
    console.log(`Usage:             prompt=${smokeResult.usage.prompt_tokens}, completion=${smokeResult.usage.completion_tokens}, total=${smokeResult.usage.total_tokens}`);
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
          content: 'Say the exact phrase: Local smoke test passed.',
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
      const lines = event
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') {
          continue;
        }

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

    const chunks = ['Local ', 'smoke ', 'test ', 'passed.'];
    for (const chunk of chunks) {
      res.write(`data: ${JSON.stringify({
        id: 'smoke-proxy',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
      })}\n\n`);
      await delay(15);
    }

    res.write(`data: ${JSON.stringify({
      usage: {
        prompt_tokens: 12,
        completion_tokens: 4,
        total_tokens: 16,
      },
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

function createFakeRpcServer(state) {
  return http.createServer(async (req, res) => {
    try {
      const body = JSON.parse(await readRequestBody(req));
      const payloads = Array.isArray(body) ? body : [body];
      const responses = payloads.map((payload) => handleRpcPayload(payload, state));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(body) ? responses : responses[0]));
    } catch (error) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      }));
    }
  });
}

function handleRpcPayload(payload, state) {
  const method = payload.method;
  const params = payload.params ?? [];
  let result;

  switch (method) {
    case 'eth_chainId':
      result = toRpcQuantity(BigInt(CHAIN_ID));
      break;
    case 'net_version':
      result = String(CHAIN_ID);
      break;
    case 'eth_blockNumber':
      result = '0x1';
      break;
    case 'eth_call':
      result = handleEthCall(params[0] ?? {}, state);
      break;
    default:
      throw new Error(`Unsupported RPC method: ${method}`);
  }

  return { jsonrpc: '2.0', id: payload.id ?? 1, result };
}

function handleEthCall(call, state) {
  const to = (call.to ?? '').toLowerCase();
  const data = (call.data ?? '').toLowerCase();
  if (to !== ESCROW_POOL_ADDRESS.toLowerCase()) {
    throw new Error(`Unknown contract address: ${call.to}`);
  }

  if (data.startsWith(GET_AVAILABLE_BALANCE_SELECTOR)) {
    const buyer = decodeAddressWord(data.slice(10, 74));
    const balance = state.balances.get(buyer.toLowerCase()) ?? 0n;
    return toAbiUint256(balance);
  }

  if (data.startsWith(GET_NONCE_SELECTOR)) {
    const buyer = decodeAddressWord(data.slice(10, 74));
    const seller = decodeAddressWord(data.slice(74, 138));
    const nonce = state.nonces.get(`${buyer.toLowerCase()}:${seller.toLowerCase()}`) ?? 0n;
    return toAbiUint256(nonce);
  }

  throw new Error(`Unsupported call data: ${data.slice(0, 10)}`);
}

function decodeAddressWord(word) {
  return `0x${word.slice(-40)}`;
}

function toAbiUint256(value) {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function toRpcQuantity(value) {
  return `0x${value.toString(16)}`;
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
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until timeout.
    }
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

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      }
    });

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
  if (!server.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
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
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on('error', reject);
  });
}

async function findAvailablePortPair() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const base = 30000 + Math.floor(Math.random() * 20000);
    const first = await isPortAvailable(base);
    const second = await isPortAvailable(base + 1);
    if (first && second) {
      return base;
    }
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
  console.error('SMOKE TEST FAILED');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

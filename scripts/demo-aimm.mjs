import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const rootDir = process.cwd();
const demoRoot = path.join(os.tmpdir(), 'clawmarket-aimm-demo');
const bootstrapPort = Number(process.env.DEMO_BOOTSTRAP_PORT ?? '29090');
const buyerPort = Number(process.env.DEMO_BUYER_PORT ?? '28080');
const buyerP2pPort = Number(process.env.DEMO_BUYER_P2P_PORT ?? '29091');
const cliproxySourceDir = process.env.DEMO_CLIPROXY_SOURCE_DIR ?? process.env.CLIPROXY_SOURCE_DIR ?? '';
const cliproxyAuthDir = process.env.DEMO_CLIPROXY_AUTH_DIR ?? process.env.CLIPROXY_AUTH_DIR ?? '';
const providerKeys = parseProviderKeys(process.env.DEMO_PROVIDER_PRIVATE_KEYS_JSON);

const makers = [
  { name: 'Maker-A', p2pPort: 29100, statusPort: 28101, cliproxyPort: 4311, p0: 2.0, alpha: 1.0, maxConcurrent: 5 },
  { name: 'Maker-B', p2pPort: 29110, statusPort: 28102, cliproxyPort: 4312, p0: 2.5, alpha: 0.8, maxConcurrent: 5 },
  { name: 'Maker-C', p2pPort: 29120, statusPort: 28103, cliproxyPort: 4313, p0: 1.8, alpha: 1.5, maxConcurrent: 4 },
];

async function main() {
  if (!cliproxySourceDir || !cliproxyAuthDir) {
    throw new Error('Set DEMO_CLIPROXY_SOURCE_DIR and DEMO_CLIPROXY_AUTH_DIR before running demo-aimm.');
  }
  if (providerKeys.length < makers.length) {
    throw new Error(`Need at least ${makers.length} provider private keys in DEMO_PROVIDER_PRIVATE_KEYS_JSON.`);
  }

  await mkdir(demoRoot, { recursive: true });

  const bootstrap = spawnLogged('bootstrap', ['node', 'scripts/run-bootstrap.mjs'], {
    cwd: rootDir,
    env: {
      ...process.env,
      P2P_LISTEN_PORT: String(bootstrapPort),
      SKIP_PNPM_BUILD: process.env.SKIP_PNPM_BUILD ?? '1',
    },
  });

  const bootstrapPeer = `/ip4/127.0.0.1/tcp/${bootstrapPort}/p2p/BOOTSTRAP_PLACEHOLDER`;
  console.log(`[demo] bootstrap starting on tcp/${bootstrapPort}`);
  console.log('[demo] If your bootstrap peer id differs, export BOOTSTRAP_PEERS manually before rerunning.');

  const spawned = [bootstrap];
  for (const [index, maker] of makers.entries()) {
    const workDir = path.join(demoRoot, maker.name.toLowerCase());
    await mkdir(workDir, { recursive: true });
    console.log(
      `[${maker.name}] configured p0=$${maker.p0}, alpha=${maker.alpha}, maxConcurrent=${maker.maxConcurrent}`,
    );

    spawned.push(
      spawnLogged(maker.name, ['node', 'scripts/run-provider-testnet.mjs'], {
        cwd: rootDir,
        env: {
          ...process.env,
          PROVIDER_PRIVATE_KEY: providerKeys[index],
          EMBED_CLIPROXY: 'true',
          SELLER_UPSTREAM: process.env.DEMO_SELLER_UPSTREAM ?? 'codex',
          CLIPROXY_SOURCE_DIR: cliproxySourceDir,
          CLIPROXY_AUTH_DIR: cliproxyAuthDir,
          CLIPROXY_WORK_DIR: path.join(workDir, 'cliproxy'),
          CLIPROXY_PORT: String(maker.cliproxyPort),
          P2P_LISTEN_HOST: '127.0.0.1',
          P2P_LISTEN_PORT: String(maker.p2pPort),
          SIGNING_IDENTITY_PATH: path.join(workDir, 'seller-signing.key.json'),
          SELLER_STATUS_PORT: String(maker.statusPort),
          MAX_CONCURRENT: String(maker.maxConcurrent),
          AIMM_QUOTE_NETWORK_ID: 'demo',
          BOOTSTRAP_PEERS: process.env.BOOTSTRAP_PEERS ?? bootstrapPeer,
          MODELS_JSON: JSON.stringify([
            {
              model: process.env.DEMO_MODEL ?? 'gpt-5.4',
              inputPer1m: maker.p0,
              outputPer1m: maker.p0,
              p0: maker.p0,
              alpha: maker.alpha,
            },
          ]),
          SKIP_PNPM_BUILD: process.env.SKIP_PNPM_BUILD ?? '1',
        },
      }),
    );
  }

  spawned.push(
    spawnLogged('Buyer', ['node', 'scripts/run-consumer-testnet.mjs'], {
      cwd: rootDir,
      env: {
        ...process.env,
        CONSUMER_PORT: String(buyerPort),
        P2P_LISTEN_PORT: String(buyerP2pPort),
        AIMM_QUOTE_NETWORK_ID: 'demo',
        AIMM_SOFTMAX_BETA: process.env.AIMM_SOFTMAX_BETA ?? '3',
        REFRESH_MODELS: process.env.DEMO_MODEL ?? 'gpt-5.4',
        BOOTSTRAP_PEERS: process.env.BOOTSTRAP_PEERS ?? bootstrapPeer,
        SKIP_PNPM_BUILD: process.env.SKIP_PNPM_BUILD ?? '1',
      },
    }),
  );

  console.log('');
  console.log('[demo] started bootstrap + 3 makers + buyer');
  console.log(`[demo] buyer API: http://127.0.0.1:${buyerPort}/v1`);
  console.log('[demo] press Ctrl+C to stop all child processes');

  const shutdown = async () => {
    for (const child of spawned.reverse()) {
      child.kill('SIGINT');
    }
  };

  process.on('SIGINT', async () => {
    await shutdown();
    process.exit(0);
  });
}

function spawnLogged(label, command, options) {
  const child = spawn(command[0], command.slice(1), {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr?.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  child.once('exit', (code, signal) => {
    console.log(`[${label}] exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
  });
  return child;
}

function parseProviderKeys(raw) {
  if (!raw?.trim()) {
    return [];
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('DEMO_PROVIDER_PRIVATE_KEYS_JSON must be a JSON array.');
  }
  return parsed.map((value) => String(value));
}

main().catch((error) => {
  console.error(`[demo] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

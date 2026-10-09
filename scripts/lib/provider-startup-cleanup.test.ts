import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { expect, it } from 'vitest';

it('exits instead of leaving a P2P listener after the real provider script encounters an active ledger lock', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'tam-provider-startup-failure-'));
  const clock = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"peers":[]}'); });
  await new Promise<void>(resolve => clock.listen(0, '127.0.0.1', resolve));
  const clockPort = (clock.address() as net.AddressInfo).port;
  const freePort = async (port: number) => new Promise<boolean>(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
  });
  let p2pPort = 26190;
  while (!await freePort(p2pPort) || !await freePort(p2pPort + 1)) p2pPort += 2;
  const key = `0x${'11'.repeat(32)}`;
  const pool = '0x90D30bA5d3e72A029335D2B879786ba912EA6e5F';
  const ledger = path.join(home, '.clawmarket-provider', '97', pool.toLowerCase(), new Wallet(key).address.toLowerCase());
  await mkdir(ledger, { recursive: true });
  await writeFile(path.join(ledger, 'ledger.lock'), JSON.stringify({ pid: process.pid }));
  const child = spawn(process.execPath, ['scripts/run-provider-testnet.mjs'], {
    cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, TAM_HOME: home, CLAWMARKET_PAYMENT_NETWORK: 'bsc-testnet', CLAWMARKET_PAYMENT_TOKEN: 'USDC',
      PROVIDER_PRIVATE_KEY: key, EMBED_CLIPROXY: 'false', PROVIDER_BACKEND: 'proxy-url', PROXY_URL: `http://127.0.0.1:${clockPort}`,
      MODELS_JSON: '[{"model":"fixture","inputPer1m":1,"outputPer1m":1}]', SKIP_PNPM_BUILD: '1', AIMM_ACCOUNT_TIERS_JSON: '[]',
      ESCROW_POOL_ADDRESS: pool, RPC_URL: 'http://127.0.0.1:1', CHAIN_ID: '97', P2P_LISTEN_PORT: String(p2pPort),
      CLOCK_SKEW_URLS: `http://127.0.0.1:${clockPort}/clock`, BOOTSTRAP_MANIFEST_URLS: `http://127.0.0.1:${clockPort}/bootstrap`,
      BOOTSTRAP_PEERS: '/ip4/127.0.0.1/tcp/1/p2p/12D3KooWCXtcZc5RU74Q7sVLaVRVNPNkCCx6tUUvEMyApvKxRJrX',
      TAM_ADMISSION_ORIGIN: '', SELLER_STATUS_PORT: '0',
    },
  });
  let errors = ''; child.stderr?.on('data', value => { errors += value.toString(); }); child.stdout?.resume();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('exit', resolve);
      timer = setTimeout(() => reject(new Error('Provider kept running after failed startup')), 20_000);
    });
    expect(exitCode).toBe(1);
    expect(errors).toContain('Seller ledger is locked');
    expect(await freePort(p2pPort)).toBe(true);
    expect(await freePort(p2pPort + 1)).toBe(true);
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode == null) child.kill('SIGKILL');
    await new Promise<void>(resolve => clock.close(() => resolve()));
    // Only the directory created by this test may be removed.
    if (path.dirname(home) !== os.tmpdir() || !path.basename(home).startsWith('tam-provider-startup-failure-')) throw new Error('Unexpected fixture directory');
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);

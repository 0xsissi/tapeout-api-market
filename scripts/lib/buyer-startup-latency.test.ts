import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Interface } from 'ethers';
import { expect, it } from 'vitest';

it('opens the local buyer API while a bootstrap peer never completes its handshake', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'tam-buyer-startup-latency-'));
  const sockets = new Set<net.Socket>();
  const blackhole = net.createServer(socket => {
    sockets.add(socket); socket.resume(); socket.once('close', () => sockets.delete(socket));
    socket.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') throw error; });
  });
  await new Promise<void>(resolve => blackhole.listen(0, '127.0.0.1', resolve));
  const blackholePort = (blackhole.address() as net.AddressInfo).port;
  const pool = '0x90D30bA5d3e72A029335D2B879786ba912EA6e5F';
  const token = '0xFcc26b50731525a4452D0ED428cdf11058723B89';
  const abi = new Interface(['function usdc() view returns (address)', 'function decimals() view returns (uint8)']);
  const rpc = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'POST') { res.end('{"peers":[]}'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    const answer = (item: any) => {
      let result = item.method === 'eth_chainId' ? '0x61' : item.method === 'eth_getCode' ? '0x6000' : '0x0';
      if (item.method === 'eth_call') result = item.params[0].data.startsWith(abi.getFunction('usdc')!.selector)
        ? abi.encodeFunctionResult('usdc', [token]) : abi.encodeFunctionResult('decimals', [6]);
      return { jsonrpc: '2.0', id: item.id, result };
    };
    res.end(JSON.stringify(Array.isArray(request) ? request.map(answer) : answer(request)));
  });
  await new Promise<void>(resolve => rpc.listen(0, '127.0.0.1', resolve));
  const rpcPort = (rpc.address() as net.AddressInfo).port;
  const freePort = async (port: number) => new Promise<boolean>(resolve => {
    const socket = net.createServer(); socket.once('error', () => resolve(false));
    socket.listen(port, '127.0.0.1', () => socket.close(() => resolve(true)));
  });
  let gatewayPort = 28180, p2pPort = 28190;
  while (!await freePort(gatewayPort)) gatewayPort++;
  while (!await freePort(p2pPort) || !await freePort(p2pPort + 1)) p2pPort += 2;
  const began = Date.now();
  const child = spawn(process.execPath, ['scripts/run-consumer-testnet.mjs'], {
    cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, TAM_HOME: home, CLAWMARKET_PAYMENT_TOKEN: 'USDC', CLAWMARKET_PAYMENT_NETWORK: 'bsc-testnet',
      BUYER_PRIVATE_KEY: `0x${'11'.repeat(32)}`, CONSUMER_PORT: String(gatewayPort), P2P_LISTEN_PORT: String(p2pPort),
      RPC_URL: `http://127.0.0.1:${rpcPort}`, CHAIN_ID: '97', ESCROW_POOL_ADDRESS: pool, MAX_REQUEST_COST_TOKEN: '0.1',
      SKIP_PNPM_BUILD: '1', REFRESH_MODELS: 'fixture', DISCOVERABLE_MODELS: 'fixture', CLAW_SCHEDULER_ADMIN_PORT: '0',
      CLAW_SCHEDULER_CONFIG_PATH: path.join(home, 'scheduler.json'), CLAWMARKET_API_TOKEN: 'fixture-local-token-for-startup-test-123456',
      CLOCK_SKEW_URLS: `http://127.0.0.1:${rpcPort}/clock`, BOOTSTRAP_MANIFEST_URLS: '', BOOTSTRAP_MANIFEST_FILES: '',
      BOOTSTRAP_PEERS: `/ip4/127.0.0.1/tcp/${blackholePort}/p2p/12D3KooWCXtcZc5RU74Q7sVLaVRVNPNkCCx6tUUvEMyApvKxRJrX`,
      SEED_PROVIDERS_FILE: '', SEED_PROVIDERS_JSON: '', DISABLE_BOOTSTRAP_MAINTENANCE: '0',
    },
  });
  let errors = ''; child.stderr?.on('data', data => { errors += data.toString(); }); child.stdout?.resume();
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    let health: any;
    while (Date.now() - began < 8000) {
      if (child.exitCode != null) throw new Error(`Fixture buyer exited: ${errors}`);
      try { health = await (await fetch(`http://127.0.0.1:${gatewayPort}/health`, { signal: AbortSignal.timeout(300), headers: { connection: 'close' } })).json(); }
      catch {}
      if (health?.status === 'ok') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(health?.status, errors).toBe('ok');
    expect(health.chainId).toBe(97);
    expect(health.paymentToken.address).toBe(token);
    expect(health.escrowPool).toBe(pool);
    expect(Date.now() - began).toBeLessThan(8000); // A single unreachable peer otherwise consumes 10 seconds.
    expect(sockets.size).toBeGreaterThan(0);
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL'); await exited;
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise<void>(resolve => rpc.close(() => resolve())), new Promise<void>(resolve => blackhole.close(() => resolve()))]);
    if (path.dirname(home) !== os.tmpdir() || !path.basename(home).startsWith('tam-buyer-startup-latency-')) throw new Error('Unexpected fixture directory');
    await rm(home, { recursive: true, force: true });
  }
}, 15_000);

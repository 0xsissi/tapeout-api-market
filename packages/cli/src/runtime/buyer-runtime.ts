import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';

import type { ChildProcess } from 'node:child_process';
import { PAYMENT_TOKEN, PAYMENT_PORT_OFFSET } from '@clawmarket/shared';
import type { SettlementSettings } from '../config/schema.js';
import { prepareSettlementRuntime } from '../payment/runtime.js';
import { assertGatewaySettlement, checkGatewaySettlement } from '../payment/gateway.js';

import type { CliDefaults } from '../config/store.js';
import { fetchJson, getServiceStatus } from '../services/http.js';
import { addressFromPrivateKey } from '../services/chain.js';
import { spawnManagedProcess, stopProcessTree } from './process.js';
import { extractPortFromUrl, fileExists, normalizeUrl, waitForService } from '../utils.js';
import { ensureStoredWallet } from '../wallet/store.js';
import { createStartupMonitor, type StartupReporter } from './startup-progress.js';

interface ManagedBuyerRuntime {
  process: ChildProcess;
  logPath: string;
  url: string;
}

export interface StartBuyerOptions {
  settlement?: SettlementSettings;
  inputOverheadTokens?: number;
  url: string;
  identityPath: string;
  seedFile: string;
  walletPath: string;
  legacyWalletPath: string;
  logsDir: string;
  logPath: string;
  refreshModels: string[];
  discoverableModels: string[];
  bootstrapPeers: string[];
  report?: (message: string) => void;
  signal?: AbortSignal;
  onProgress?: StartupReporter;
}

let managedBuyerRuntime: ManagedBuyerRuntime | null = null;
let buyerStartup: { key: string; controller: AbortController; promise: Promise<void> } | null = null;

export function getManagedBuyerRuntime(): { logPath: string } | null {
  return managedBuyerRuntime ? { logPath: managedBuyerRuntime.logPath } : null;
}

export async function stopBuyerRuntime(report?: (message: string) => void): Promise<boolean> {
  const wasStarting = buyerStartup != null;
  await cancelBuyerStartup();
  const runtime = managedBuyerRuntime;
  if (!runtime || runtime.process.exitCode != null || runtime.process.signalCode != null) {
    report?.('No managed buyer process is running in this CLI session.');
    managedBuyerRuntime = null;
    return wasStarting;
  }

  report?.('Stopping managed buyer process...');
  await stopProcessTree(runtime.process);
  if (managedBuyerRuntime === runtime) managedBuyerRuntime = null;
  report?.('Buyer process stopped.');
  return true;
}

/** Cancel only an unfinished start; a ready buyer survives console re-entry. */
export async function cancelBuyerStartup(): Promise<void> {
  const startup = buyerStartup;
  if (!startup) return;
  startup.controller.abort();
  await startup.promise.catch(() => {});
}

export function getDefaultBuyerRuntimeOptions(config: CliDefaults): StartBuyerOptions {
  return {
    settlement: config.settlement,
    inputOverheadTokens: config.buyer.inputOverheadTokens,
    url: config.buyer.url,
    identityPath: config.buyer.identityPath,
    seedFile: config.buyer.seedProvidersFile,
    walletPath: config.paths.walletPath,
    legacyWalletPath: config.paths.legacySellerWalletPath,
    logsDir: config.paths.logsDir,
    logPath: config.paths.buyerLogPath,
    refreshModels: Array.from(new Set(config.buyer.subscribedModels)),
    discoverableModels: Array.from(new Set(config.buyer.subscribedModels)),
    bootstrapPeers: [...config.network.bootstrapPeers],
  };
}

export function startBuyerRuntime(options: StartBuyerOptions): Promise<void> {
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);
  const { report: _report, signal: _signal, onProgress: _progress, ...configuration } = options;
  const key = JSON.stringify({ ...configuration, url: normalizeUrl(options.url) });
  if (buyerStartup) {
    if (buyerStartup.key === key) return buyerStartup.promise;
    return Promise.reject(new Error('另一个买家配置正在启动，请等待完成或先停止买家。'));
  }
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  // Install the shared promise before any I/O so simultaneous starts cannot spawn twice.
  const startup = { key, controller, promise: Promise.resolve() };
  startup.promise = Promise.resolve().then(() => launchBuyer(options, controller.signal)).finally(() => {
    options.signal?.removeEventListener('abort', abort);
    if (buyerStartup === startup) buyerStartup = null;
  });
  buyerStartup = startup;
  return startup.promise;
}

async function launchBuyer(options: StartBuyerOptions, signal: AbortSignal): Promise<void> {
  const report = options.report ?? ((message: string) => console.log(message));
  const targetUrl = normalizeUrl(options.url);
  signal.throwIfAborted();
  options.onProgress?.('checking');
  if ((await interruptible(getServiceStatus(`${targetUrl}/health`, 'buyer'), signal)).online) {
    options.onProgress?.('verifying');
    const health = await checkStartupIdentity(targetUrl, options.settlement?.escrowPoolAddress, signal);
    const wallet = await interruptible(ensureStoredWallet({ walletPath: options.walletPath, legacyWalletPath: options.legacyWalletPath }), signal);
    const expectedAddress = process.env.BUYER_PRIVATE_KEY ? addressFromPrivateKey(process.env.BUYER_PRIVATE_KEY) : wallet.wallet.address;
    if (health.address?.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new Error('此地址运行的是另一个钱包的买家。请在设置中使用正确的网关地址，或先停止原买家。');
    }
    report(`已连接现有买家：${targetUrl}`);
    report('买家已就绪。可以进入“调用体验”发送消息，或查看“API 接入”。');
    options.onProgress?.('ready');
    return;
  }

  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(targetUrl).hostname)) {
    throw new Error('远程买家未连接，请检查网关地址。自动启动只适用于本机买家。');
  }
  options.onProgress?.('settlement');
  const settlementEnv = await interruptible(prepareSettlementRuntime(options.settlement, 'buyer'), signal);
  const seedFile = await interruptible(fileExists(options.seedFile), signal) ? options.seedFile : '';
  const buyerPort = extractPortFromUrl(targetUrl) ?? 18080;

  if (managedBuyerRuntime && managedBuyerRuntime.process.exitCode == null && !managedBuyerRuntime.process.killed) {
    throw new Error(`本次会话已有买家运行于 ${managedBuyerRuntime.url}。请先停止买家，再使用新的配置。`);
  }

  options.onProgress?.('wallet');
  const wallet = await interruptible(ensureStoredWallet({
    walletPath: options.walletPath,
    legacyWalletPath: options.legacyWalletPath,
    logger: (message) => report(`[wallet] ${message}`),
  }), signal);
  if (wallet.created) report(`✓ 钱包已创建：${wallet.wallet.address} | 按 E 导出私钥备份。机器丢了 = 钱没了。`);
  report('Starting buyer for you...');
  report(`Gateway URL   : ${targetUrl}`);
  report(`Identity file : ${options.identityPath}`);
  report(`Wallet       : ${wallet.wallet.address}`);
  if (seedFile) {
    report(`Seed bundle   : ${seedFile}`);
  } else {
    report('Seed bundle   : not found, buyer will rely on bootstrap peers only');
  }
  report('I will start it in the background and keep this menu available.');

  const env = {
    ...process.env,
    BUYER_PRIVATE_KEY: process.env.BUYER_PRIVATE_KEY ?? wallet.wallet.privateKey,
    CONSUMER_PORT: String(buyerPort),
    CLAW_SCHEDULER_ADMIN_PORT: process.env.CLAW_SCHEDULER_ADMIN_PORT ?? String((PAYMENT_TOKEN.symbol === 'BEM' ? 9458 : 9457) + PAYMENT_PORT_OFFSET),
    CLAW_SCHEDULER_CONFIG_PATH: process.env.CLAW_SCHEDULER_CONFIG_PATH ?? `${options.identityPath}.scheduler.json`,
    BOOTSTRAP_PEER_CACHE_PATH: process.env.BOOTSTRAP_PEER_CACHE_PATH ?? `${options.identityPath}.peers.json`,
    P2P_LISTEN_PORT: process.env.P2P_LISTEN_PORT ?? String((PAYMENT_TOKEN.symbol === 'BEM' ? 19092 : 19090) + PAYMENT_PORT_OFFSET),
    P2P_IDENTITY_PATH: options.identityPath,
    BOOTSTRAP_PEERS: process.env.BOOTSTRAP_PEERS ?? options.bootstrapPeers.join(','),
    DISABLE_BOOTSTRAP_MAINTENANCE: process.env.DISABLE_BOOTSTRAP_MAINTENANCE ?? '0',
    ...settlementEnv,
    USDC_ADDRESS: PAYMENT_TOKEN.address,
    INPUT_OVERHEAD_TOKENS: process.env.INPUT_OVERHEAD_TOKENS ?? String(options.inputOverheadTokens ?? 512),
    REFRESH_MODELS: process.env.REFRESH_MODELS ?? Array.from(new Set(options.refreshModels)).join(','),
    DISCOVERABLE_MODELS: process.env.DISCOVERABLE_MODELS ?? Array.from(new Set(options.discoverableModels)).join(','),
    SKIP_PNPM_BUILD: process.env.SKIP_PNPM_BUILD ?? '1',
  } as NodeJS.ProcessEnv;

  if (seedFile) {
    env.SEED_PROVIDERS_FILE = seedFile;
  }

  await interruptible(mkdir(options.logsDir, { recursive: true }), signal);
  signal.throwIfAborted();
  const logStream = createWriteStream(options.logPath, { flags: 'a' });
  const child = spawnManagedProcess('node', ['scripts/run-consumer-testnet.mjs'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  options.onProgress?.('network');
  child.stdout?.on('data', createStartupMonitor('buyer', options.onProgress));

  const runtime: ManagedBuyerRuntime = {
    process: child,
    logPath: options.logPath,
    url: targetUrl,
  };
  managedBuyerRuntime = runtime;

  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);
  child.once('exit', () => {
    logStream.end();
    if (managedBuyerRuntime === runtime) managedBuyerRuntime = null;
  });
  child.once('error', () => {
    logStream.end();
    if (managedBuyerRuntime === runtime) managedBuyerRuntime = null;
  });

  const readinessController = new AbortController();
  const onExit = () => readinessController.abort(new Error('买家进程在服务就绪前退出。请查看买家日志。'));
  child.once('exit', onExit);
  child.once('error', onExit);
  try {
    const readinessSignal = AbortSignal.any([signal, readinessController.signal]);
    const ready = await interruptible(waitForService(`${targetUrl}/health`, 60_000, getServiceStatus, 'buyer', readinessSignal), readinessSignal);
    if (ready) {
      options.onProgress?.('verifying');
      const health = await checkStartupIdentity(targetUrl, options.settlement?.escrowPoolAddress, signal);
      const expectedAddress = process.env.BUYER_PRIVATE_KEY ? addressFromPrivateKey(process.env.BUYER_PRIVATE_KEY) : wallet.wallet.address;
      if (health.address?.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error('启动的买家钱包与当前配置不一致。');
      options.onProgress?.('ready');
      report(`Buyer is ready at ${targetUrl}.`);
      report(`API address : ${targetUrl}/v1`);
      report(`Logs       : ${options.logPath}`);
      report('买家已就绪。可以进入“调用体验”发送消息，或查看“API 接入”。');
      return;
    }
    throw new Error(await formatStartupTimeout('buyer', options.logPath));
  } catch (error) {
    const failure = !signal.aborted && readinessController.signal.aborted
      ? new Error(await formatStartupFailure('buyer', options.logPath)) : error;
    // Failed or cancelled starts must release their ports before a retry can spawn.
    if (child.pid && child.exitCode == null && child.signalCode == null) await stopProcessTree(child);
    if (managedBuyerRuntime === runtime) managedBuyerRuntime = null;
    throw failure;
  } finally {
    child.removeListener('exit', onExit);
    child.removeListener('error', onExit);
  }
}

async function checkStartupIdentity(url: string, pool: string | undefined, signal: AbortSignal): Promise<{ address: string }> {
  const health = await interruptible(fetchJson<{ address: string; paymentToken?: unknown }>(`${url}/health`), signal);
  if (health.paymentToken != null) assertGatewaySettlement(health, pool);
  // Older clients lack identity metadata; retain their full validation path.
  else await interruptible(checkGatewaySettlement(url, 'buyer', pool), signal);
  return health;
}

function interruptible<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

async function formatStartupFailure(kind: 'buyer', logPath: string): Promise<string> {
  const tail = await readLogTail(logPath);
  return [
    `${kind} 启动失败：进程在服务就绪前退出。`,
    `日志文件：${logPath}`,
    tail ? `最近日志：\n${tail}` : '日志里暂时没有更多信息。',
  ].join('\n');
}

async function formatStartupTimeout(kind: 'buyer', logPath: string): Promise<string> {
  const tail = await readLogTail(logPath);
  return [
    `${kind} 启动超时：服务没有在预期时间内就绪。`,
    `日志文件：${logPath}`,
    tail ? `最近日志：\n${tail}` : '日志里暂时没有更多信息。',
  ].join('\n');
}

async function readLogTail(logPath: string): Promise<string> {
  try {
    const content = await readFile(logPath, 'utf8');
    return content.trimEnd().split(/\r?\n/).slice(-14).join('\n');
  } catch {
    return '';
  }
}

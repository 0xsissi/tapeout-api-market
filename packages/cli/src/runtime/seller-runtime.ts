import { normalizeModelPricing, PAYMENT_TOKEN } from '@clawmarket/shared';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { CONTRACTS } from '@clawmarket/shared';
import { probeCodex, probeGemini } from '@clawmarket/provider-gateway';
import { ensureQuoteSigningKey } from '@clawmarket/p2p-node';

import type { SellerUpstream, SettlementSettings } from '../config/schema.js';
import { prepareSettlementRuntime } from '../payment/runtime.js';
import type { CliDefaults } from '../config/store.js';
import { loadSellerSummary, waitForSellerReachability } from '../services/seller.js';
import { getServiceStatus } from '../services/http.js';
import { syncCodexCliAuthToCliproxy } from './cliproxy.js';
import { spawnManagedProcess, stopProcessTree } from './process.js';
import { abortableStartup, createStartupMonitor, type StartupReporter } from './startup-progress.js';
import { directoryHasRealFiles, extractPortFromUrl, normalizeUrl, readPrivateKeyFromWallet, waitForChildExit, waitForService } from '../utils.js';

interface ManagedSellerRuntime {
  process: ChildProcess;
  logPath: string;
  quotaWarning: boolean;
  lastQuotaWarning: string | null;
}

export interface StartSellerOptions {
  directBackend?: { proxyUrl: string; proxyHeaders?: Record<string, string> };
  settlement?: SettlementSettings;
  url: string;
  walletPath: string;
  identityPath: string;
  signingIdentityPath: string;
  e2eeIdentityPath: string;
  p2pPort: string;
  cliproxySource: string;
  cliproxyWorkDir: string;
  cliproxyAuthDir: string;
  cliproxyPort: string;
  upstream: SellerUpstream;
  models: string;
  inputPrice: string;
  outputPrice: string;
  p0: string;
  alpha: string;
  maxConcurrent: string;
  background: boolean;
  logPath: string;
  logsDir: string;
  seedFile: string;
  bootstrapPeers: string[];
  report?: (message: string) => void;
  onProgress?: StartupReporter;
  signal?: AbortSignal;
}

let managedSellerRuntime: ManagedSellerRuntime | null = null;
let sellerStartup: { key: string; controller: AbortController; promise: Promise<void> } | null = null;

export function getManagedSellerRuntime(): { logPath: string; quotaWarning: boolean; lastQuotaWarning: string | null } | null {
  return managedSellerRuntime
    ? {
        logPath: managedSellerRuntime.logPath,
        quotaWarning: managedSellerRuntime.quotaWarning,
        lastQuotaWarning: managedSellerRuntime.lastQuotaWarning,
      }
    : null;
}

export async function stopSellerRuntime(report?: (message: string) => void): Promise<boolean> {
  const wasStarting = sellerStartup != null;
  await cancelSellerStartup();
  const runtime = managedSellerRuntime;
  if (!runtime || runtime.process.exitCode != null || runtime.process.killed) {
    report?.(wasStarting ? '已取消卖家启动。' : 'No managed seller process is running in this CLI session.');
    managedSellerRuntime = null;
    return wasStarting;
  }

  report?.('Stopping managed seller process...');
  await stopProcessTree(runtime.process);
  if (managedSellerRuntime === runtime) managedSellerRuntime = null;
  report?.('Seller process stopped.');
  return true;
}

export async function cancelSellerStartup(): Promise<void> {
  const startup = sellerStartup;
  if (!startup) return;
  startup.controller.abort();
  await startup.promise.catch(() => {});
}

export function getDefaultSellerRuntimeOptions(config: CliDefaults): StartSellerOptions {
  return {
    settlement: config.settlement,
    url: config.seller.url,
    walletPath: config.seller.walletPath,
    identityPath: config.seller.identityPath,
    signingIdentityPath: config.seller.signingIdentityPath,
    e2eeIdentityPath: config.seller.e2eeIdentityPath,
    p2pPort: String(config.seller.p2pPort),
    cliproxySource: config.seller.cliproxySourceDir,
    cliproxyWorkDir: config.seller.cliproxyWorkDir,
    cliproxyAuthDir: config.seller.cliproxyAuthDir,
    cliproxyPort: String(config.seller.cliproxyPort),
    upstream: config.seller.upstream,
    models: config.seller.models.join(','),
    inputPrice: String(config.seller.pricing.input),
    outputPrice: String(config.seller.pricing.output),
    p0: String(config.seller.pricing.p0 ?? config.seller.pricing.input),
    alpha: String(config.seller.pricing.alpha ?? 1),
    maxConcurrent: String(config.seller.pricing.maxConcurrent ?? 5),
    background: true,
    logPath: config.paths.sellerLogPath,
    logsDir: config.paths.logsDir,
    seedFile: config.seller.seedFile,
    bootstrapPeers: config.network.bootstrapPeers,
  };
}

export function startSellerRuntime(options: StartSellerOptions): Promise<void> {
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);
  const { report: _report, onProgress: _progress, signal: _signal, ...configuration } = options;
  const key = JSON.stringify(configuration);
  if (sellerStartup) return sellerStartup.key === key ? sellerStartup.promise : Promise.reject(new Error('另一个卖家配置正在启动，请等待完成或先停止卖家。'));
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  const startup = { key, controller, promise: Promise.resolve() };
  startup.promise = Promise.resolve().then(() => startSeller(options, controller.signal)).finally(() => {
    options.signal?.removeEventListener('abort', abort);
    if (sellerStartup === startup) sellerStartup = null;
  });
  sellerStartup = startup;
  return startup.promise;
}

async function startSeller(options: StartSellerOptions, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const wait = <T>(work: Promise<T>) => abortableStartup(work, signal);
  const report = options.report ?? ((message: string) => console.log(message));
  const targetUrl = normalizeUrl(options.url);
  options.onProgress?.('checking');
  for (const price of [options.inputPrice, options.outputPrice, options.p0]) {
    if (!price.trim() || !Number.isFinite(Number(price)) || Number(price) <= 0) throw new Error(`请先设置卖家价格，单位为 ${PAYMENT_TOKEN.symbol}/百万推理 Token；不会复制另一币种的价格。`);
  }
  options.onProgress?.('settlement');
  const settlementEnv = await wait(prepareSettlementRuntime(options.settlement, 'seller'));
  if ((await wait(getServiceStatus(`${targetUrl}/health`, 'seller'))).online) {
    const status = await wait(loadSellerSummary(targetUrl));
    report(`Seller is already running at ${targetUrl}.`);
    report(status?.reachability ? `当前可连接性：${status.reachability.label}` : `可连接性可以看：${targetUrl}/v1/seller/status`);
    options.onProgress?.('ready');
    return;
  }

  options.onProgress?.('account');
  let hasAuth = !!options.directBackend || await wait(directoryHasRealFiles(options.cliproxyAuthDir));
  if (!hasAuth) {
    const synced = await wait(syncCodexCliAuthToCliproxy(options.upstream, options.cliproxyAuthDir));
    if (synced) {
      hasAuth = true;
      report(`检测到本机 Codex 已登录，已同步 seller auth：${synced.targetAuthPath}`);
    }
  }
  if (!hasAuth) {
    throw new Error(
      [
        `没有找到 ${options.upstream} 登录文件，所以 seller 不能启动上游代理。`,
        `请在 Seller 视图里选择 "登录 ${upstreamLabel(options.upstream)}"，或命令面板输入 login。`,
        `（登录文件目录：${options.cliproxyAuthDir}）`,
      ].join('\n'),
    );
  }

  options.onProgress?.('wallet');
  const providerPrivateKey = await wait(readPrivateKeyFromWallet(options.walletPath, 'seller wallet'));
  const signingKey = await wait(ensureQuoteSigningKey(options.signingIdentityPath));
  const sellerStatusPort = extractPortFromUrl(targetUrl) ?? 8787;
  const busyPorts = await wait(findUnavailablePorts([
    Number(options.p2pPort),
    Number(options.p2pPort) + 1,
    sellerStatusPort,
    ...(options.directBackend ? [] : [Number(options.cliproxyPort)]),
  ]));
  if (busyPorts.length > 0) {
    throw new Error(
      [
        `seller 启动需要的端口已被占用：${busyPorts.join(', ')}`,
        '这通常表示本机已经有一个 seller / cliproxy 进程在运行，或者上一次启动残留了进程。',
        `如果你想继续复用现有 seller，可以先检查：${targetUrl}/v1/seller/status`,
      ].join('\n'),
    );
  }

  const env = {
    ...process.env,
    CLAWMARKET_TRUSTED_BUYERS_FILE: process.env.CLAWMARKET_TRUSTED_BUYERS_FILE ?? path.join(path.dirname(options.e2eeIdentityPath), 'trusted-buyers.json'),
    PROVIDER_PRIVATE_KEY: providerPrivateKey,
    SIGNING_PRIVATE_KEY: signingKey.privateKey,
    MODELS_JSON: process.env.MODELS_JSON ?? buildSellerModelsJson(
      options.models,
      options.inputPrice,
      options.outputPrice,
      options.p0,
      options.alpha,
    ),
    EMBED_CLIPROXY: options.directBackend ? 'false' : 'true',
    CLIPROXY_SOURCE_DIR: options.cliproxySource,
    CLIPROXY_WORK_DIR: options.cliproxyWorkDir,
    CLIPROXY_AUTH_DIR: options.cliproxyAuthDir,
    CLIPROXY_PORT: options.cliproxyPort,
    SELLER_UPSTREAM: options.upstream,
    CLIPROXY_EXPOSE_MODELS: options.models,
    CLIPROXY_INPUT_PER_1M: options.inputPrice,
    CLIPROXY_OUTPUT_PER_1M: options.outputPrice,
    MAX_CONCURRENT: options.maxConcurrent,
    P2P_LISTEN_HOST: '0.0.0.0',
    P2P_LISTEN_PORT: options.p2pPort,
    P2P_IDENTITY_PATH: options.identityPath,
    SIGNING_IDENTITY_PATH: options.signingIdentityPath,
    E2EE_IDENTITY_PATH: options.e2eeIdentityPath,
    SELLER_STATUS_HOST: '127.0.0.1',
    SELLER_STATUS_PORT: String(sellerStatusPort),
    ANNOUNCEMENT_OUT: options.seedFile,
    ...settlementEnv,
    MINING_REWARDS_ADDRESS: PAYMENT_TOKEN.symbol === 'BEM' ? '' : (process.env.MINING_REWARDS_ADDRESS ?? CONTRACTS.MINING),
    BOOTSTRAP_PEERS: options.bootstrapPeers.join(','),
    SKIP_PNPM_BUILD: process.env.SKIP_PNPM_BUILD ?? '1',
  } as NodeJS.ProcessEnv;
  if (options.directBackend) { env.PROXY_URL = options.directBackend.proxyUrl; env.PROXY_HEADERS_JSON = JSON.stringify(options.directBackend.proxyHeaders ?? {}); }

  options.onProgress?.('account');
  const detectedTiers = PAYMENT_TOKEN.symbol === 'USDC' && !options.directBackend ? await wait(detectAimmAccountTiers(options)) : [];
  if (PAYMENT_TOKEN.symbol === 'USDC' && detectedTiers.length > 0) {
    env.AIMM_ACCOUNT_TIERS_JSON = JSON.stringify(detectedTiers);
    env.AIMM_CLIPROXY_MANAGEMENT_URL = `http://127.0.0.1:${options.cliproxyPort}`;
    report(`AIMM tiers: ${detectedTiers.map((item) => `${item.authIndex}=${item.tier}`).join(', ')}`);
  }

  if (PAYMENT_TOKEN.symbol === 'BEM') {
    env.AIMM_ACCOUNT_TIERS_JSON = '';
    delete env.AIMM_CLIPROXY_MANAGEMENT_URL;
  }
  report('Starting local seller...');
  report(`Status URL : ${targetUrl}`);
  report(`Models     : ${options.models}`);
  report(`Upstream   : ${options.directBackend ? 'private API configuration' : options.upstream}`);
  report(`AIMM       : p0=${options.p0} alpha=${options.alpha} maxConcurrent=${options.maxConcurrent}`);
  report(`Quote signer: ${signingKey.address}${signingKey.rotated ? ' (rotated)' : ''}`);
  report(`P2P port   : ${options.p2pPort}`);
  report(`Auth dir   : ${options.cliproxyAuthDir}`);

  if (!options.background) {
    signal.throwIfAborted();
    report('Seller will stay in the foreground. Press Ctrl+C to stop it.');
    const child = spawn('node', ['scripts/run-provider-testnet.mjs'], {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
    });
    let code;
    try { code = await wait(waitForChildExit(child)); }
    catch (error) { await stopProcessTree(child); throw error; }
    if (code !== 0) {
      throw new Error(`seller 启动失败：进程退出，退出码 ${code}。`);
    }
    return;
  }

  if (managedSellerRuntime && managedSellerRuntime.process.exitCode == null && !managedSellerRuntime.process.killed) {
    report('Seller start is already in progress in this CLI window.');
    report(`Logs: ${managedSellerRuntime.logPath}`);
    return;
  }

  await wait(mkdir(options.logsDir, { recursive: true }));
  signal.throwIfAborted();
  const logStream = createWriteStream(options.logPath, { flags: 'a' });
  const child = spawnManagedProcess('node', ['scripts/run-provider-testnet.mjs'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  options.onProgress?.(options.directBackend ? 'network' : 'proxy-build');
  child.stdout?.on('data', createStartupMonitor('seller', options.onProgress));

  managedSellerRuntime = {
    process: child,
    logPath: options.logPath,
    quotaWarning: false,
    lastQuotaWarning: null,
  };
  const quotaMonitor = createQuotaLogMonitor(options.upstream, report, (message) => {
    if (managedSellerRuntime) {
      managedSellerRuntime.quotaWarning = true;
      managedSellerRuntime.lastQuotaWarning = message;
    }
  });
  attachQuotaWatcher(child.stdout, quotaMonitor);
  attachQuotaWatcher(child.stderr, quotaMonitor);
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);
  child.once('exit', () => {
    logStream.end();
    if (managedSellerRuntime?.process === child) managedSellerRuntime = null;
  });
  child.once('error', () => {
    logStream.end();
    if (managedSellerRuntime?.process === child) managedSellerRuntime = null;
  });

  try {
    const ready = await waitForSellerService(child, `${targetUrl}/health`, signal);
    if (ready) {
      options.onProgress?.('reachability');
      const status = await wait(waitForSellerReachability(targetUrl, 12_000));
      report(`Seller is ready at ${targetUrl}.`);
      report(status?.reachability ? `可连接性：${status.reachability.label}` : '可连接性：检查中');
      report(`Logs: ${options.logPath}`);
      options.onProgress?.('ready');
      return;
    }

    const finalStatus = await wait(loadSellerSummary(targetUrl).catch(() => null));
    if (finalStatus) {
      report(`Seller is ready at ${targetUrl}.`);
      report(finalStatus.reachability ? `可连接性：${finalStatus.reachability.label}` : '可连接性：检查中');
      report(`Logs: ${options.logPath}`);
      options.onProgress?.('ready');
      return;
    }

    const failed = child.exitCode != null || child.signalCode != null || !managedSellerRuntime;
    await stopProcessTree(child);
    if (managedSellerRuntime?.process === child) managedSellerRuntime = null;
    if (failed) throw new Error(await formatStartupFailure('seller', options.logPath));
    throw new Error(await formatStartupTimeout('seller', options.logPath));
  } catch (error) {
    if (signal.aborted && child.exitCode == null && child.signalCode == null) await stopProcessTree(child);
    if (signal.aborted && managedSellerRuntime?.process === child) managedSellerRuntime = null;
    throw error;
  }
}

// Stop polling as soon as the child exits; first-time proxy builds may take longer.
export async function waitForSellerService(child: ChildProcess, healthUrl: string, signal?: AbortSignal): Promise<boolean> {
  if (child.exitCode != null || child.signalCode != null) return false;
  const controller = new AbortController();
  let onStopped!: () => void;
  const stopped = new Promise<boolean>((resolve) => { onStopped = () => resolve(false); });
  child.once('exit', onStopped);
  child.once('error', onStopped);
  try {
    const ready = Promise.race([
      waitForService(healthUrl, 180_000, getServiceStatus, 'seller', signal ? AbortSignal.any([signal, controller.signal]) : controller.signal),
      stopped,
    ]);
    return await (signal ? abortableStartup(ready, signal) : ready);
  } finally {
    controller.abort();
    child.removeListener('exit', onStopped);
    child.removeListener('error', onStopped);
  }
}

async function formatStartupFailure(kind: 'seller', logPath: string): Promise<string> {
  const tail = await readLogTail(logPath);
  const detail = tail.includes('Seller ledger is locked')
    ? '卖家账本正在使用，请停止原卖家后重试。'
    : '进程在服务就绪前退出。';
  return [
    `${kind} 启动失败：${detail}`,
    `日志文件：${logPath}`,
    tail ? `最近日志：\n${tail}` : '日志里暂时没有更多信息。',
  ].join('\n');
}

async function formatStartupTimeout(kind: 'seller', logPath: string): Promise<string> {
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

function upstreamLabel(upstream: SellerUpstream): string {
  switch (upstream) {
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude';
    case 'gemini':
      return 'Gemini';
  }
}

const quotaWindowMs = 5 * 60 * 1000;
const quotaThreshold = 3;
const quotaKeywords = /\b(quota|billing|insufficient_quota|rate_limit_exceeded|rate limit|resource exhausted|overloaded|credit)\b/i;

export function createQuotaLogMonitor(
  upstream: SellerUpstream,
  report: (message: string) => void,
  onWarning?: (message: string) => void,
): (chunk: Buffer | string) => void {
  let pending = '';
  let quotaHits: number[] = [];
  let lastQuotaReportAt = 0;

  return (chunk: Buffer | string) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const result = recordQuotaLine(line, upstream, quotaHits, lastQuotaReportAt);
      quotaHits = result.quotaHits;
      lastQuotaReportAt = result.lastQuotaReportAt;
      if (result.message) {
        onWarning?.(result.message);
        report(result.message);
      }
    }
  };
}

function attachQuotaWatcher(
  stream: NodeJS.ReadableStream | null | undefined,
  monitor: (chunk: Buffer | string) => void,
): void {
  if (!stream) {
    return;
  }

  stream.on('data', monitor);
}

async function findUnavailablePorts(ports: number[]): Promise<number[]> {
  const checks = await Promise.all(ports.map(async (port) => ({
    port,
    available: await isPortAvailable(port),
  })));

  return checks.filter((item) => !item.available).map((item) => item.port);
}

export async function isPortAvailable(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0) {
    return true;
  }

  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();

    server.once('error', () => {
      resolve(false);
    });

    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen(port, '0.0.0.0');
  });
}

function recordQuotaLine(
  line: string,
  upstream: SellerUpstream,
  quotaHits: number[],
  lastQuotaReportAt: number,
): { quotaHits: number[]; lastQuotaReportAt: number; message: string | null } {
  if (!quotaKeywords.test(line)) {
    return { quotaHits, lastQuotaReportAt, message: null };
  }

  const now = Date.now();
  const nextHits = [...quotaHits.filter((hit) => now - hit <= quotaWindowMs), now];
  if (nextHits.length < quotaThreshold || now - lastQuotaReportAt < quotaWindowMs) {
    return { quotaHits: nextHits, lastQuotaReportAt, message: null };
  }

  const message = `[warn] ${upstreamLabel(upstream)} 账号可能额度用完（近 5 分钟 ${nextHits.length} 次 quota/rate limit 错误）。建议在 Accounts 视图切换账号。`;
  return { quotaHits: nextHits, lastQuotaReportAt: now, message };
}

export function buildSellerModelsJson(
  modelsCsv: string,
  inputPrice: string,
  outputPrice: string,
  p0Value: string,
  alphaValue: string,
): string | undefined {
  const models = modelsCsv
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  if (models.length === 0) {
    return undefined;
  }

  const inputPer1m = parsePrice(inputPrice, 80);
  const outputPer1m = parsePrice(outputPrice, 80);
  const p0 = parsePrice(p0Value, (inputPer1m + outputPer1m) / 2);
  const alpha = parsePrice(alphaValue, 1);
  return JSON.stringify(models.map((model) => normalizeModelPricing({
    model,
    inputPer1m,
    outputPer1m,
    p0,
    alpha,
  })));
}

function parsePrice(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function detectAimmAccountTiers(
  options: Pick<StartSellerOptions, 'upstream' | 'cliproxyAuthDir'>,
): Promise<Array<{ authIndex: string; tier: string }>> {
  const authFiles = await listAuthJsonFiles(options.cliproxyAuthDir);

  if (options.upstream === 'codex') {
    const results = await Promise.all(authFiles.map(async (filePath) => ({
      authIndex: path.basename(filePath, '.json'),
      result: await probeCodex(filePath),
    })));
    return results
      .filter((item) => item.result.ok)
      .map((item) => ({ authIndex: item.authIndex, tier: item.result.tier }));
  }

  if (options.upstream === 'gemini') {
    const target = authFiles[0];
    const result = await probeGemini(target).catch(() => ({ ok: false as const, reason: 'probe_failed' }));
    if (!result.ok) {
      return [];
    }
    return [{ authIndex: path.basename(target ?? 'gemini', '.json'), tier: result.tier }];
  }

  return [];
}

async function listAuthJsonFiles(root: string): Promise<string[]> {
  const results: string[] = [];

  async function visit(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        results.push(fullPath);
      }
    }
  }

  await visit(root);
  return results.sort();
}

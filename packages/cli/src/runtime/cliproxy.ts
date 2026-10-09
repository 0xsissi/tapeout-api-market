import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

import type { SellerUpstream } from '../config/schema.js';
import { directoryHasRealFiles, sleep, waitForChildExit } from '../utils.js';

const DEFAULT_CLIPROXY_REPO_URL = 'https://github.com/router-for-me/CLIProxyAPI.git';

export interface LoginSellerUpstreamOptions {
  upstream: SellerUpstream;
  device: boolean;
  cliproxySource: string;
  cliproxyWorkDir: string;
  cliproxyAuthDir: string;
  allowReuseLocalCodexAuth?: boolean;
}

export interface DiscoverUpstreamModelsOptions {
  upstream: SellerUpstream;
  cliproxySource: string;
  cliproxyWorkDir: string;
  cliproxyAuthDir: string;
  port?: number;
  timeoutMs?: number;
}

export interface SellerLoginResult {
  mode: 'browser' | 'device' | 'reused-codex-cli' | 'existing-auth-dir';
}

export async function loginSellerUpstream(options: LoginSellerUpstreamOptions): Promise<SellerLoginResult> {
  const existingAuth = await directoryHasRealFiles(options.cliproxyAuthDir);
  if (existingAuth) {
    const label = upstreamLabel(options.upstream);
    console.log(`${label} Seller Login`);
    console.log('--------------------');
    console.log(`检测到现有 seller auth：${options.cliproxyAuthDir}`);
    console.log('跳过重新登录，继续使用当前登录状态。');
    console.log('');
    return { mode: 'existing-auth-dir' };
  }

  const reusedCodexAuth = options.allowReuseLocalCodexAuth === false
    ? null
    : await syncCodexCliAuthToCliproxy(options.upstream, options.cliproxyAuthDir);
  if (reusedCodexAuth) {
    const label = upstreamLabel(options.upstream);
    console.log(`${label} Seller Login`);
    console.log('--------------------');
    console.log(`复用本机 Codex 登录：${reusedCodexAuth.sourceAuthPath}`);
    console.log(`已写入 seller auth：${reusedCodexAuth.targetAuthPath}`);
    console.log('');
    return { mode: 'reused-codex-cli' };
  }

  const provider = options.upstream === 'codex' && options.device ? 'codex-device' : options.upstream;
  const label = upstreamLabel(options.upstream);
  console.log('');
  console.log(`${label} Seller Login`);
  console.log('--------------------');
  console.log(`CLIProxyAPI : ${options.cliproxySource}`);
  console.log(`Auth dir    : ${options.cliproxyAuthDir}`);
  console.log('');

  await prepareCliproxySource(options.cliproxySource);
  await mkdir(options.cliproxyAuthDir, { recursive: true });
  const child = spawn('node', ['scripts/run-cliproxy-auth.mjs', provider], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLIPROXY_SOURCE_DIR: options.cliproxySource,
      CLIPROXY_WORK_DIR: options.cliproxyWorkDir,
      CLIPROXY_AUTH_DIR: options.cliproxyAuthDir,
    },
    stdio: 'inherit',
  });

  const code = await waitForChildExit(child);
  if (code !== 0) {
    throw new Error(`${label} login failed with exit code ${code}.`);
  }

  return { mode: options.device ? 'device' : 'browser' };
}

export async function loginSellerCodex(options: Omit<LoginSellerUpstreamOptions, 'upstream'>): Promise<void> {
  return loginSellerUpstream({ ...options, upstream: 'codex' });
}

export async function discoverUpstreamModels(options: DiscoverUpstreamModelsOptions): Promise<string[]> {
  await syncCodexCliAuthToCliproxy(options.upstream, options.cliproxyAuthDir);

  const host = '127.0.0.1';
  const port = await resolveProbePort(options.port);
  const timeoutMs = options.timeoutMs ?? 20_000;
  const probeDir = path.join(options.cliproxyWorkDir, 'model-probe');
  const configPath = path.join(probeDir, `config-${options.upstream}-${port}.yaml`);
  const backendUrl = `http://${host}:${port}`;
  const healthUrl = `${backendUrl}/healthz`;
  const logs: string[] = [];

  await prepareCliproxySource(options.cliproxySource);
  await mkdir(probeDir, { recursive: true });
  await mkdir(options.cliproxyAuthDir, { recursive: true });
  await writeFile(configPath, renderProbeConfig({ host, port, authDir: options.cliproxyAuthDir }), 'utf8');

  const launch = resolveCliproxyLaunchCommand(configPath, options);
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: {
      ...process.env,
      WRITABLE_PATH: options.cliproxyWorkDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  collectProbeLogs(child.stdout, logs);
  collectProbeLogs(child.stderr, logs);

  const exitPromise = waitForChildExit(child);
  try {
    await waitForProbeReady(healthUrl, exitPromise, timeoutMs, () => formatProbeLogs(logs));
    return await fetchModelIds(`${backendUrl}/v1/models`, Math.min(timeoutMs, 5_000));
  } finally {
    await stopProbe(child, exitPromise);
    await rm(configPath, { force: true });
  }
}

async function resolveProbePort(preferredPort?: number): Promise<number> {
  if (preferredPort != null) {
    return preferredPort;
  }

  const defaultPort = 4399;
  if (await isTcpPortAvailable(defaultPort)) {
    return defaultPort;
  }

  return await findEphemeralPort();
}

async function isTcpPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function findEphemeralPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate a probe TCP port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
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

function resolveCliproxyLaunchCommand(
  configPath: string,
  options: DiscoverUpstreamModelsOptions,
): { command: string; args: string[]; cwd: string } {
  const args = ['-config', configPath];
  const binary = process.env.CLIPROXY_BIN?.trim();
  if (binary) {
    return { command: binary, args, cwd: options.cliproxyWorkDir };
  }
  return {
    command: 'go',
    args: ['run', './cmd/server', ...args],
    cwd: options.cliproxySource,
  };
}

function renderProbeConfig(options: { host: string; port: number; authDir: string }): string {
  return [
    `host: ${yamlString(options.host)}`,
    `port: ${options.port}`,
    `auth-dir: ${yamlString(options.authDir)}`,
    'request-log: false',
    'logging-to-file: false',
    'usage-statistics-enabled: false',
    'debug: false',
    'streaming:',
    '  bootstrap-retries: 1',
    '',
  ].join('\n');
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

async function waitForProbeReady(
  healthUrl: string,
  exitPromise: Promise<number | null>,
  timeoutMs: number,
  getLogs: () => string,
): Promise<void> {
  const startedAt = Date.now();
  const settledExit = exitPromise.then(
    (code) => ({ type: 'exit' as const, code }),
    (error: unknown) => ({ type: 'error' as const, error }),
  );

  while (Date.now() - startedAt < timeoutMs) {
    const result = await Promise.race([
      settledExit,
      sleep(300).then(() => ({ type: 'sleep' as const })),
    ]);

    if (result.type === 'exit') {
      throw new Error(`CLIProxyAPI probe exited before readiness (code=${result.code ?? 'null'}).${getLogs()}`);
    }
    if (result.type === 'error') {
      throw new Error(`CLIProxyAPI probe failed to start: ${formatError(result.error)}.${getLogs()}`);
    }

    try {
      const response = await fetchWithTimeout(healthUrl, 1_000);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the process exits or the timeout elapses.
    }
  }

  throw new Error(`CLIProxyAPI probe did not become ready within ${Math.round(timeoutMs / 1000)}s.${getLogs()}`);
}

async function fetchModelIds(modelsUrl: string, timeoutMs: number): Promise<string[]> {
  const response = await fetchWithTimeout(modelsUrl, timeoutMs, {
    headers: {
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`CLIProxyAPI model discovery failed with HTTP ${response.status}`);
  }

  const payload = await response.json() as { data?: unknown };
  const modelIds = Array.isArray(payload.data)
    ? payload.data
        .map((item) => item && typeof item === 'object' && 'id' in item ? (item as { id?: unknown }).id : null)
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim())
    : [];

  return Array.from(new Set(modelIds));
}

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function stopProbe(child: ReturnType<typeof spawn>, exitPromise: Promise<number | null>): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  child.kill('SIGINT');
  const stopped = await Promise.race([
    exitPromise.then(() => true, () => true),
    sleep(5_000).then(() => false),
  ]);
  if (!stopped && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      exitPromise.catch(() => null),
      sleep(5_000),
    ]);
  }
}

function collectProbeLogs(stream: NodeJS.ReadableStream | null, logs: string[]): void {
  if (!stream) {
    return;
  }

  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        logs.push(trimmed);
      }
    }
    logs.splice(0, Math.max(0, logs.length - 20));
  });
}

function formatProbeLogs(logs: string[]): string {
  return logs.length > 0 ? ` Recent logs: ${logs.join(' | ')}` : '';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function prepareCliproxySource(sourceDir: string): Promise<void> {
  if (process.env.CLIPROXY_BIN?.trim()) {
    return;
  }

  await ensureCliproxySource(sourceDir);
  await ensureGoToolchain(sourceDir);
}

async function ensureCliproxySource(sourceDir: string): Promise<void> {
  if (await isReadableDirectory(sourceDir)) {
    return;
  }

  if (isExplicitFalse(process.env.CLIPROXY_AUTO_CLONE)) {
    throw new Error(missingCliproxySourceMessage(sourceDir));
  }

  const repoUrl = process.env.CLIPROXY_REPO_URL?.trim() || DEFAULT_CLIPROXY_REPO_URL;
  await ensureGitAvailable(sourceDir, repoUrl);
  await mkdir(path.dirname(sourceDir), { recursive: true });
  console.log(`没有找到 CLIProxyAPI 源码，正在自动安装到：${sourceDir}`);
  console.log(`来源：${repoUrl}`);

  try {
    await captureCommand('git', ['clone', '--depth', '1', repoUrl, sourceDir]);
  } catch (error) {
    throw new Error(
      [
        `自动安装 CLIProxyAPI 失败：${formatError(error)}`,
        '',
        '你也可以手动执行：',
        `  git clone ${repoUrl} ${sourceDir}`,
        '然后重新运行 tam。',
      ].join('\n'),
    );
  }

  if (!(await isReadableDirectory(sourceDir))) {
    throw new Error(missingCliproxySourceMessage(sourceDir));
  }
}

async function isReadableDirectory(sourceDir: string): Promise<boolean> {
  try {
    const info = await stat(sourceDir);
    if (!info.isDirectory()) {
      return false;
    }
    await access(sourceDir, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureGitAvailable(sourceDir: string, repoUrl: string): Promise<void> {
  try {
    await captureCommand('git', ['--version']);
  } catch {
    throw new Error(
      [
        '当前机器没有可用的 git 命令，无法自动安装 CLIProxyAPI。',
        '',
        '请先安装 Git，然后重试：',
        '  xcode-select --install',
        '',
        '或手动 clone：',
        `  git clone ${repoUrl} ${sourceDir}`,
      ].join('\n'),
    );
  }
}

function missingCliproxySourceMessage(sourceDir: string): string {
  const repoUrl = process.env.CLIPROXY_REPO_URL?.trim() || DEFAULT_CLIPROXY_REPO_URL;
  return [
    `没有找到可读取的 CLIProxyAPI 源码目录：${sourceDir}`,
    '',
    '请执行下面任一方式后重试：',
    `  git clone ${repoUrl} ${sourceDir}`,
    `  corepack pnpm cli -- config set seller.cliproxySourceDir "${sourceDir}"`,
    '',
    '如果你已经有 CLIProxyAPI，请在 Console 设置里选择正确目录，或设置 CLAWMARKET_CLIPROXY_SOURCE_DIR。',
  ].join('\n');
}

async function ensureGoToolchain(sourceDir: string): Promise<void> {
  const required = await readGoModVersion(sourceDir);
  if (!required) {
    return;
  }

  const installed = await readInstalledGoVersion(sourceDir);
  if (!installed) {
    throw new Error([
      `CLIProxyAPI 需要 Go ${required.raw}，但当前机器没有可用的 go 命令。`,
      '请先安装 Go，然后重试：',
      '  https://go.dev/dl/',
    ].join('\n'));
  }

  if (compareGoVersions(installed, required) < 0) {
    throw new Error([
      `CLIProxyAPI 需要 Go ${required.raw}，当前是 Go ${installed.raw}。`,
      '请升级 Go 后重试：',
      '  https://go.dev/dl/',
      '如果你使用 nvm/旧 PATH，升级后请确认：',
      '  go version',
    ].join('\n'));
  }
}

async function readGoModVersion(sourceDir: string): Promise<GoVersion | null> {
  try {
    const goMod = await readFile(path.join(sourceDir, 'go.mod'), 'utf8');
    const match = /^go\s+(\d+)\.(\d+)(?:\.(\d+))?/m.exec(goMod);
    if (!match) {
      return null;
    }
    return {
      raw: match[0].replace(/^go\s+/, ''),
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3] ?? '0'),
    };
  } catch {
    return null;
  }
}

async function readInstalledGoVersion(sourceDir: string): Promise<GoVersion | null> {
  const output = await captureCommand('go', ['version'], sourceDir).catch(() => '');
  const match = /\bgo(\d+)\.(\d+)(?:\.(\d+))?\b/.exec(output);
  if (!match) {
    return null;
  }
  return {
    raw: match[0].replace(/^go/, ''),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? '0'),
  };
}

function captureCommand(command: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
      }
    });
  });
}

function compareGoVersions(left: GoVersion, right: GoVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }
  return 0;
}

function isExplicitFalse(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === '0' || value === 'false' || value === 'no' || value === 'off';
}

interface GoVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
}

interface SyncedCodexAuth {
  sourceAuthPath: string;
  targetAuthPath: string;
}

interface DecodedCodexCliAuth {
  email: string;
  planType: string;
  accountId: string;
  idToken: string;
  accessToken: string;
  refreshToken: string;
  lastRefresh: string;
  expired: string;
}

export async function syncCodexCliAuthToCliproxy(
  upstream: SellerUpstream,
  cliproxyAuthDir: string,
  sourceAuthPath = defaultCodexCliAuthPath(),
): Promise<SyncedCodexAuth | null> {
  if (upstream !== 'codex') {
    return null;
  }
  if (await directoryHasRealFiles(cliproxyAuthDir)) {
    return null;
  }

  let raw: string;
  try {
    raw = await readFile(sourceAuthPath, 'utf8');
  } catch {
    return null;
  }

  const decoded = decodeCodexCliAuth(raw);
  await mkdir(cliproxyAuthDir, { recursive: true });

  const targetAuthPath = path.join(
    cliproxyAuthDir,
    codexCredentialFileName(decoded.email, decoded.planType, decoded.accountId),
  );

  await writeFile(targetAuthPath, `${JSON.stringify({
    type: 'codex',
    email: decoded.email,
    id_token: decoded.idToken,
    access_token: decoded.accessToken,
    refresh_token: decoded.refreshToken,
    account_id: decoded.accountId,
    last_refresh: decoded.lastRefresh,
    expired: decoded.expired,
  }, null, 2)}\n`, { mode: 0o600 });

  return {
    sourceAuthPath,
    targetAuthPath,
  };
}

function defaultCodexCliAuthPath(): string {
  const configured = process.env.CLAWMARKET_CODEX_AUTH_PATH?.trim() || process.env.CODEX_AUTH_FILE?.trim();
  if (configured) {
    return configured;
  }
  return path.join(process.env.HOME ?? os.homedir(), '.codex', 'auth.json');
}

function decodeCodexCliAuth(raw: string): DecodedCodexCliAuth {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Cannot parse Codex auth JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const record = asRecord(parsed);
  const tokens = asRecord(record.tokens);
  const idToken = readRequiredString(tokens.id_token, 'tokens.id_token');
  const accessToken = readRequiredString(tokens.access_token, 'tokens.access_token');
  const refreshToken = readRequiredString(tokens.refresh_token, 'tokens.refresh_token');

  const idTokenClaims = decodeJwtPayload(idToken);
  const accessTokenClaims = decodeJwtPayload(accessToken);
  const authClaims = asRecord(idTokenClaims['https://api.openai.com/auth']);

  const email = readRequiredString(idTokenClaims.email, 'id_token.email');
  const planType = readOptionalString(authClaims.chatgpt_plan_type);
  const accountId =
    readOptionalString(tokens.account_id)
    || readOptionalString(authClaims.chatgpt_account_id)
    || readOptionalString(idTokenClaims.sub);
  if (!accountId) {
    throw new Error('Codex auth is missing account_id.');
  }

  const lastRefresh = readOptionalString(record.last_refresh) || new Date().toISOString();
  const expSeconds = readOptionalNumber(accessTokenClaims.exp) ?? readOptionalNumber(idTokenClaims.exp);
  const expired = expSeconds ? new Date(expSeconds * 1000).toISOString() : '';

  return {
    email,
    planType,
    accountId,
    idToken,
    accessToken,
    refreshToken,
    lastRefresh,
    expired,
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Codex token is not a valid JWT.');
  }

  const payload = parts[1];
  if (!payload) {
    throw new Error('Codex token payload is empty.');
  }

  try {
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    return asRecord(JSON.parse(decoded));
  } catch (error) {
    throw new Error(`Cannot decode Codex token payload: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function codexCredentialFileName(email: string, planType: string, accountId: string): string {
  const normalizedPlan = normalizePlanType(planType);
  if (!normalizedPlan) {
    return `codex-${email}.json`;
  }
  if (normalizedPlan === 'team') {
    const shortHash = createHash('sha256').update(accountId).digest('hex').slice(0, 8);
    return `codex-${shortHash}-${email}-${normalizedPlan}.json`;
  }
  return `codex-${email}-${normalizedPlan}.json`;
}

function normalizePlanType(planType: string): string {
  return planType
    .trim()
    .split(/[^a-zA-Z0-9]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join('-');
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readRequiredString(value: unknown, label: string): string {
  const normalized = readOptionalString(value);
  if (!normalized) {
    throw new Error(`Codex auth is missing ${label}.`);
  }
  return normalized;
}

function readOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

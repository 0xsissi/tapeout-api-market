import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { mkdir, access, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

import { repoRoot } from './testnet-runtime.mjs';
import { reportStartupStage } from './startup-progress.mjs';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4310;
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_MODEL_PRICE = 80;
const DEFAULT_CLIPROXY_REPO_URL = 'https://github.com/router-for-me/CLIProxyAPI.git';

export function isEmbeddedCliproxyEnabled(env = process.env) {
  const explicitMode = [
    env.PROVIDER_BACKEND,
    env.PROVIDER_BACKEND_MODE,
    env.BACKEND_MODE,
  ]
    .map((value) => value?.trim().toLowerCase())
    .find(Boolean);

  if (explicitMode === 'embedded-cliproxy' || explicitMode === 'cliproxy-embedded') {
    return true;
  }

  return parseBooleanFlag(env.EMBED_CLIPROXY) || parseBooleanFlag(env.CLIPROXY_EMBED);
}

export function resolveEmbeddedCliproxyOptions(env = process.env) {
  const sourceDir =
    env.CLIPROXY_SOURCE_DIR?.trim() || path.resolve(repoRoot, '..', 'CLIProxyAPI');
  const workDir =
    env.CLIPROXY_WORK_DIR?.trim() ||
    path.join(os.homedir(), '.clawmarket', 'embedded-cliproxy');
  const authDir = env.CLIPROXY_AUTH_DIR?.trim() || path.join(workDir, 'auths');
  const configPath = env.CLIPROXY_CONFIG_PATH?.trim() || path.join(workDir, 'config.yaml');
  const host = env.CLIPROXY_HOST?.trim() || DEFAULT_HOST;
  const port = parsePort(env.CLIPROXY_PORT, 'CLIPROXY_PORT') ?? DEFAULT_PORT;
  const readyTimeoutMs =
    parseFiniteNumber(env.CLIPROXY_READY_TIMEOUT_MS, 'CLIPROXY_READY_TIMEOUT_MS') ??
    DEFAULT_READY_TIMEOUT_MS;
  const oauthModelAlias = parseOptionalJsonObject(
    env.CLIPROXY_OAUTH_MODEL_ALIAS_JSON,
    'CLIPROXY_OAUTH_MODEL_ALIAS_JSON',
  );
  const oauthExcludedModels = parseOptionalJsonObject(
    env.CLIPROXY_OAUTH_EXCLUDED_MODELS_JSON,
    'CLIPROXY_OAUTH_EXCLUDED_MODELS_JSON',
  );
  const exposeModels = parseCsv(env.CLIPROXY_EXPOSE_MODELS ?? '');
  const codexHeaderDefaults = {
    userAgent: env.CLIPROXY_CODEX_USER_AGENT?.trim() || '',
    betaFeatures: env.CLIPROXY_CODEX_BETA_FEATURES?.trim() || '',
  };
  const proxyUrl = resolveConfiguredProxyUrl(env);

  return {
    sourceDir,
    workDir,
    authDir,
    configPath,
    host,
    port,
    readyTimeoutMs,
    oauthModelAlias,
    oauthExcludedModels,
    exposeModels,
    codexHeaderDefaults,
    proxyUrl,
    backendUrl: `http://${host}:${port}`,
    healthUrl: `http://${host}:${port}/healthz`,
  };
}

export function renderEmbeddedCliproxyConfig(options) {
  const lines = [
    `host: ${yamlString(options.host)}`,
    `port: ${options.port}`,
    `auth-dir: ${yamlString(options.authDir)}`,
    'request-log: false',
    'logging-to-file: false',
    'usage-statistics-enabled: false',
    'debug: false',
    'streaming:',
    '  bootstrap-retries: 1',
  ];

  if (options.proxyUrl) {
    lines.push(`proxy-url: ${yamlString(options.proxyUrl)}`);
  }

  if (options.codexHeaderDefaults?.userAgent || options.codexHeaderDefaults?.betaFeatures) {
    lines.push('codex-header-defaults:');
    if (options.codexHeaderDefaults.userAgent) {
      lines.push(`  user-agent: ${yamlString(options.codexHeaderDefaults.userAgent)}`);
    }
    if (options.codexHeaderDefaults.betaFeatures) {
      lines.push(`  beta-features: ${yamlString(options.codexHeaderDefaults.betaFeatures)}`);
    }
  }

  if (options.oauthModelAlias && Object.keys(options.oauthModelAlias).length > 0) {
    lines.push('oauth-model-alias:');
    for (const [channel, aliases] of Object.entries(options.oauthModelAlias)) {
      if (!Array.isArray(aliases) || aliases.length === 0) {
        continue;
      }
      lines.push(`  ${channel}:`);
      for (const alias of aliases) {
        if (!alias || typeof alias !== 'object') {
          continue;
        }
        if (!alias.name || !alias.alias) {
          continue;
        }
        lines.push(`    - name: ${yamlString(alias.name)}`);
        lines.push(`      alias: ${yamlString(alias.alias)}`);
        if (alias.fork === true) {
          lines.push('      fork: true');
        }
      }
    }
  }

  if (options.oauthExcludedModels && Object.keys(options.oauthExcludedModels).length > 0) {
    lines.push('oauth-excluded-models:');
    for (const [channel, models] of Object.entries(options.oauthExcludedModels)) {
      if (!Array.isArray(models) || models.length === 0) {
        continue;
      }
      lines.push(`  ${channel}:`);
      for (const model of models) {
        lines.push(`    - ${yamlString(model)}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

export async function prepareEmbeddedCliproxyWorkspace(env = process.env) {
  const options = resolveEmbeddedCliproxyOptions(env);
  if (!options.proxyUrl) {
    options.proxyUrl = await detectSystemProxyUrl(env);
  }
  const usesBinary = Boolean(env.CLIPROXY_BIN?.trim());
  if (!usesBinary) {
    reportStartupStage('seller', 'proxy-build');
    await ensureCliproxySource(options.sourceDir, env);
    await ensureGoToolchain(options.sourceDir, buildCliproxyChildEnv(options));
  }
  await mkdir(options.workDir, { recursive: true });
  await mkdir(options.authDir, { recursive: true });
  await mkdir(path.dirname(options.configPath), { recursive: true });
  await writeFile(options.configPath, renderEmbeddedCliproxyConfig(options), 'utf8');
  return options;
}

export async function startEmbeddedCliproxy(env = process.env) {
  const options = await prepareEmbeddedCliproxyWorkspace(env);
  reportStartupStage('seller', 'proxy-start');
  const launch = resolveCliproxyLaunchCommand(options, env);
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: buildCliproxyChildEnv(options),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const exitPromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });

  prefixStream(child.stdout, '[cliproxy] ');
  prefixStream(child.stderr, '[cliproxy] ');

  await waitForCliproxyReady(options, exitPromise);

  const discoveredModels = await discoverCliproxyModels(options, env);

  return {
    ...options,
    backendMode: 'embedded-cliproxy',
    child,
    discoveredModels,
    async stop() {
      if (child.exitCode !== null) {
        return;
      }
      if (process.platform === 'win32' && child.pid) {
        await new Promise((resolve, reject) => {
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => {
            if (error && child.exitCode === null) reject(error);
            else resolve();
          });
        });
        return;
      }
      child.kill('SIGINT');
      const result = await Promise.race([
        exitPromise,
        waitMs(5_000).then(() => null),
      ]);
      if (result === null && child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          exitPromise,
          waitMs(5_000),
        ]);
      }
    },
  };
}

export async function runEmbeddedCliproxyLogin(loginProvider, env = process.env) {
  const options = await prepareEmbeddedCliproxyWorkspace(env);
  const launch = resolveCliproxyLaunchCommand(options, env, loginProvider);
  await new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: buildCliproxyChildEnv(options),
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`embedded cliproxy login exited with code ${code}`));
    });
  });

  const hasAuth = await authDirHasFiles(options.authDir);
  if (!hasAuth) {
    throw new Error(
      [
        `embedded cliproxy login finished without writing auth files for ${loginProvider}.`,
        `Auth dir: ${options.authDir}`,
        'This usually means the upstream login flow was rejected or did not complete.',
      ].join('\n'),
    );
  }

  return options;
}

function resolveCliproxyLaunchCommand(options, env, loginProvider = '') {
  const sharedArgs = ['-config', options.configPath];
  if (parseBooleanFlag(env.CLIPROXY_NO_BROWSER)) {
    sharedArgs.push('-no-browser');
  }
  if (env.CLIPROXY_OAUTH_CALLBACK_PORT?.trim()) {
    sharedArgs.push('-oauth-callback-port', env.CLIPROXY_OAUTH_CALLBACK_PORT.trim());
  }
  if (loginProvider === 'codex') {
    sharedArgs.push('-codex-login');
  } else if (loginProvider === 'codex-device') {
    sharedArgs.push('-codex-device-login');
  } else if (loginProvider === 'claude') {
    sharedArgs.push('-claude-login');
  } else if (loginProvider === 'gemini') {
    sharedArgs.push('-login');
  }

  const binary = env.CLIPROXY_BIN?.trim();
  if (binary) {
    return { command: binary, args: sharedArgs, cwd: options.workDir };
  }

  return {
    command: 'go',
    args: ['run', './cmd/server', ...sharedArgs],
    cwd: options.sourceDir,
  };
}

async function discoverCliproxyModels(options, env = process.env) {
  const response = await fetch(`${options.backendUrl}/v1/models`);
  if (!response.ok) {
    throw new Error(`embedded cliproxy model discovery failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  const modelIds = Array.isArray(payload?.data)
    ? payload.data
        .map((item) => item?.id)
        .filter((value) => typeof value === 'string' && value.trim())
    : [];
  const allowedModels =
    options.exposeModels.length > 0 ? new Set(options.exposeModels) : null;
  const inputPer1m =
    parseFiniteNumber(
      env.CLIPROXY_INPUT_PER_1M ?? env.CLIPROXY_DEFAULT_INPUT_PER_1M,
      'CLIPROXY_INPUT_PER_1M',
    ) ?? DEFAULT_MODEL_PRICE;
  const outputPer1m =
    parseFiniteNumber(
      env.CLIPROXY_OUTPUT_PER_1M ?? env.CLIPROXY_DEFAULT_OUTPUT_PER_1M,
      'CLIPROXY_OUTPUT_PER_1M',
    ) ?? DEFAULT_MODEL_PRICE;

  const seen = new Set();
  const models = [];
  for (const modelId of modelIds) {
    if (allowedModels && !allowedModels.has(modelId)) {
      continue;
    }
    if (seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    models.push({
      model: modelId,
      inputPer1m,
      outputPer1m,
    });
  }
  return models;
}

async function waitForCliproxyReady(options, exitPromise) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < options.readyTimeoutMs) {
    const exited = await Promise.race([
      exitPromise.then((result) => ({ type: 'exit', result })),
      waitMs(500).then(() => ({ type: 'sleep' })),
    ]);
    if (exited.type === 'exit') {
      const { code, signal } = exited.result;
      throw new Error(
        `embedded cliproxy exited before becoming ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
      );
    }

    try {
      const response = await fetch(options.healthUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until ready timeout.
    }
  }

  throw new Error(
    `embedded cliproxy did not become ready within ${Math.round(options.readyTimeoutMs / 1000)}s`,
  );
}

async function ensureCliproxySource(sourceDir, env = process.env) {
  if (await isReadableDirectory(sourceDir)) {
    return;
  }

  if (isExplicitFalse(env.CLIPROXY_AUTO_CLONE)) {
    throw new Error(missingCliproxySourceMessage(sourceDir, env));
  }

  const repoUrl = env.CLIPROXY_REPO_URL?.trim() || DEFAULT_CLIPROXY_REPO_URL;
  await ensureGitAvailable(sourceDir, repoUrl);
  await mkdir(path.dirname(sourceDir), { recursive: true });
  console.log(`没有找到 CLIProxyAPI 源码，正在自动安装到：${sourceDir}`);
  console.log(`来源：${repoUrl}`);

  try {
    await captureCommand('git', ['clone', '--depth', '1', repoUrl, sourceDir]);
  } catch (error) {
    throw new Error(
      [
        `自动安装 CLIProxyAPI 失败：${error instanceof Error ? error.message : String(error)}`,
        '',
        '你也可以手动执行：',
        `  git clone ${repoUrl} ${sourceDir}`,
        '然后重新运行 clawmarket。',
      ].join('\n'),
    );
  }

  if (!(await isReadableDirectory(sourceDir))) {
    throw new Error(missingCliproxySourceMessage(sourceDir, env));
  }
}

async function isReadableDirectory(sourceDir) {
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

async function ensureGitAvailable(sourceDir, repoUrl) {
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

function missingCliproxySourceMessage(sourceDir, env = process.env) {
  const repoUrl = env.CLIPROXY_REPO_URL?.trim() || DEFAULT_CLIPROXY_REPO_URL;
  return [
    `没有找到可读取的 CLIProxyAPI 源码目录：${sourceDir}`,
    '',
    '请执行下面任一方式后重试：',
    `  git clone ${repoUrl} ${sourceDir}`,
    `  export CLIPROXY_SOURCE_DIR=${sourceDir}`,
    '',
    '如果你已经有 CLIProxyAPI，请在 Console 设置里选择正确目录，或设置 CLIPROXY_SOURCE_DIR。',
  ].join('\n');
}

export async function ensureGoToolchain(sourceDir, env = process.env) {
  const required = await readGoModVersion(sourceDir);
  if (!required) {
    return;
  }

  // Use the same module directory as `go run`: Go can select/cache its required toolchain.
  const installed = await readInstalledGoVersion(sourceDir, env);
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

async function readGoModVersion(sourceDir) {
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

async function readInstalledGoVersion(sourceDir, env) {
  const output = await captureCommand('go', ['version'], sourceDir, env).catch(() => '');
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

function captureCommand(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
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

function compareGoVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }
  return 0;
}

function isExplicitFalse(raw) {
  const value = raw?.trim().toLowerCase();
  return value === '0' || value === 'false' || value === 'no' || value === 'off';
}

async function authDirHasFiles(authDir) {
  try {
    const entries = await readdir(authDir, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && !entry.name.startsWith('.'));
  } catch {
    return false;
  }
}

function prefixStream(stream, prefix) {
  if (!stream) {
    return;
  }
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      process.stdout.write(`${prefix}${line}\n`);
    }
  });
  stream.on('end', () => {
    if (pending) {
      process.stdout.write(`${prefix}${pending}\n`);
    }
  });
}

function parseBooleanFlag(raw) {
  const value = raw?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function parsePort(raw, label) {
  if (!raw?.trim()) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }
  return value;
}

function parseFiniteNumber(raw, label) {
  if (!raw?.trim()) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function parseOptionalJsonObject(raw, label) {
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('must decode to a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseCsv(raw) {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveConfiguredProxyUrl(env = process.env) {
  for (const key of [
    'CLIPROXY_PROXY_URL',
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
    'HTTP_PROXY',
    'http_proxy',
  ]) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return '';
}

async function detectSystemProxyUrl(env = process.env) {
  if (env.CLIPROXY_SYSTEM_PROXY_AUTODETECT?.trim().toLowerCase() === 'false') {
    return '';
  }
  if (process.platform === 'win32') {
    const output = await captureCommand('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings']).catch(() => '');
    return parseWindowsSystemProxy(output);
  }
  if (process.platform !== 'darwin') {
    return '';
  }

  const output = await captureCommand('scutil', ['--proxy']).catch(() => '');
  if (!output) {
    return '';
  }

  const httpsEnable = Number(readScutilProxyValue(output, 'HTTPSEnable') ?? '0');
  const httpsProxy = readScutilProxyValue(output, 'HTTPSProxy');
  const httpsPort = readScutilProxyValue(output, 'HTTPSPort');
  if (httpsEnable === 1 && httpsProxy && httpsPort) {
    return `http://${httpsProxy}:${httpsPort}`;
  }

  const socksEnable = Number(readScutilProxyValue(output, 'SOCKSEnable') ?? '0');
  const socksProxy = readScutilProxyValue(output, 'SOCKSProxy');
  const socksPort = readScutilProxyValue(output, 'SOCKSPort');
  if (socksEnable === 1 && socksProxy && socksPort) {
    return `socks5://${socksProxy}:${socksPort}`;
  }

  const httpEnable = Number(readScutilProxyValue(output, 'HTTPEnable') ?? '0');
  const httpProxy = readScutilProxyValue(output, 'HTTPProxy');
  const httpPort = readScutilProxyValue(output, 'HTTPPort');
  if (httpEnable === 1 && httpProxy && httpPort) {
    return `http://${httpProxy}:${httpPort}`;
  }

  return '';
}

export function parseWindowsSystemProxy(output) {
  if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(output)) return '';
  const server = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(output)?.[1]?.trim();
  if (!server) return '';
  const entries = server.split(';').map(value => value.trim());
  const https = entries.find(value => value.startsWith('https='));
  const http = entries.find(value => value.startsWith('http='));
  const selected = (https || http)?.split('=').slice(1).join('=') || entries.find(value => !value.includes('='));
  if (!selected) return '';
  return selected.includes('://') ? selected : `http://${selected}`;
}

function readScutilProxyValue(output, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm');
  const match = pattern.exec(output);
  return match?.[1]?.trim() ?? '';
}

function buildCliproxyChildEnv(options) {
  const childEnv = {
    ...process.env,
    WRITABLE_PATH: options.workDir,
  };

  if (options.proxyUrl) {
    childEnv.CLIPROXY_PROXY_URL ??= options.proxyUrl;
    childEnv.HTTPS_PROXY ??= options.proxyUrl;
    childEnv.HTTP_PROXY ??= options.proxyUrl;
    childEnv.ALL_PROXY ??= options.proxyUrl;
  }

  return childEnv;
}

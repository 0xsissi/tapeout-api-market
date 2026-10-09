import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import type { ClawMarketConfig } from './schema.js';
import { PAYMENT_TOKEN, PAYMENT_NETWORK, PAYMENT_PORT_OFFSET, CONTRACTS, DEFAULT_RPC_URL, DEFAULT_BOOTSTRAP_PEERS } from '@clawmarket/shared';
import { DEFAULT_CODEX_MODEL, DEFAULT_BUYER_SUBSCRIBED_MODELS, defaultSellerModels, normalizeConfig } from './schema.js';
import { normalizeModelPricing } from '@clawmarket/shared';
import { MIN_GAS_WEI_STRING } from '../services/chain.js';
import { getLegacySellerWalletPath, getWalletPath, migrateLegacyWallet } from '../wallet/store.js';

const retiredBootstrapPeers = () => (process.env.TAM_RETIRED_BOOTSTRAP_PEERS ?? '').split(',').map(peer => peer.trim()).filter(Boolean);

export interface CliDefaults extends ClawMarketConfig {
  paths: {
    homeDir: string;
    dataDir: string;
    configPath: string;
    logsDir: string;
    walletPath: string;
    legacySellerWalletPath: string;
    buyerLogPath: string;
    sellerLogPath: string;
  };
}

export interface CliDefaultOptions {
  cwd?: string;
  homeDir?: string;
}

export function getConfigPath(homeDir = process.env.TAM_HOME ?? process.env.HOME ?? os.homedir()): string {
  return process.env.CLAWMARKET_CONFIG_PATH ?? path.join(homeDir, '.clawmarket', PAYMENT_NETWORK === 'bsc-testnet' ? `config-${PAYMENT_TOKEN.symbol.toLowerCase()}-bsc-testnet.json` : PAYMENT_TOKEN.symbol === 'BEM' ? 'config-bem.json' : 'config.json');
}

export function getCliDefaults(options: CliDefaultOptions = {}): CliDefaults {
  const homeDir = options.homeDir ?? process.env.TAM_HOME ?? process.env.HOME ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const dataDir = path.join(homeDir, '.clawmarket', ...(PAYMENT_NETWORK === 'bsc-testnet' ? ['bsc-testnet', PAYMENT_TOKEN.symbol.toLowerCase()] : PAYMENT_TOKEN.symbol === 'BEM' ? ['bem'] : []));
  const portOffset = PAYMENT_PORT_OFFSET;
  const logsDir = path.join(dataDir, 'logs');
  const cliproxyWorkDir = path.join(dataDir, 'embedded-cliproxy-local-seller');
  const walletPath = getWalletPath(homeDir);

  return {
    settlement: {
      symbol: PAYMENT_TOKEN.symbol,
      network: PAYMENT_NETWORK,
      rpcUrl: DEFAULT_RPC_URL,
      escrowPoolAddress: CONTRACTS.ESCROW_POOL,
      maxRequestCostToken: PAYMENT_TOKEN.symbol === 'BEM' ? 0 : 0.1,
      maxUnconfirmedCreditToken: PAYMENT_TOKEN.symbol === 'BEM' ? 0 : 0.1,
      dailyLimitToken: PAYMENT_TOKEN.symbol === 'BEM' ? 0 : 1,
    },
    onboarding: {
      completedAt: null,
      role: null,
    },
    buyer: {
      url: `http://127.0.0.1:${(PAYMENT_TOKEN.symbol === 'BEM' ? 18081 : 18080) + portOffset}`,
      inputOverheadTokens: 512,
      identityPath: path.join(dataDir, 'buyer-testnet.key'),
      seedProvidersFile: PAYMENT_TOKEN.symbol === 'BEM' || PAYMENT_NETWORK === 'bsc-testnet' ? path.join(dataDir, 'remote-seller-seed.json') : '/tmp/clawmarket-remote-seller-seed-tcp.json',
      selectedModel: DEFAULT_CODEX_MODEL,
      subscribedModels: [...DEFAULT_BUYER_SUBSCRIBED_MODELS],
      minGasWei: MIN_GAS_WEI_STRING,
    },
    seller: {
      url: `http://127.0.0.1:${(PAYMENT_TOKEN.symbol === 'BEM' ? 8788 : 8787) + portOffset}`,
      walletPath,
      identityPath: path.join(dataDir, 'local-seller-test.key'),
      signingIdentityPath: path.join(dataDir, 'local-seller-signing.key.json'),
      e2eeIdentityPath: path.join(dataDir, 'local-seller-e2ee.key'),
      seedFile: PAYMENT_TOKEN.symbol === 'BEM' || PAYMENT_NETWORK === 'bsc-testnet' ? path.join(dataDir, 'local-seller-seed.json') : '/tmp/clawmarket-local-seller-seed.json',
      p2pPort: (PAYMENT_TOKEN.symbol === 'BEM' ? 19192 : 19190) + portOffset,
      cliproxySourceDir: path.resolve(cwd, '..', 'CLIProxyAPI'),
      cliproxyWorkDir,
      cliproxyAuthDir: path.join(cliproxyWorkDir, 'auths'),
      cliproxyPort: (PAYMENT_TOKEN.symbol === 'BEM' ? 4311 : 4310) + portOffset,
      upstream: 'codex',
      minGasWei: MIN_GAS_WEI_STRING,
      models: defaultSellerModels('codex'),
      pricing: {
        input: PAYMENT_TOKEN.symbol === 'BEM' ? 0 : 60,
        output: PAYMENT_TOKEN.symbol === 'BEM' ? 0 : 60,
        p0: PAYMENT_TOKEN.symbol === 'BEM' ? 0 : 60,
        alpha: 1,
        maxConcurrent: 5,
      },
    },
    network: {
      bootstrapPeers: [...DEFAULT_BOOTSTRAP_PEERS],
    },
    paths: {
      homeDir,
      dataDir,
      configPath: getConfigPath(homeDir),
      logsDir,
      walletPath,
      legacySellerWalletPath: getLegacySellerWalletPath(homeDir),
      buyerLogPath: path.join(logsDir, 'buyer.log'),
      sellerLogPath: path.join(logsDir, 'seller.log'),
    },
  };
}

export async function loadCliConfig(options: CliDefaultOptions = {}): Promise<CliDefaults> {
  const defaults = getCliDefaults(options);
  await migrateLegacyWallet({
    walletPath: defaults.paths.walletPath,
    legacyWalletPath: defaults.paths.legacySellerWalletPath,
    logger: (message) => console.log(`[wallet] ${message}`),
  });
  try {
    const raw = await readFile(defaults.paths.configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const normalized = normalizeLegacyWalletPath(
      applyEnvOverrides(migrateBootstrapPeers(normalizeConfig(parsed, defaults)), defaults),
      defaults,
    );
    return {
      ...normalized,
      paths: defaults.paths,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      ...normalizeLegacyWalletPath(applyEnvOverrides(defaults, defaults), defaults),
      paths: defaults.paths,
    };
  }
}

export async function saveCliConfig(
  config: ClawMarketConfig,
  options: CliDefaultOptions = {},
): Promise<string> {
  const defaults = getCliDefaults(options);
  const normalized = normalizeConfig(config, defaults);
  await mkdir(path.dirname(defaults.paths.configPath), { recursive: true });
  await writeFile(defaults.paths.configPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return defaults.paths.configPath;
}

export function getConfigValue(config: ClawMarketConfig, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }

    return (current as Record<string, unknown>)[segment];
  }, config);
}

export function setConfigValue(
  config: ClawMarketConfig,
  dottedPath: string,
  value: unknown,
): ClawMarketConfig {
  const segments = dottedPath.split('.').filter(Boolean);
  if (segments.length === 0) {
    throw new Error('Config path cannot be empty.');
  }
  if (segments[0] === 'paths') {
    throw new Error('The computed paths section is read-only.');
  }

  const next = structuredClone(config) as unknown as Record<string, unknown>;
  let cursor: Record<string, unknown> = next;
  for (const segment of segments.slice(0, -1)) {
    const current = cursor[segment];
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }

  cursor[segments[segments.length - 1]!] = value;
  const sellerPricing = (next as unknown as ClawMarketConfig).seller.pricing;
  if (dottedPath === 'seller.pricing.p0' && typeof value === 'number') {
    const rates = normalizeModelPricing({ model: 'seller', inputPer1m: sellerPricing.input, outputPer1m: sellerPricing.output, p0: value });
    sellerPricing.input = rates.inputPer1m; sellerPricing.output = rates.outputPer1m;
  } else if (dottedPath === 'seller.pricing.input' || dottedPath === 'seller.pricing.output') {
    sellerPricing.p0 = (sellerPricing.input + sellerPricing.output) / 2;
  }
  return normalizeConfig(next, getCliDefaults());
}

export function parseConfigValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  if (trimmed === 'null') {
    return null;
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function migrateBootstrapPeers(config: ClawMarketConfig): ClawMarketConfig {
  const retired = retiredBootstrapPeers();
  if (!config.network.bootstrapPeers.some(peer => retired.includes(peer))) {
    return config;
  }
  return {
    ...config,
    network: {
      ...config.network,
      bootstrapPeers: Array.from(new Set(config.network.bootstrapPeers.flatMap(peer =>
        retired.includes(peer) ? DEFAULT_BOOTSTRAP_PEERS : [peer],
      ))),
    },
  };
}

function applyEnvOverrides(config: ClawMarketConfig, defaults: CliDefaults): ClawMarketConfig {
  const env = process.env;

  return normalizeConfig({
    ...config,
    settlement: {
      ...config.settlement,
      rpcUrl: env.RPC_URL ?? config.settlement.rpcUrl,
      escrowPoolAddress: env.ESCROW_POOL_ADDRESS ?? config.settlement.escrowPoolAddress,
      maxRequestCostToken: env.MAX_REQUEST_COST_TOKEN !== undefined ? Number(env.MAX_REQUEST_COST_TOKEN) : config.settlement.maxRequestCostToken,
      maxUnconfirmedCreditToken: env.MAX_UNCONFIRMED_CREDIT_TOKEN !== undefined ? Number(env.MAX_UNCONFIRMED_CREDIT_TOKEN) : config.settlement.maxUnconfirmedCreditToken,
      dailyLimitToken: env.DAILY_LIMIT_TOKEN !== undefined ? Number(env.DAILY_LIMIT_TOKEN) : config.settlement.dailyLimitToken,
    },
    buyer: {
      ...config.buyer,
      url: env.CLAWMARKET_BUYER_URL ?? config.buyer.url,
      identityPath: env.CLAWMARKET_BUYER_IDENTITY_PATH ?? config.buyer.identityPath,
      seedProvidersFile: env.CLAWMARKET_SEED_PROVIDERS_FILE ?? config.buyer.seedProvidersFile,
      selectedModel: env.CLAWMARKET_MODEL ?? config.buyer.selectedModel,
      subscribedModels: env.CLAWMARKET_SUBSCRIBED_MODELS
        ? env.CLAWMARKET_SUBSCRIBED_MODELS.split(',').map((item) => item.trim()).filter(Boolean)
        : config.buyer.subscribedModels,
      minGasWei: env.CLAWMARKET_BUYER_MIN_GAS_WEI ?? config.buyer.minGasWei,
    },
    seller: {
      ...config.seller,
      url: env.CLAWMARKET_SELLER_URL ?? config.seller.url,
      walletPath: env.CLAWMARKET_SELLER_WALLET_PATH ?? config.seller.walletPath,
      identityPath: env.CLAWMARKET_SELLER_IDENTITY_PATH ?? config.seller.identityPath,
      signingIdentityPath: env.CLAWMARKET_SELLER_SIGNING_IDENTITY_PATH ?? config.seller.signingIdentityPath,
      e2eeIdentityPath: env.CLAWMARKET_SELLER_E2EE_IDENTITY_PATH ?? config.seller.e2eeIdentityPath,
      seedFile: env.CLAWMARKET_SELLER_SEED_FILE ?? config.seller.seedFile,
      p2pPort: env.CLAWMARKET_SELLER_P2P_PORT ? Number(env.CLAWMARKET_SELLER_P2P_PORT) : config.seller.p2pPort,
      cliproxySourceDir: env.CLAWMARKET_CLIPROXY_SOURCE_DIR ?? config.seller.cliproxySourceDir,
      cliproxyWorkDir: env.CLAWMARKET_CLIPROXY_WORK_DIR ?? config.seller.cliproxyWorkDir,
      cliproxyAuthDir: env.CLAWMARKET_CLIPROXY_AUTH_DIR ?? config.seller.cliproxyAuthDir,
      cliproxyPort: env.CLAWMARKET_CLIPROXY_PORT ? Number(env.CLAWMARKET_CLIPROXY_PORT) : config.seller.cliproxyPort,
      upstream: env.CLAWMARKET_SELLER_UPSTREAM ?? config.seller.upstream,
      minGasWei: env.CLAWMARKET_SELLER_MIN_GAS_WEI ?? config.seller.minGasWei,
      models: env.CLAWMARKET_SELLER_MODELS
        ? env.CLAWMARKET_SELLER_MODELS.split(',').map((item) => item.trim()).filter(Boolean)
        : config.seller.models,
      pricing: {
        input: env.CLAWMARKET_INPUT_PRICE ? Number(env.CLAWMARKET_INPUT_PRICE) : config.seller.pricing.input,
        output: env.CLAWMARKET_OUTPUT_PRICE ? Number(env.CLAWMARKET_OUTPUT_PRICE) : config.seller.pricing.output,
        p0: env.CLAWMARKET_SELLER_P0 ? Number(env.CLAWMARKET_SELLER_P0) : config.seller.pricing.p0,
        alpha: env.CLAWMARKET_SELLER_ALPHA ? Number(env.CLAWMARKET_SELLER_ALPHA) : config.seller.pricing.alpha,
        maxConcurrent: env.CLAWMARKET_SELLER_MAX_CONCURRENT
          ? Number(env.CLAWMARKET_SELLER_MAX_CONCURRENT)
          : config.seller.pricing.maxConcurrent,
      },
    },
    network: {
      ...config.network,
      bootstrapPeers: env.CLAWMARKET_BOOTSTRAP_PEERS
        ? env.CLAWMARKET_BOOTSTRAP_PEERS.split(',').map((item) => item.trim()).filter(Boolean)
        : config.network.bootstrapPeers,
    },
  }, defaults);
}

function normalizeLegacyWalletPath(config: ClawMarketConfig, defaults: CliDefaults): ClawMarketConfig {
  if (config.seller.walletPath !== defaults.paths.legacySellerWalletPath) {
    return config;
  }

  return {
    ...config,
    seller: {
      ...config.seller,
      walletPath: defaults.paths.walletPath,
    },
  };
}

export type ClawMarketRole = 'buyer' | 'seller' | 'both';
export type SellerUpstream = 'codex' | 'claude' | 'gemini';

export interface SettlementSettings {
  symbol: 'USDC' | 'BEM';
  network?: 'default' | 'bsc-testnet';
  rpcUrl: string;
  escrowPoolAddress: string;
  maxRequestCostToken: number;
  maxUnconfirmedCreditToken: number;
  dailyLimitToken: number;
}

export const DEFAULT_CODEX_MODEL = 'gpt-6.1-sol';
export const DEFAULT_BUYER_SUBSCRIBED_MODELS = [
  DEFAULT_CODEX_MODEL,
  'gpt-6-luna',
  'claude-sonnet-4',
  'claude-opus-4-7',
  'claude-haiku-4-5',
] as const;

export const SELLER_MODEL_PRESETS: Record<SellerUpstream, string[]> = {
  codex: [DEFAULT_CODEX_MODEL, 'gpt-6-luna', 'gpt-6-astra'],
  claude: ['claude-4.6-sonnet', 'claude-4.6-haiku', 'claude-4.5-opus'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
};

export function defaultSellerModels(upstream: SellerUpstream, available?: string[]): string[] {
  const presets = SELLER_MODEL_PRESETS[upstream];
  const preferred = available?.length ? presets.filter(model => available.includes(model)) : presets;
  return (preferred.length ? preferred : available ?? presets).slice(0, upstream === 'codex' ? 1 : 2);
}

/** Keep explicit selections that the account supports; otherwise prefer the current defaults. */
export function reconcileSellerModels(upstream: SellerUpstream, selected: string[], available: string[]): string[] {
  if (!available.length) return selected.length ? [...selected] : defaultSellerModels(upstream);
  const supported = selected.filter(model => available.includes(model));
  return supported.length ? supported : defaultSellerModels(upstream, available);
}

export interface ClawMarketConfig {
  settlement: SettlementSettings;
  onboarding: {
    completedAt: string | null;
    role: ClawMarketRole | null;
  };
  buyer: {
    url: string;
    inputOverheadTokens?: number;
    identityPath: string;
    seedProvidersFile: string;
    selectedModel: string;
    subscribedModels: string[];
    minGasWei: string;
  };
  seller: {
    url: string;
    walletPath: string;
    identityPath: string;
    signingIdentityPath: string;
    e2eeIdentityPath: string;
    seedFile: string;
    p2pPort: number;
    cliproxySourceDir: string;
    cliproxyWorkDir: string;
    cliproxyAuthDir: string;
    cliproxyPort: number;
    upstream: SellerUpstream;
    minGasWei: string;
    models: string[];
    pricing: {
      input: number;
      output: number;
      p0?: number;
      alpha?: number;
      maxConcurrent?: number;
    };
  };
  network: {
    bootstrapPeers: string[];
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function asNullableRole(value: unknown, fallback: ClawMarketRole | null): ClawMarketRole | null {
  return value === 'buyer' || value === 'seller' || value === 'both' ? value : fallback;
}

function asSellerUpstream(value: unknown, fallback: SellerUpstream): SellerUpstream {
  return value === 'codex' || value === 'claude' || value === 'gemini' ? value : fallback;
}

function asNullableString(value: unknown, fallback: string | null): string | null {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function settlementNumber(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('结算额度必须是非负的有效数字；不会用默认额度覆盖无效值。');
  return value;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : fallback;
}

export function normalizeConfig(input: unknown, defaults: ClawMarketConfig): ClawMarketConfig {
  const root = asRecord(input);
  if (!root) throw new Error('配置文件必须包含 JSON 对象。');
  const onboarding = asRecord(root?.onboarding);
  const buyer = asRecord(root?.buyer);
  const seller = asRecord(root?.seller);
  const pricing = asRecord(seller?.pricing);
  const network = asRecord(root?.network);
  const settlement = asRecord(root?.settlement);
  if (root.settlement !== undefined && !settlement) throw new Error('settlement 配置必须包含 JSON 对象。');

  if (settlement?.symbol != null && settlement.symbol !== defaults.settlement.symbol) {
    throw new Error('配置币种与当前选择不匹配；请使用独立的 USDC/BEM 配置。');
  }
  if (settlement?.network != null && settlement.network !== (defaults.settlement.network ?? 'default')) throw new Error('配置结算网络与当前选择不匹配；请使用独立的网络配置。');

  return {
    settlement: {
      symbol: defaults.settlement.symbol,
      network: defaults.settlement.network ?? 'default',
      rpcUrl: asString(settlement?.rpcUrl, defaults.settlement.rpcUrl),
      escrowPoolAddress: asString(settlement?.escrowPoolAddress, defaults.settlement.escrowPoolAddress),
      maxRequestCostToken: settlementNumber(settlement?.maxRequestCostToken, defaults.settlement.maxRequestCostToken),
      maxUnconfirmedCreditToken: settlementNumber(settlement?.maxUnconfirmedCreditToken, defaults.settlement.maxUnconfirmedCreditToken),
      dailyLimitToken: settlementNumber(settlement?.dailyLimitToken, defaults.settlement.dailyLimitToken),
    },
    onboarding: {
      completedAt: asNullableString(onboarding?.completedAt, defaults.onboarding.completedAt),
      role: asNullableRole(onboarding?.role, defaults.onboarding.role),
    },
    buyer: {
      url: asString(buyer?.url, defaults.buyer.url),
      inputOverheadTokens: asNumber(buyer?.inputOverheadTokens, defaults.buyer.inputOverheadTokens ?? 512),
      identityPath: asString(buyer?.identityPath, defaults.buyer.identityPath),
      seedProvidersFile: asString(buyer?.seedProvidersFile, defaults.buyer.seedProvidersFile),
      selectedModel: asString(buyer?.selectedModel, defaults.buyer.selectedModel),
      subscribedModels: asStringArray(buyer?.subscribedModels, defaults.buyer.subscribedModels),
      minGasWei: asString(buyer?.minGasWei, defaults.buyer.minGasWei),
    },
    seller: {
      url: asString(seller?.url, defaults.seller.url),
      walletPath: asString(seller?.walletPath, defaults.seller.walletPath),
      identityPath: asString(seller?.identityPath, defaults.seller.identityPath),
      signingIdentityPath: asString(seller?.signingIdentityPath, defaults.seller.signingIdentityPath),
      e2eeIdentityPath: asString(seller?.e2eeIdentityPath, defaults.seller.e2eeIdentityPath),
      seedFile: asString(seller?.seedFile, defaults.seller.seedFile),
      p2pPort: asNumber(seller?.p2pPort, defaults.seller.p2pPort),
      cliproxySourceDir: asString(seller?.cliproxySourceDir, defaults.seller.cliproxySourceDir),
      cliproxyWorkDir: asString(seller?.cliproxyWorkDir, defaults.seller.cliproxyWorkDir),
      cliproxyAuthDir: asString(seller?.cliproxyAuthDir, defaults.seller.cliproxyAuthDir),
      cliproxyPort: asNumber(seller?.cliproxyPort, defaults.seller.cliproxyPort),
      upstream: asSellerUpstream(seller?.upstream, defaults.seller.upstream),
      minGasWei: asString(seller?.minGasWei, defaults.seller.minGasWei),
      models: asStringArray(seller?.models, defaults.seller.models),
      pricing: {
        input: asNumber(pricing?.input, defaults.seller.pricing.input),
        output: asNumber(pricing?.output, defaults.seller.pricing.output),
        p0: pricing?.p0 == null ? defaults.seller.pricing.p0 : asNumber(pricing?.p0, defaults.seller.pricing.p0 ?? 0),
        alpha: pricing?.alpha == null ? defaults.seller.pricing.alpha : asNumber(pricing?.alpha, defaults.seller.pricing.alpha ?? 1),
        maxConcurrent: pricing?.maxConcurrent == null
          ? defaults.seller.pricing.maxConcurrent
          : asNumber(pricing?.maxConcurrent, defaults.seller.pricing.maxConcurrent ?? 5),
      },
    },
    network: {
      bootstrapPeers: asStringArray(network?.bootstrapPeers, defaults.network.bootstrapPeers),
    },
  };
}

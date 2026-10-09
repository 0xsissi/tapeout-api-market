/** One settlement currency per process/network. Prices are token units per 1M usage tokens. */
export interface PaymentToken {
  symbol: 'USDC' | 'BEM';
  address: `0x${string}`;
  decimals: number;
  chainId: number;
  minimumAmount: string;
}

export const USDC_PAYMENT_TOKEN: PaymentToken = {
  symbol: 'USDC', address: '0xcF0819eb156D6c6c1c5d9A515E351D2D1aefff7D',
  decimals: 6, chainId: 84532, minimumAmount: '0.01',
};
export const BEM_PAYMENT_TOKEN: PaymentToken = {
  symbol: 'BEM', address: '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a',
  decimals: 8, chainId: 56, minimumAmount: '0.01',
};
export type PaymentNetwork = 'default' | 'bsc-testnet';
export const BSC_TESTNET_USDC_PAYMENT_TOKEN: PaymentToken = {
  symbol: 'USDC', address: '0xFcc26b50731525a4452D0ED428cdf11058723B89',
  decimals: 6, chainId: 97, minimumAmount: '0.000001',
};
export const BSC_TESTNET_BEM_PAYMENT_TOKEN: PaymentToken = {
  symbol: 'BEM', address: '0x6DD0Be28736F638844499B019DBaacc5897dAAC2',
  decimals: 8, chainId: 97, minimumAmount: '0.01',
};
export function resolvePaymentNetwork(value = 'default'): PaymentNetwork {
  if (value !== 'default' && value !== 'bsc-testnet') throw new Error('CLAWMARKET_PAYMENT_NETWORK must be default or bsc-testnet');
  return value;
}
export function paymentTokenPool(token: PaymentToken): `0x${string}` {
  if (token.chainId === 97) return token.symbol === 'USDC' ? '0x90D30bA5d3e72A029335D2B879786ba912EA6e5F' : '0xfd95F0cA22D6c2Ca8dE3Bd42f88c6b94ABf6724e';
  return token.symbol === 'USDC' ? '0x8A392a77eb88f477FeF060033937a2e4692Eb56E' : '0x0000000000000000000000000000000000000000';
}

export function resolvePaymentToken(symbol = 'USDC', network: PaymentNetwork = 'default'): PaymentToken {
  resolvePaymentNetwork(network);
  if (network === 'bsc-testnet' && symbol === 'BEM') return { ...BSC_TESTNET_BEM_PAYMENT_TOKEN };
  if (network === 'bsc-testnet' && symbol === 'USDC') return { ...BSC_TESTNET_USDC_PAYMENT_TOKEN };
  if (symbol === 'BEM') return { ...BEM_PAYMENT_TOKEN };
  if (symbol === 'USDC') return { ...USDC_PAYMENT_TOKEN };
  throw new Error('CLAWMARKET_PAYMENT_TOKEN must be USDC or BEM');
}

const env = typeof process !== 'undefined' ? process.env : {};
export const PAYMENT_NETWORK = resolvePaymentNetwork(env.CLAWMARKET_PAYMENT_NETWORK?.trim());
export const PAYMENT_TOKEN = resolvePaymentToken(env.CLAWMARKET_PAYMENT_TOKEN?.trim().toUpperCase(), PAYMENT_NETWORK);
export const PAYMENT_POOL_ADDRESS = (env.ESCROW_POOL_ADDRESS || paymentTokenPool(PAYMENT_TOKEN)) as `0x${string}`;
export const PAYMENT_SCALE = 10n ** BigInt(PAYMENT_TOKEN.decimals);
export const PAYMENT_NATIVE_SYMBOL = PAYMENT_TOKEN.chainId === 97 ? 'tBNB' : PAYMENT_TOKEN.chainId === 56 ? 'BNB' : 'ETH';
export const PAYMENT_NETWORK_NAME = PAYMENT_TOKEN.chainId === 97 ? 'BSC 测试网（chain 97）' : PAYMENT_TOKEN.chainId === 56 ? 'BNB Smart Chain (BSC)' : 'Base Sepolia 测试网';
/** Explorer and funding links belong to the chain, independently of the payment currency. */
export function paymentExplorerUrl(chainId: number): string {
  if (chainId === 97) return 'https://testnet.bscscan.com';
  if (chainId === 56) return 'https://bscscan.com';
  if (chainId === 84532) return 'https://sepolia.basescan.org';
  throw new Error(`No payment explorer configured for chain ${chainId}`);
}
export function paymentFundingLinks(chainId: number): string[] {
  if (chainId === 97) return ['https://shenjige.xyz/#faucet', 'https://www.bnbchain.org/en/testnet-faucet'];
  if (chainId === 56) return [];
  if (chainId === 84532) return ['https://portal.cdp.coinbase.com/products/faucet', 'https://www.alchemy.com/faucets/base-sepolia'];
  throw new Error(`No funding links configured for chain ${chainId}`);
}
export const PAYMENT_EXPLORER_URL = paymentExplorerUrl(PAYMENT_TOKEN.chainId);
export const PAYMENT_FUNDING_LINKS = paymentFundingLinks(PAYMENT_TOKEN.chainId);
export const PAYMENT_PORT_OFFSET = PAYMENT_NETWORK === 'bsc-testnet' ? 300 : 0;
export const PAYMENT_AGENT_PORT = (PAYMENT_TOKEN.symbol === 'BEM' ? 18788 : 18787) + PAYMENT_PORT_OFFSET;
export const PAYMENT_FUNDING_HELP = PAYMENT_TOKEN.chainId === 97
  ? `测试环境：请准备 t${PAYMENT_TOKEN.symbol}，以及少量 BSC 测试网 tBNB 支付手续费。`
  : PAYMENT_TOKEN.chainId === 56
  ? '请向本钱包转入 BSC 网络的 BEM，以及少量 BNB 支付链上手续费。当前没有自动兑换功能。'
  : '测试环境：请准备本项目的测试 USDC，以及 Base Sepolia ETH 支付链上手续费。';

function decimalText(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid payment amount');
  const [mantissa, exponent] = value.toString().split('e');
  if (!exponent) return mantissa;
  const digits = mantissa.replace('.', ''), point = (mantissa.indexOf('.') < 0 ? mantissa.length : mantissa.indexOf('.')) + Number(exponent);
  return point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point);
}

/** Strict decimal parsing for deposits; never round user-entered transfer amounts. */
export function parsePaymentAmount(value: string | number, token: PaymentToken = PAYMENT_TOKEN): bigint {
  const text = typeof value === 'number' ? decimalText(value) : value;
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) throw new Error('Invalid payment amount');
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error('Invalid payment amount');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > token.decimals) throw new Error(`Amount exceeds ${token.decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(token.decimals) + BigInt(fraction.padEnd(token.decimals, '0') || '0');
}

/** Round a quoted price UP, using decimal arithmetic shared with the Python SDK. */
export function paymentPriceUnits(value: number, token: PaymentToken = PAYMENT_TOKEN): bigint {
  const [whole, fraction = ''] = decimalText(value).split('.');
  const units = BigInt(whole) * 10n ** BigInt(token.decimals) + BigInt(fraction.slice(0, token.decimals).padEnd(token.decimals, '0') || '0');
  return units + (/[1-9]/.test(fraction.slice(token.decimals)) ? 1n : 0n);
}

export function formatPaymentAmount(value: bigint, token: PaymentToken = PAYMENT_TOKEN): string {
  const scale = 10n ** BigInt(token.decimals), abs = value < 0n ? -value : value;
  const fraction = (abs % scale).toString().padStart(token.decimals, '0').replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${abs / scale}${fraction ? `.${fraction}` : ''}`;
}

export function paymentBudget(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) throw new Error('Payment budget must be positive');
  return parsePaymentAmount(value);
}

export function paymentNetworkScope(pool?: string): string {
  return PAYMENT_TOKEN.symbol === 'BEM' || PAYMENT_TOKEN.chainId === 97 ? `${PAYMENT_TOKEN.symbol.toLowerCase()}:${PAYMENT_TOKEN.chainId}:${(pool ?? env.ESCROW_POOL_ADDRESS ?? (PAYMENT_TOKEN.chainId === 97 ? PAYMENT_POOL_ADDRESS : 'unconfigured')).toLowerCase()}` : '';
}

export function matchesPaymentNetwork(announcement: { paymentToken?: PaymentToken; settlementPool?: string }): boolean {
  if (announcement.settlementPool !== undefined && typeof announcement.settlementPool !== 'string') return false;
  const token = announcement.paymentToken;
  if (!token && (PAYMENT_TOKEN.symbol !== 'USDC' || PAYMENT_TOKEN.chainId === 97)) return false;
  if (token && (token.symbol !== PAYMENT_TOKEN.symbol || typeof token.address !== 'string' || token.address.toLowerCase() !== PAYMENT_TOKEN.address.toLowerCase() || token.chainId !== PAYMENT_TOKEN.chainId || token.decimals !== PAYMENT_TOKEN.decimals)) return false;
  if (PAYMENT_TOKEN.chainId === 97 && token?.minimumAmount !== PAYMENT_TOKEN.minimumAmount) return false;
  if (PAYMENT_TOKEN.symbol === 'BEM' || PAYMENT_TOKEN.chainId === 97) {
    const pool = env.ESCROW_POOL_ADDRESS || (PAYMENT_TOKEN.chainId === 97 ? PAYMENT_POOL_ADDRESS : undefined);
    return Boolean(pool) && announcement.settlementPool?.toLowerCase() === pool?.toLowerCase();
  }
  // Legacy USDC peers omit the pool. When both sides specify one, require the same pool.
  return !announcement.settlementPool || !env.ESCROW_POOL_ADDRESS || announcement.settlementPool.toLowerCase() === env.ESCROW_POOL_ADDRESS.toLowerCase();
}

/** BEM has no implicit dollar conversion: require explicit token-denominated limits. */
export function requirePaymentLimit(value: number | undefined, legacyUsd: number | undefined, name: string): number {
  const raw = value ?? (PAYMENT_TOKEN.symbol === 'USDC' ? legacyUsd : undefined);
  if (raw == null) {
    if (PAYMENT_TOKEN.symbol === 'USDC') return 0.1;
    throw new Error(`${name} is required in BEM units`);
  }
  paymentBudget(raw);
  return raw;
}

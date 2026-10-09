export * from './types/index.js';
export * from './brand.js';
export * from './ui-localization.js';
export * from './agent-control.js';
export * from './local-api.js';
export * from './version.js';
export * from './client-policy.js';
export * from './clock.js';
export * from './model-weights.js';
export * from './pricing.js';
export * from './quote.js';
export * from './subscription-presets.js';
export * from './settlement.js';
export * from './payment-token.js';
export * from './payment-deployment.js';
export * from './model-provenance.js';
import { PAYMENT_TOKEN, PAYMENT_POOL_ADDRESS, parsePaymentAmount, paymentNetworkScope } from './payment-token.js';
export type { SubscriptionTier } from './subscription-presets.js';

// Protocol constants
export const PROTOCOL_VERSION = '3.0.0';
export const PROTOCOL_NAME = '/clawmarket/inference';
export const PROTOCOL_ID = `${PROTOCOL_NAME}/${PROTOCOL_VERSION}${paymentNetworkScope() ? `/${PAYMENT_TOKEN.symbol === 'BEM' ? 'bem' : 'payment'}/${paymentNetworkScope()}` : ''}`;

// Network defaults
export const DEFAULT_PORT = 8080;
export const DEFAULT_P2P_PORT = 9090;
export const DEFAULT_RPC_URL = PAYMENT_TOKEN.chainId === 97 ? 'https://bsc-testnet-dataseed.bnbchain.org' : PAYMENT_TOKEN.symbol === 'BEM' ? 'https://bsc-dataseed.binance.org/' : 'https://sepolia.base.org';
export const DEFAULT_CHAIN_ID = PAYMENT_TOKEN.chainId;

// Contract addresses for the explicitly selected settlement network.
export const CONTRACTS = {
  ESCROW_POOL: PAYMENT_POOL_ADDRESS,
  TOKEN: PAYMENT_TOKEN.address,
  MINING: (PAYMENT_TOKEN.symbol === 'BEM' || PAYMENT_TOKEN.chainId === 97 ? '0x0000000000000000000000000000000000000000' : '0x6f090F5Af7d53773E7a834F83C18A785Bec06C82') as `0x${string}`,
  VESTING: '0x0000000000000000000000000000000000000000' as `0x${string}`,
};

// Payment constants
export const MIN_SELLER_STAKE_USDC = 100_000_000n; // 100 USDC (6 decimals)
export const PROTOCOL_FEE_BPS = 100n; // 1% = 100 basis points
export const MIN_COST_PER_REQUEST = parsePaymentAmount(PAYMENT_TOKEN.minimumAmount);
export const WITHDRAW_DELAY_SECONDS = 48 * 60 * 60;
export const AUTH_DEFAULT_TTL_SECONDS = 15 * 60;
export const CLAIM_BATCH_MAX_SIZE = 100;

// Mining constants — Phase thresholds (cumulative USDC settled)
export const MINING_PHASES = [
  { threshold: 1_000_000_000_000n, rate: 100n },   // Phase 1: <$1M → 1 USDC = 100 CLAW
  { threshold: 5_000_000_000_000n, rate: 50n },    // Phase 2: $1M-$5M → 1 USDC = 50 CLAW
  { threshold: 20_000_000_000_000n, rate: 25n },   // Phase 3: $5M-$20M → 1 USDC = 25 CLAW
  { threshold: BigInt('0xFFFFFFFFFFFFFFFF'), rate: 10n }, // Phase 4: >$20M → 1 USDC = 10 CLAW
];

// Quality multipliers
export const QUALITY_MULTIPLIERS = {
  EXCELLENT: 150,  // TTFT < 300ms → 1.5x (stored as 150 = 1.5 * 100)
  GOOD: 120,       // TTFT < 500ms → 1.2x
  NORMAL: 100,     // TTFT < 1000ms → 1.0x
  POOR: 50,        // TTFT > 1000ms → 0.5x
};

// Operators supply node addresses at runtime; deployments are not embedded in source.
export const DEFAULT_BOOTSTRAP_PEERS: string[] = (typeof process === 'undefined' ? '' : process.env.CLAWMARKET_BOOTSTRAP_PEERS ?? process.env.BOOTSTRAP_PEERS ?? '').split(',').map(peer => peer.trim()).filter(Boolean);

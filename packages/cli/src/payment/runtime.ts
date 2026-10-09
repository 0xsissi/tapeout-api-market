import { PAYMENT_TOKEN, PAYMENT_NETWORK, CONTRACTS, DEFAULT_RPC_URL, parsePaymentAmount, verifyPaymentDeployment } from '@clawmarket/shared';
import type { SettlementSettings } from '../config/schema.js';

export function resolveSettlementSettings(settings?: SettlementSettings): SettlementSettings {
  const resolved = settings ?? {
    symbol: PAYMENT_TOKEN.symbol,
    rpcUrl: process.env.RPC_URL ?? DEFAULT_RPC_URL,
    escrowPoolAddress: process.env.ESCROW_POOL_ADDRESS ?? CONTRACTS.ESCROW_POOL,
    maxRequestCostToken: Number(process.env.MAX_REQUEST_COST_TOKEN ?? (PAYMENT_TOKEN.symbol === 'BEM' ? 0 : 0.1)),
    maxUnconfirmedCreditToken: Number(process.env.MAX_UNCONFIRMED_CREDIT_TOKEN ?? (PAYMENT_TOKEN.symbol === 'BEM' ? 0 : 0.1)),
    dailyLimitToken: Number(process.env.DAILY_LIMIT_TOKEN ?? (PAYMENT_TOKEN.symbol === 'USDC' ? process.env.DAILY_LIMIT_USD ?? 1 : 0)),
  };
  if (resolved.symbol !== PAYMENT_TOKEN.symbol) throw new Error('当前程序与配置币种不一致，请重新启动所选币种的配置。');
  if (resolved.network && resolved.network !== PAYMENT_NETWORK) throw new Error('当前程序与配置网络不一致，请重新启动所选网络的配置。');
  if (process.env.CHAIN_ID && Number(process.env.CHAIN_ID) !== PAYMENT_TOKEN.chainId) throw new Error(`所选 ${PAYMENT_TOKEN.symbol} 需要 chain ID ${PAYMENT_TOKEN.chainId}。`);
  const url = new URL(resolved.rpcUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('RPC 地址必须使用 HTTP/HTTPS，且不能包含登录凭据。');
  return resolved;
}
export async function prepareSettlementRuntime(settings: SettlementSettings | undefined, role: 'buyer' | 'seller'): Promise<NodeJS.ProcessEnv> {
  const resolved = resolveSettlementSettings(settings);
  for (const key of role === 'seller' ? ['maxRequestCostToken', 'maxUnconfirmedCreditToken', 'dailyLimitToken'] as const : ['maxRequestCostToken'] as const) {
    if (!Number.isFinite(resolved[key]) || resolved[key] <= 0) throw new Error(`请先设置 settlement.${key}，单位为 ${resolved.symbol}；不会沿用另一币种的额度。`);
    parsePaymentAmount(resolved[key]);
  }
  if (resolved.maxRequestCostToken < Number(PAYMENT_TOKEN.minimumAmount)) throw new Error(`单次额度不能小于最低结算金额 ${PAYMENT_TOKEN.minimumAmount} ${resolved.symbol}。`);
  if (role === 'seller' && (resolved.maxRequestCostToken > resolved.maxUnconfirmedCreditToken || resolved.maxRequestCostToken > resolved.dailyLimitToken)) throw new Error('卖家单次额度不能超过未确认信用额度或每日额度。');
  await verifyPaymentDeployment(resolved.escrowPoolAddress, resolved.rpcUrl, PAYMENT_TOKEN.chainId);
  return {
    CLAWMARKET_PAYMENT_TOKEN: resolved.symbol,
    CLAWMARKET_PAYMENT_NETWORK: PAYMENT_NETWORK,
    CHAIN_ID: String(PAYMENT_TOKEN.chainId),
    RPC_URL: resolved.rpcUrl,
    ESCROW_POOL_ADDRESS: resolved.escrowPoolAddress,
    MAX_REQUEST_COST_TOKEN: String(resolved.maxRequestCostToken),
    MAX_UNCONFIRMED_CREDIT_TOKEN: String(resolved.maxUnconfirmedCreditToken),
    DAILY_LIMIT_TOKEN: String(resolved.dailyLimitToken),
    CLAWMARKET_AUTH_NONCE_MODE: 'bitmap',
  };
}

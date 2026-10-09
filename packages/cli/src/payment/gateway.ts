import { CONTRACTS, PAYMENT_TOKEN } from '@clawmarket/shared';
import { fetchJson } from '../services/http.js';

/** Check the gateway before any action that spends funds or changes a seller quote. */
export function assertGatewaySettlement(payload: any, pool = process.env.ESCROW_POOL_ADDRESS ?? CONTRACTS.ESCROW_POOL): void {
  const token = payload?.paymentToken;
  const actualPool = payload?.escrowPool ?? payload?.settlementPool ?? payload?.escrow?.poolAddress;
  if (!token || token.symbol !== PAYMENT_TOKEN.symbol || token.chainId !== PAYMENT_TOKEN.chainId ||
      token.decimals !== PAYMENT_TOKEN.decimals || typeof token.address !== 'string' ||
      token.address.toLowerCase() !== PAYMENT_TOKEN.address.toLowerCase() ||
      typeof actualPool !== 'string' || actualPool.toLowerCase() !== pool.toLowerCase() ||
      (payload?.chainId != null && payload.chainId !== PAYMENT_TOKEN.chainId) ||
      (payload?.escrow?.chainId != null && payload.escrow.chainId !== PAYMENT_TOKEN.chainId)) {
    throw new Error(`网关的币种、链或托管合约与当前 ${PAYMENT_TOKEN.symbol} 配置不一致，已停止操作。请连接对应币种的服务。`);
  }
}

export async function checkGatewaySettlement(url: string, role: 'buyer' | 'seller', pool?: string): Promise<void> {
  const endpoint = role === 'buyer' ? '/v1/credits' : '/v1/seller/status';
  assertGatewaySettlement(await fetchJson(`${url.replace(/\/$/, '')}${endpoint}`), pool);
}

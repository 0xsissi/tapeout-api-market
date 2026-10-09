import { Interface } from 'ethers';
import { PAYMENT_TOKEN, PAYMENT_POOL_ADDRESS, type PaymentToken } from './payment-token.js';

const poolAbi = new Interface(['function usdc() view returns (address)', 'function miningRewards() view returns (address)']);
const tokenAbi = new Interface(['function decimals() view returns (uint8)']);

/** Read-only, fail-closed check for BEM and explicit BSC testnet pools. */
export async function assertPaymentDeployment(pool: string, rpcUrl: string, chainId: number, paymentToken: PaymentToken = PAYMENT_TOKEN): Promise<void> {
  if (paymentToken.symbol !== 'BEM' && paymentToken.chainId !== 97) return;
  await verifyPaymentDeployment(pool, rpcUrl, chainId, paymentToken);
}

/** Owner-selected currency preflight. Reads chain state without signing or sending transactions. */
export async function verifyPaymentDeployment(pool: string, rpcUrl: string, chainId: number, paymentToken: PaymentToken = PAYMENT_TOKEN): Promise<void> {
  if (paymentToken.symbol === PAYMENT_TOKEN.symbol && paymentToken.chainId === PAYMENT_TOKEN.chainId && (paymentToken.symbol === 'BEM' || paymentToken.chainId === 97) && (process.env.ESCROW_POOL_ADDRESS || (paymentToken.chainId === 97 ? PAYMENT_POOL_ADDRESS : ''))?.toLowerCase() !== pool.toLowerCase()) throw new Error('ESCROW_POOL_ADDRESS must match the payment network pool');
  if (chainId !== paymentToken.chainId) throw new Error(`${paymentToken.symbol} settlement requires chain ${paymentToken.chainId}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(pool) || /^0x0{40}$/i.test(pool)) throw new Error(`A deployed ${paymentToken.symbol} ESCROW_POOL_ADDRESS is required`);
  async function rpc(method: string, params: unknown[]): Promise<string> {
    const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`${paymentToken.symbol} deployment RPC failed`);
    const data = await response.json() as { result?: string; error?: unknown };
    if (data.error || typeof data.result !== 'string') throw new Error(`${paymentToken.symbol} deployment RPC returned an error`);
    return data.result;
  }
  const [network, code, tokenResult] = await Promise.all([
    rpc('eth_chainId', []), rpc('eth_getCode', [pool, 'latest']),
    rpc('eth_call', [{ to: pool, data: poolAbi.encodeFunctionData('usdc') }, 'latest']),
  ]);
  if (BigInt(network) !== BigInt(paymentToken.chainId)) throw new Error(`RPC chain does not match ${paymentToken.symbol} chain ${paymentToken.chainId}`);
  if (code.length <= 2) throw new Error(`${paymentToken.symbol} escrow pool has no deployed code`);
  const token = poolAbi.decodeFunctionResult('usdc', tokenResult)[0] as string;
  if (token.toLowerCase() !== paymentToken.address.toLowerCase()) throw new Error(`Escrow pool settlement token is not ${paymentToken.symbol}`);
  const decimals = tokenAbi.decodeFunctionResult('decimals', await rpc('eth_call', [{ to: token, data: tokenAbi.encodeFunctionData('decimals') }, 'latest']))[0];
  if (Number(decimals) !== paymentToken.decimals) throw new Error(`${paymentToken.symbol} token decimals do not match configured precision`);
  if (paymentToken.symbol === 'BEM') {
    const mining = poolAbi.decodeFunctionResult('miningRewards', await rpc('eth_call', [{ to: pool, data: poolAbi.encodeFunctionData('miningRewards') }, 'latest']))[0] as string;
    if (!/^0x0{40}$/i.test(mining)) throw new Error('USDC mining rewards must be disabled for BEM settlement');
  }
}

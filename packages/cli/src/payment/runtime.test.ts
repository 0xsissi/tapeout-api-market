import { afterEach, describe, expect, it, vi } from 'vitest';
import { Interface } from 'ethers';
import { PAYMENT_TOKEN } from '@clawmarket/shared';
import { getCliDefaults } from '../config/store.js';
import { prepareSettlementRuntime } from './runtime.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });
describe('settlement launch preflight', () => {
  const pool = '0x1111111111111111111111111111111111111111';
  it('reads the actual chain, deployed pool token and precision before launching USDC', async () => {
    const abi = new Interface(['function usdc() view returns (address)', 'function decimals() view returns (uint8)']);
    const fetch = vi.fn(async (_url, options) => {
      const { method, params } = JSON.parse(options.body);
      const result = method === 'eth_chainId' ? '0x' + PAYMENT_TOKEN.chainId.toString(16) : method === 'eth_getCode' ? '0x6000' : params[0].to === pool ? abi.encodeFunctionResult('usdc', [PAYMENT_TOKEN.address]) : abi.encodeFunctionResult('decimals', [PAYMENT_TOKEN.decimals]);
      return new Response(JSON.stringify({ result }));
    });
    vi.stubGlobal('fetch', fetch);
    const settings = { ...getCliDefaults().settlement, rpcUrl: 'https://rpc.fixture', escrowPoolAddress: pool };
    const env = await prepareSettlementRuntime(settings, 'seller');
    expect(env).toMatchObject({ CLAWMARKET_PAYMENT_TOKEN: 'USDC', CHAIN_ID: '84532', DAILY_LIMIT_TOKEN: '1', CLAWMARKET_AUTH_NONCE_MODE: 'bitmap', ESCROW_POOL_ADDRESS: pool });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.every(call => ['eth_chainId', 'eth_getCode', 'eth_call'].includes(JSON.parse(call[1].body).method))).toBe(true);
  });
  it('rejects mixed currency, non-token precision, empty budgets and incoherent seller limits before RPC calls', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const settings = getCliDefaults().settlement;
    for (const changes of [{ symbol: 'BEM' as const }, { maxRequestCostToken: 0 }, { maxRequestCostToken: 0.0000001 }, { maxRequestCostToken: 0.001 }, { maxUnconfirmedCreditToken: 0.01 }, { dailyLimitToken: 0.01 }, { rpcUrl: 'file:///tmp/rpc' }]) await expect(prepareSettlementRuntime({ ...settings, ...changes }, 'seller')).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    vi.stubEnv('CHAIN_ID', '56');
    await expect(prepareSettlementRuntime(settings, 'buyer')).rejects.toThrow('chain ID');
  });
  it('never reinterprets legacy dollar limits as BEM limits', async () => {
    vi.stubEnv('CLAWMARKET_PAYMENT_TOKEN', 'BEM'); vi.stubEnv('DAILY_LIMIT_USD', '500');
    vi.stubEnv('MAX_REQUEST_COST_TOKEN', '1'); vi.stubEnv('MAX_UNCONFIRMED_CREDIT_TOKEN', '1'); vi.stubEnv('DAILY_LIMIT_TOKEN', undefined);
    vi.stubEnv('CHAIN_ID', undefined); vi.resetModules();
    const module = await import('./runtime.js');
    expect(module.resolveSettlementSettings().dailyLimitToken).toBe(0);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(module.prepareSettlementRuntime(undefined, 'seller')).rejects.toThrow('dailyLimitToken');
    expect(fetch).not.toHaveBeenCalled();
  });
});

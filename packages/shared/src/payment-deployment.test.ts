import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Interface } from 'ethers';
import { BEM_PAYMENT_TOKEN as bem, USDC_PAYMENT_TOKEN as usdc, BSC_TESTNET_USDC_PAYMENT_TOKEN as bscUsdc } from './payment-token.js';
import { assertPaymentDeployment, verifyPaymentDeployment } from './payment-deployment.js';

const pool = '0x1111111111111111111111111111111111111111';
const abi = new Interface(['function usdc() view returns (address)', 'function miningRewards() view returns (address)', 'function decimals() view returns (uint8)']);
let chain = '0x38', token = bem.address, decimals = 8, mining = '0x0000000000000000000000000000000000000000';
beforeEach(() => {
  vi.stubEnv('ESCROW_POOL_ADDRESS', pool);
  chain = '0x38'; token = bem.address; decimals = 8; mining = '0x0000000000000000000000000000000000000000';
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    const { method, params } = JSON.parse(options.body);
    let result = method === 'eth_chainId' ? chain : '0x6000';
    if (method === 'eth_call') {
      const name = params[0].to === pool ? (params[0].data === abi.encodeFunctionData('usdc') ? 'usdc' : 'miningRewards') : 'decimals';
      result = abi.encodeFunctionResult(name, [name === 'usdc' ? token : name === 'miningRewards' ? mining : decimals]);
    }
    return new Response(JSON.stringify({ result }));
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('checks the real network and token precision for BSC test USDC as well', async () => {
  chain = '0x61'; token = bscUsdc.address; decimals = 6;
  await expect(assertPaymentDeployment(pool, 'http://fixture', 97, bscUsdc)).resolves.toBeUndefined();
  chain = '0x14a34'; await expect(assertPaymentDeployment(pool, 'http://fixture', 97, bscUsdc)).rejects.toThrow('RPC chain');
  chain = '0x61'; token = usdc.address; await expect(assertPaymentDeployment(pool, 'http://fixture', 97, bscUsdc)).rejects.toThrow('not USDC');
  token = bscUsdc.address; decimals = 8; await expect(assertPaymentDeployment(pool, 'http://fixture', 97, bscUsdc)).rejects.toThrow('precision');
});
it('accepts only a BSC pool with BEM, 8 decimals and mining disabled', async () => {
  await expect(assertPaymentDeployment(pool, 'http://fixture', 56, bem)).resolves.toBeUndefined();
  chain = '0x14a34'; await expect(assertPaymentDeployment(pool, 'http://fixture', 56, bem)).rejects.toThrow('RPC chain');
  chain = '0x38'; token = pool; await expect(assertPaymentDeployment(pool, 'http://fixture', 56, bem)).rejects.toThrow('not BEM');
  token = bem.address; decimals = 6; await expect(assertPaymentDeployment(pool, 'http://fixture', 56, bem)).rejects.toThrow('precision');
  decimals = 8; mining = pool; await expect(assertPaymentDeployment(pool, 'http://fixture', 56, bem)).rejects.toThrow('disabled');
});
it('rejects missing deployments and RPC failures instead of reverting to USDC defaults', async () => {
  await expect(assertPaymentDeployment('0x' + '0'.repeat(40), 'http://fixture', 56, bem)).rejects.toThrow('deployed');
  await expect(assertPaymentDeployment(pool, 'http://fixture', 84532, bem)).rejects.toThrow('56');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'offline' } }))));
  await expect(assertPaymentDeployment(pool, 'http://fixture', 56, bem)).rejects.toThrow('RPC');
});

it('also verifies USDC deployments for owner-selected CLI profiles', async () => {
  chain = '0x' + usdc.chainId.toString(16); token = usdc.address; decimals = usdc.decimals; mining = pool;
  await expect(verifyPaymentDeployment(pool, 'http://fixture', usdc.chainId, usdc)).resolves.toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(4); // No USDC mining configuration is changed.
  token = bem.address;
  await expect(verifyPaymentDeployment(pool, 'http://fixture', usdc.chainId, usdc)).rejects.toThrow('not USDC');
});

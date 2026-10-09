import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClawMarket } from './index.js';
import { BEM_PAYMENT_TOKEN as bem, lockedPrices, inputTokenBudget, tokenCost, USDC_PAYMENT_TOKEN as usdc, resolvePaymentToken } from '@clawmarket/shared';
vi.mock('@clawmarket/shared', async (original) => ({ ...await original<typeof import('@clawmarket/shared')>(), assertPaymentDeployment: vi.fn(async () => {}) }));
const pool = '0x1111111111111111111111111111111111111111', seller = '0x2222222222222222222222222222222222222222';
const request = { model: 'fixture', messages: [{ role: 'user' as const, content: 'hello' }], max_tokens: 1000 };
const config = { privateKey: ('0x' + '33'.repeat(32)) as `0x${string}`, escrowPoolAddress: pool as `0x${string}`, rpcUrl: 'http://fixture-rpc', baseURL: 'http://fixture', paymentToken: 'BEM' as const, maxRequestCostToken: 10 };
afterEach(() => vi.restoreAllMocks());
describe('BEM SDK delivery confirmation', () => {
  it.each([{ stream: false, network: 'default' as const }, { stream: true, network: 'default' as const }, { stream: false, network: 'bsc-testnet' as const }, { stream: true, network: 'bsc-testnet' as const }])('signs the actual 8-decimal BEM cost after delivery ($network, stream=$stream)', async ({ stream, network }) => {
    let prepared: any, final: any;
    const pricing = { model: 'fixture', inputPer1m: 1000, outputPer1m: 2000 };
    const prices = lockedPrices(pricing, undefined, bem), input = inputTokenBudget(request);
    const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
    const fetch = vi.fn(async (url, options) => {
      if (String(url).endsWith('/prepare')) return new Response(JSON.stringify(prepared));
      if (String(url).endsWith('/settle')) { final = JSON.parse(options!.body as string).authorization; return new Response('{"accepted":true}'); }
      const meta = { preparedRequestId: 'prepared' };
      return stream ? new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }) + '\n\ndata: ' + JSON.stringify({ clawSettlement: meta, usage }) + '\n\ndata: [DONE]\n\n') : new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }], usage, clawSettlement: meta }));
    });
    const client = new ClawMarket({ ...config, paymentNetwork: network, fetch });
    prepared = { preparedRequestId: 'prepared', requestId: 'request', paymentToken: resolvePaymentToken('BEM', network), provider: { walletAddress: seller, pricing },
      authorization: { buyer: client.buyerAddress, seller, amount: tokenCost(input, 1000, prices.inputPrice, prices.outputPrice, bem).toString(), nonce: '1', nonceMode: 'bitmap',
        expiresAt: Math.floor(Date.now() / 1000) + 600, poolId: '0x' + pool.slice(2).padStart(64, '0'), requestId: 'request', payloadHash: '0x' + '00'.repeat(32),
        inputPrice: prices.inputPrice.toString(), outputPrice: prices.outputPrice.toString(), maxInputTokens: input, maxOutputTokens: 1000 },
      typedData: { domain: { name: 'ClawInferenceIntent', chainId: network === 'bsc-testnet' ? 97 : 56, verifyingContract: pool } } };
    const result = await client.chat.completions.create({ ...request, stream });
    if (stream) for await (const _chunk of result as AsyncIterable<unknown>) { /* consume and confirm */ }
    expect(final.amount).toBe('5000000'); // 0.05 BEM, not 5 USDC or 0.0005 BEM
    expect(final.signature).toMatch(/^0x[0-9a-f]+$/);
  });
  it('requires explicit BSC network selection and refuses legacy metadata and wrong-network permits', async () => {
    expect(() => new ClawMarket({ ...config, paymentToken: 'USDC', chainId: 97 })).toThrow('selected payment network');
    const client = new ClawMarket({ ...config, paymentToken: 'USDC', paymentNetwork: 'bsc-testnet', chainId: 97 });
    await expect(client.createExecutionToken({} as any)).rejects.toThrow('currency');
    await expect(client.createExecutionToken({ paymentToken: usdc } as any)).rejects.toThrow('currency');
    await expect(client.depositWithPermit({ tokenAddress: usdc.address, amount: 1 })).rejects.toThrow('selected payment network');
    await expect(client.createExecutionToken({ paymentToken: resolvePaymentToken('USDC', 'bsc-testnet'), authorization: { amount: '1' }, typedData: { domain: { name: 'ClawInferenceIntent', chainId: 84532, verifyingContract: pool } } } as any)).rejects.toThrow('domain');
  });
  it('requires token limits and refuses the wrong currency before signing', async () => {
    expect(() => new ClawMarket({ ...config, maxRequestCostToken: undefined })).toThrow('BEM units');
    const client = new ClawMarket(config);
    await expect(client.createExecutionToken({ paymentToken: usdc } as any)).rejects.toThrow('currency');
    await expect(client.depositWithPermit({ tokenAddress: bem.address, amount: 1 })).rejects.toThrow('depositWithApproval');
  });
});

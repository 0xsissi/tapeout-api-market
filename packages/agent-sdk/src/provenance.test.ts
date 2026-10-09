import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelProvenanceRequestBinding, ModelProvenanceTextDigest } from '@clawmarket/crypto';
import { inputTokenBudget, lockedPrices, resolvePaymentToken, tokenCost } from '@clawmarket/shared';
import { ClawMarket } from './index.js';
vi.mock('@clawmarket/shared', async original => ({ ...await original<typeof import('@clawmarket/shared')>(), assertPaymentDeployment: vi.fn(async () => {}) }));

const pool = '0x1111111111111111111111111111111111111111' as const, seller = '0x2222222222222222222222222222222222222222';
const base = { privateKey: ('0x' + '33'.repeat(32)) as `0x${string}`, escrowPoolAddress: pool, rpcUrl: 'http://fixture-rpc', baseURL: 'http://fixture', paymentNetwork: 'bsc-testnet' as const };
const policy = { mode: 'required' as const, allowedOrigins: ['https://official.example'] };
afterEach(() => vi.restoreAllMocks());

describe('hosted SDK provenance payment guard', () => {
  async function fixture(stream: boolean, failure?: string) {
    const request = { model: 'fixture', messages: [{ role: 'user' as const, content: 'hello' }], max_tokens: 128, stream };
    const token = resolvePaymentToken('USDC', 'bsc-testnet');
    const pricing = { model: 'fixture', inputPer1m: 1, outputPer1m: 2 }, prices = lockedPrices(pricing, undefined, token);
    const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
    let prepared: any;
    const verify = vi.fn(async () => failure === 'invalid' ? null : { origin: failure === 'origin' ? 'https://imitation.example' : 'https://official.example', model: failure === 'model' ? 'cheap-model' : 'fixture' });
    const fetchImpl = vi.fn(async (url, options) => {
      if (String(url).endsWith('/prepare')) return new Response(JSON.stringify(prepared));
      if (String(url).endsWith('/settle')) return new Response('{"accepted":true}');
      const digest = new ModelProvenanceTextDigest(); digest.update('hello');
      const binding = { ...modelProvenanceRequestBinding(request, { ...prepared.authorization, amount: BigInt(prepared.authorization.amount), nonce: 1n,
        inputPrice: prices.inputPrice, outputPrice: prices.outputPrice, signature: '0x' }, 97), responseHash: failure === 'response' ? 'tampered' : digest.digest(), usage };
      const proof = failure === 'missing' ? undefined : { version: 1, scheme: 'test-only', binding, evidence: { fixture: true }, verified: true };
      const terminal = { choices: [{ message: { content: 'hello' }, delta: {}, finish_reason: 'stop' }], usage,
        clawSettlement: { preparedRequestId: 'prepared' }, modelProvenanceProof: proof, tamProvenance: { status: 'verified', origin: 'fabricated' } };
      if (failure === 'extra_choice') terminal.choices.push({ message: { content: 'unverified other answer' }, delta: {}, finish_reason: 'stop' });
      return stream ? new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hello' } }], tamProvenance: { status: 'verified' } }) + '\n\ndata: ' + JSON.stringify(terminal) + '\n\ndata: [DONE]\n\n') : new Response(JSON.stringify(terminal));
    });
    const client = new ClawMarket({ ...base, fetch: fetchImpl, modelProvenance: policy, modelProvenanceVerifier: { scheme: 'test-only', verify } });
    const sign = vi.spyOn((client as any).signer, 'signAuthorization');
    prepared = { preparedRequestId: 'prepared', requestId: 'request', paymentToken: token, provider: { walletAddress: seller, pricing },
      authorization: { buyer: client.buyerAddress, seller, amount: tokenCost(inputTokenBudget(request), 128, prices.inputPrice, prices.outputPrice, token).toString(),
        nonce: '1', nonceMode: 'bitmap', expiresAt: Math.floor(Date.now() / 1000) + 600, poolId: '0x' + pool.slice(2).padStart(64, '0'), requestId: 'request', payloadHash: '0x' + '00'.repeat(32),
        inputPrice: prices.inputPrice.toString(), outputPrice: prices.outputPrice.toString(), maxInputTokens: inputTokenBudget(request), maxOutputTokens: 128 },
      typedData: { domain: { name: 'ClawInferenceIntent', chainId: 97, verifyingContract: pool } } };
    return { client, request, sign, verify, fetchImpl };
  }

  it.each([false, true])('verifies before signing and replaces hosted status with its own result, stream=%s', async stream => {
    const { client, request, sign, verify } = await fixture(stream);
    const result = await client.chat.completions.create(request);
    let completion: any = result;
    if (stream) {
      const chunks: any[] = []; for await (const chunk of result as AsyncIterable<any>) chunks.push(chunk);
      expect(chunks[0]).not.toHaveProperty('tamProvenance'); completion = chunks.at(-1);
    }
    expect(completion.tamProvenance).toEqual({ status: 'verified', scheme: 'test-only', origin: 'https://official.example', model: 'fixture' });
    expect(sign).toHaveBeenCalledOnce(); expect(verify.mock.invocationCallOrder[0]).toBeLessThan(sign.mock.invocationCallOrder[0]);
  });

  it.each([false, true].flatMap(stream => ['missing', 'response', 'origin', 'model', 'invalid', 'extra_choice'].map(failure => ({ stream, failure }))))('does not sign or submit a settlement after $failure, stream=$stream', async ({ stream, failure }) => {
    const { client, request, sign, fetchImpl } = await fixture(stream, failure);
    await expect((async () => { const result = await client.chat.completions.create(request); if (stream) for await (const _chunk of result as AsyncIterable<any>) {} })()).rejects.toThrow('Model provenance verification failed');
    expect(sign).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/settle'))).toBe(false);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/prepare'))).toHaveLength(1);
  });

  it('rejects required mode without a verifier before contacting a gateway', () => {
    expect(() => new ClawMarket({ ...base, modelProvenance: policy })).toThrow('verifier_unavailable');
  });
});

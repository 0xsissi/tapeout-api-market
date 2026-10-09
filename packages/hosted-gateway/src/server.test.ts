import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { decrypt, encrypt, generateKeyPair, verifyAuthorizationSignature, verifyInferenceIntent, getDefaultAuthorizationDomain, modelProvenanceRequestBinding, ModelProvenanceTextDigest } from '@clawmarket/crypto';
import { ClawMarket } from '../../agent-sdk/src/index.js';
import { HostedGateway } from './server.js';
import type { SignedInferenceIntent } from '@clawmarket/shared';

describe('hosted delivery and SDK final payment', () => {
  const pool = '0x1111111111111111111111111111111111111111' as const;
  let gateway: HostedGateway;
  afterEach(async () => { await gateway?.stop(); });

  async function setup(rejectAck = false, provenance = false) {
    const seller = ethers.Wallet.createRandom(), buyer = ethers.Wallet.createRandom();
    const providerKey = generateKeyPair(), gatewayKey = generateKeyPair();
    const provider = { announcement: { peerId: 'test-provider', walletAddress: seller.address, publicKey: Buffer.from(providerKey.publicKey).toString('hex'), multiaddrs: [] },
      modelPricing: { model: 'test-model', inputPer1m: 100, outputPer1m: 100 }, score: 1 };
    const router = { recordObservedLatency: vi.fn(), observeProvider: vi.fn(), markSuccess: vi.fn(), markFailed: vi.fn(), markTemporarilyUnavailable: vi.fn() };
    const receipts: any[] = [];
    const handler = { async *sendRequest(_peer: string, request: any, options: any) {
      const intent = request.authorization as SignedInferenceIntent;
      expect(await verifyInferenceIntent(intent, pool, 84532)).toBe(true);
      expect(await verifyAuthorizationSignature(intent, buyer.address as `0x${string}`, getDefaultAuthorizationDomain(pool))).toBe(false);
      yield { type: 'stream_chunk', requestId: request.requestId, payload: await encrypt(JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }), providerKey.privateKey, gatewayKey.publicKey), timestamp: Date.now() };
      yield { type: 'stream_chunk', requestId: request.requestId, payload: await encrypt(JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 20, total_tokens: 21 } }), providerKey.privateKey, gatewayKey.publicKey), timestamp: Date.now() };
      const body = JSON.parse(await decrypt(request.payload, providerKey.privateKey, gatewayKey.publicKey));
      const digest = new ModelProvenanceTextDigest(); digest.update('hello');
      const usage = { prompt_tokens: 1, completion_tokens: 20, total_tokens: 21 };
      const terminal = { type: 'stream_end', requestId: request.requestId, usage, timestamp: Date.now(),
        modelProvenanceProof: provenance ? { version: 1, scheme: 'test-only', binding: { ...modelProvenanceRequestBinding(body, intent, 84532), responseHash: digest.digest(), usage }, evidence: { fixture: true } } : undefined };
      yield terminal;
      const final = await options.settle(terminal);
      expect(await verifyAuthorizationSignature(final, buyer.address as `0x${string}`, getDefaultAuthorizationDomain(pool))).toBe(true);
      expect(final.amount).toBe(10_000n);
      if (rejectAck) throw new Error('Provider disk failure');
      receipts.push(final);
    } };
    gateway = new HostedGateway({ port: 0, host: '127.0.0.1', escrowPoolAddress: pool, rpcUrl: 'http://127.0.0.1:1', chainId: 84532 }, router as any, handler as any, gatewayKey);
    vi.spyOn((gateway as any).scheduler, 'select').mockResolvedValue({ provider, alternatives: [] });
    await gateway.start();
    const port = (gateway as any).server.address().port;
    const baseURL = `http://127.0.0.1:${port}`;
    const client = new ClawMarket({ baseURL, privateKey: buyer.privateKey as `0x${string}`, escrowPoolAddress: pool, rpcUrl: 'http://127.0.0.1:1',
      ...(provenance ? { modelProvenance: { mode: 'required' as const, allowedOrigins: ['https://official.example'] },
        modelProvenanceVerifier: { scheme: 'test-only', verify: async () => ({ origin: 'https://official.example', model: 'test-model' }) } } : {}) });
    return { client, receipts, baseURL };
  }

  it('delivers a nonstream result before asking for a spendable signature, then waits for provider acknowledgement', async () => {
    const { client, receipts } = await setup();
    const result = await client.chat.completions.create({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }], max_tokens: 128 }) as any;
    expect(result.choices[0].message.content).toBe('hello');
    expect(receipts).toHaveLength(1);
  });

  it('completes streaming settlement without buffering the whole HTTP response', async () => {
    const { client, receipts } = await setup();
    const stream = await client.chat.completions.create({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }], max_tokens: 128, stream: true }) as AsyncIterable<any>;
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks[0].choices[0].delta.content).toBe('hello');
    expect(receipts).toHaveLength(1);
  });

  it('reports final settlement failure instead of acknowledging an unpersisted payment', async () => {
    const { client, receipts } = await setup(true);
    await expect(client.chat.completions.create({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }], max_tokens: 128 })).rejects.toThrow();
    expect(receipts).toHaveLength(0);
  });

  it('rejects oversized request bodies and does not expose the gas relayer without an access token', async () => {
    const { baseURL } = await setup();
    const oversized = await fetch(`${baseURL}/v1/claw/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(1_048_577) });
    expect(oversized.status).toBe(413);
    const relayer = await fetch(`${baseURL}/v1/claw/deposit/permit`, { method: 'POST', body: '{}' });
    expect(relayer.status).toBe(401);
  });

  it.each([false, true])('forwards proof through the hosted gateway for buyer-local verification, stream=%s', async stream => {
    const { client, receipts } = await setup(false, true);
    const result = await client.chat.completions.create({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }], max_tokens: 128, stream });
    let completion: any = result;
    if (stream) for await (const chunk of result as AsyncIterable<any>) completion = chunk;
    expect(completion.tamProvenance).toEqual({ status: 'verified', scheme: 'test-only', origin: 'https://official.example', model: 'test-model' });
    expect(receipts).toHaveLength(1);
  });
});

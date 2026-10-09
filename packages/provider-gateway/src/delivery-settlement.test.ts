import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { AuthorizationSigner, bytesToHex, encrypt, generateKeyPair, hashInferencePayload, poolIdFromAddress, verifyAuthorizationSignature, getDefaultAuthorizationDomain, modelProvenanceRequestBinding, ModelProvenanceTextDigest } from '@clawmarket/crypto';
import { encodeMessage, decodeMessage } from '@clawmarket/p2p-node';
import { PAYMENT_SCALE, PAYMENT_TOKEN, inputTokenBudget, lockedPrices, tokenCost, settlementAmount, type ProtocolMessage, type SignedInferenceIntent, type ProviderInferenceBackend } from '@clawmarket/shared';
import { ProviderGateway, type P2PStream } from './sidecar.js';
import { BillingManager } from './billing.js';

describe('delivery-confirmed settlement with real signatures and a local upstream', () => {
  const expectedActualCost = PAYMENT_TOKEN.chainId === 97 && PAYMENT_TOKEN.symbol === 'USDC' ? 2_100n : PAYMENT_SCALE / 100n;
  const pool = '0x1111111111111111111111111111111111111111' as const;
  let home: string;
  let server: http.Server;
  let gateway: ProviderGateway;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'claw-delivery-'));
    vi.stubEnv('HOME', home);
  });
  afterEach(async () => {
    gateway?.billing.close(); gateway?.protection.destroy();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true });
  });

  async function setup(complete = true, inferenceBackend?: ProviderInferenceBackend) {
    const seller = ethers.Wallet.createRandom();
    const buyer = ethers.Wallet.createRandom();
    const sellerKey = generateKeyPair(), buyerKey = generateKeyPair();
    let upstreamCalls = 0;
    server = http.createServer((_req, res) => {
      upstreamCalls++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      res.write('data: {"usage":{"prompt_tokens":1,"completion_tokens":20,"total_tokens":21}}\n\n');
      res.end(complete ? 'data: [DONE]\n\n' : '');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const pricing = { model: 'test-model', inputPer1m: 100, outputPer1m: 100 };
    gateway = new ProviderGateway({ privateKey: seller.privateKey as `0x${string}`, e2eePrivateKey: bytesToHex(sellerKey.privateKey) as `0x${string}`,
      proxyUrl: `http://127.0.0.1:${(server.address() as any).port}`, models: [pricing], dailyLimitUsd: 1,
      trustedBuyerAddresses: [buyer.address], escrowPoolAddress: pool, rpcUrl: 'http://127.0.0.1:1', chainId: PAYMENT_TOKEN.chainId, bootstrapPeers: [] }, undefined, { inferenceBackend });
    vi.spyOn(gateway.billing, 'supportsBitmapAuthorizations').mockResolvedValue(true);
    vi.spyOn(gateway.billing, 'isPoolNonceUsed').mockResolvedValue(false);
    vi.spyOn(gateway.billing, 'getClaimableBalance').mockResolvedValue(1_000_000n);
    vi.spyOn(gateway.claimBatcher, 'flush').mockResolvedValue(null);
    const signer = new AuthorizationSigner(buyer.privateKey as `0x${string}`, pool, 'http://127.0.0.1:1', PAYMENT_TOKEN.chainId);
    const body = { model: 'test-model', messages: [{ role: 'user' as const, content: 'reply ok' }], max_tokens: 128 };
    const payload = await encrypt(JSON.stringify(body), buyerKey.privateKey, sellerKey.publicKey);
    const prices = lockedPrices(pricing);
    const intent = await signer.signInferenceIntent({ buyer: signer.address, seller: seller.address as `0x${string}`,
      amount: tokenCost(inputTokenBudget(body), 128, prices.inputPrice, prices.outputPrice), nonce: 1n,
      expiresAt: Math.floor(Date.now()/1000) + 600, poolId: poolIdFromAddress(pool), nonceMode: 'bitmap',
      requestId: 'delivery-test', payloadHash: hashInferencePayload(payload), ...prices, maxInputTokens: inputTokenBudget(body), maxOutputTokens: 128 });
    const request = { type: 'request' as const, requestId: intent.requestId, buyerAddress: signer.address, buyerPublicKey: bytesToHex(buyerKey.publicKey), model: body.model, payload, authorization: intent, timestamp: Date.now() };
    return { intent, signer, request, body, getCalls: () => upstreamCalls };
  }

  async function execute(data: Awaited<ReturnType<typeof setup>>, confirm: boolean) {
    const messages: ProtocolMessage[] = [];
    let terminalResolve: (value: ProtocolMessage) => void;
    const terminal = new Promise<ProtocolMessage>(resolve => { terminalResolve = resolve; });
    const stream: P2PStream = {
      source: (async function* () {
        yield encodeMessage(data.request);
        if (confirm) {
          const end = await terminal;
          if (end.type === 'error') return;
          const { buyer, seller, nonce, expiresAt, poolId, nonceMode } = data.intent;
          const authorization = await data.signer.signAuthorization({ buyer, seller, nonce, expiresAt, poolId, nonceMode,
            amount: settlementAmount(data.intent, (end as any).usage) });
          yield encodeMessage({ type: 'authorization', requestId: data.intent.requestId, authorization, timestamp: Date.now() } as ProtocolMessage);
        }
      })(),
      sink: async source => { for await (const chunk of source) {
        const message = decodeMessage(chunk)!.message;
        messages.push(message);
        if (message.type === 'stream_end' || message.type === 'error') terminalResolve!(message);
      } }, close: async () => {},
    };
    await (gateway as any)._handleStream(stream);
    return messages;
  }

  it('cannot redeem the initial intent, and collects actual usage only after delivery confirmation', async () => {
    const data = await setup();
    expect(await verifyAuthorizationSignature(data.intent, data.signer.address, getDefaultAuthorizationDomain(pool, PAYMENT_TOKEN.chainId))).toBe(false);
    const messages = await execute(data, true);
    expect(messages.at(-1)?.type).toBe('settlement_ack');
    const payments = gateway.billing.getQueuedAuthorizations();
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe(expectedActualCost);
    expect(payments[0].amount).toBeLessThan(data.intent.amount);
    expect(await verifyAuthorizationSignature(payments[0], data.signer.address, getDefaultAuthorizationDomain(pool, PAYMENT_TOKEN.chainId))).toBe(true);
  });

  it('does not collect without a confirmation and rejects replay after the unpaid delivery', async () => {
    const data = await setup();
    await execute(data, false);
    expect(gateway.billing.getQueuedAuthorizationCount()).toBe(0);
    expect(gateway.protection.dailySpendUsd).toBe(Number(expectedActualCost) / Number(PAYMENT_SCALE));
    await execute(data, false);
    expect(data.getCalls()).toBe(1);
  });

  it('atomically reserves one intent under concurrent requests and persists the reservation', async () => {
    const data = await setup();
    const outcomes = await Promise.allSettled([
      gateway.billing.reserveIntent(data.intent, data.intent.buyer, data.intent.seller),
      gateway.billing.reserveIntent(data.intent, data.intent.buyer, data.intent.seller),
    ]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    gateway.billing.close();
    const recovered = new BillingManager(pool, 'http://127.0.0.1:1', PAYMENT_TOKEN.chainId, 60_000, data.intent.seller);
    vi.spyOn(recovered, 'supportsBitmapAuthorizations').mockResolvedValue(true);
    vi.spyOn(recovered, 'isPoolNonceUsed').mockResolvedValue(false);
    vi.spyOn(recovered, 'getClaimableBalance').mockResolvedValue(1_000_000n);
    try { await expect(recovered.reserveIntent(data.intent, data.intent.buyer, data.intent.seller)).rejects.toThrow('already reserved'); }
    finally { recovered.close(); }
  });

  it('does not charge a truncated upstream response', async () => {
    const data = await setup(false);
    const messages = await execute(data, true);
    expect(messages.at(-1)?.type).toBe('error');
    expect(messages.some(m => m.type === 'stream_end')).toBe(false);
    expect(gateway.billing.getQueuedAuthorizationCount()).toBe(0);
  });

  it('prevents a second process from opening the same seller ledger', async () => {
    const data = await setup();
    expect(() => new BillingManager(pool, 'http://127.0.0.1:1', PAYMENT_TOKEN.chainId, 60_000, data.intent.seller)).toThrow('ledger is locked');
  });

  it('caps unconfirmed exposure even when the buyer has plenty of escrow funds', async () => {
    const data = await setup();
    await gateway.billing.reserveIntent(data.intent, data.intent.buyer, data.intent.seller);
    const { signature: _, ...original } = data.intent;
    const second = await data.signer.signInferenceIntent({ ...original, nonce: 2n, requestId: 'second-request' });
    await expect(gateway.billing.reserveIntent(second, second.buyer, second.seller, data.intent.amount)).rejects.toThrow('credit limit');
  });

  it('fails closed on a corrupt payment ledger instead of silently losing claims', () => {
    const directory = path.join(home, '.clawmarket-provider'); mkdirSync(directory);
    const file = path.join(directory, 'claim-queue.json'); writeFileSync(file, '{broken');
    expect(() => new BillingManager(pool, 'http://127.0.0.1:1', PAYMENT_TOKEN.chainId)).toThrow('refusing to discard payments');
  });

  it('uses the pluggable upstream transport and carries a bound proof to the buyer', async () => {
    const inferenceBackend: ProviderInferenceBackend = { async *stream({ binding }) {
      yield { type: 'chunk', content: 'hello' };
      const digest = new ModelProvenanceTextDigest(); digest.update('hello');
      const usage = { prompt_tokens: 1, completion_tokens: 20, total_tokens: 21 };
      yield { type: 'complete', usage, modelProvenanceProof: { version: 1, scheme: 'test-only', binding: { ...binding, responseHash: digest.digest(), usage }, evidence: { fixture: true } } };
    } };
    const data = await setup(true, inferenceBackend);
    const messages = await execute(data, true);
    expect(data.getCalls()).toBe(0);
    const terminal = messages.find(m => m.type === 'stream_end') as any;
    expect(terminal.modelProvenanceProof.binding).toEqual(expect.objectContaining(modelProvenanceRequestBinding(data.body, data.intent, PAYMENT_TOKEN.chainId)));
    expect(messages.at(-1)?.type).toBe('settlement_ack');
    expect(gateway.billing.getQueuedAuthorizationCount()).toBe(1);
  });

  it.each(['tampered', 'incomplete', 'exception'])('does not create a payment for an invalid adapter delivery: %s', async failure => {
    const inferenceBackend: ProviderInferenceBackend = { async *stream({ binding }) {
      if (failure === 'exception') throw new Error('PRIVATE upstream credential');
      yield { type: 'chunk', content: 'hello' };
      if (failure === 'incomplete') return;
      const usage = { prompt_tokens: 1, completion_tokens: 20, total_tokens: 21 };
      yield { type: 'complete', usage, modelProvenanceProof: { version: 1, scheme: 'test-only', binding: { ...binding, responseHash: 'wrong', usage }, evidence: null } };
    } };
    const data = await setup(true, inferenceBackend);
    const messages = await execute(data, true);
    expect(messages.at(-1)?.type).toBe('error');
    expect(messages.some(m => m.type === 'stream_end')).toBe(false);
    expect(gateway.billing.getQueuedAuthorizationCount()).toBe(0);
    expect(JSON.stringify(messages)).not.toContain('PRIVATE upstream credential');
  });
});

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { bytesToHex, encrypt, generateKeyPair, hashInferencePayload } from '@clawmarket/crypto';
import { decodeMessage, encodeMessage } from '@clawmarket/p2p-node';
import { inputTokenBudget, signQuote, lockedPrices } from '@clawmarket/shared';
import type { InferenceRequest, ProtocolMessage, QuoteMessage, SignedAuthorization } from '@clawmarket/shared';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderGateway, type P2PStream } from './sidecar.js';

describe('ProviderGateway sink-backed writes', () => {
  let proxyServer: http.Server | null = null;
  let gateway: ProviderGateway | null = null;

  afterEach(async () => {
    gateway?.protection.destroy();
    gateway?.billing.close();
    gateway = null;
    if (proxyServer) {
      const server = proxyServer;
      proxyServer = null;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it('uses one long-lived sink for stream_start, chunks, and stream_end', async () => {
    const proxyUrl = await startStreamingProxy();
    const providerWallet = ethers.Wallet.createRandom();
    const providerE2ee = generateKeyPair();
    const buyerWallet = ethers.Wallet.createRandom();
    const buyerE2ee = generateKeyPair();

    gateway = new ProviderGateway(
      {
        privateKey: providerWallet.privateKey as `0x${string}`,
        e2eePrivateKey: bytesToHex(providerE2ee.privateKey) as `0x${string}`,
        proxyUrl,
        models: [{ model: 'gpt-5.4', inputPer1m: 1, outputPer1m: 2 }],
        dailyLimitUsd: 100,
        trustedBuyerAddresses: [buyerWallet.address],
        escrowPoolAddress: '0x0000000000000000000000000000000000000001',
        rpcUrl: 'http://127.0.0.1:8545',
        chainId: 84532,
        bootstrapPeers: [],
      },
      async () => {
        throw new Error('p2p factory is not used by this test');
      },
    );

    vi.spyOn(gateway.billing, 'reserveIntent').mockResolvedValue(undefined);
    vi.spyOn(gateway.billing, 'acceptSettlement').mockResolvedValue(undefined);
    vi.spyOn(gateway.claimBatcher, 'flush').mockResolvedValue(null);
    vi.spyOn(gateway.claimBatcher, 'queueAuthorization').mockResolvedValue(undefined);

    const payload = await encrypt(
      JSON.stringify({
        model: 'gpt-5.4',
        stream: true,
        messages: [{ role: 'user', content: 'reply ok' }],
      }),
      buyerE2ee.secretKey,
      providerE2ee.publicKey,
    );
    const request = makeRequest({
      buyerAddress: buyerWallet.address as `0x${string}`,
      sellerAddress: providerWallet.address as `0x${string}`,
      buyerPublicKey: bytesToHex(buyerE2ee.publicKey),
      payload,
      quote: makeQuote({
        makerId: 'provider-peer',
        makerAddress: providerWallet.address as `0x${string}`,
        currentPrice: 2.5,
        privateKey: providerWallet.privateKey as `0x${string}`,
      }),
    });

    const written: Uint8Array[] = [];
    let sinkCalls = 0;
    const stream: P2PStream = {
      source: (async function* () {
        yield encodeMessage(request);
        yield encodeMessage({ type: 'authorization', requestId: request.requestId, authorization: request.authorization, timestamp: Date.now() } as ProtocolMessage);
      })(),
      sink: vi.fn(async (source) => {
        sinkCalls++;
        if (sinkCalls > 1) {
          throw new Error('libp2p stream.sink can only be called once');
        }
        for await (const chunk of source) {
          written.push(chunk);
        }
      }),
      close: vi.fn(async () => {}),
    };

    await (gateway as unknown as { _handleStream(stream: P2PStream): Promise<void> })._handleStream(stream);

    expect(stream.sink).toHaveBeenCalledOnce();
    expect(decodeTypes(written)).toEqual([
      'stream_start',
      'stream_chunk',
      'stream_chunk',
      'stream_end',
      'settlement_ack',
    ]);
    const endMessage = decodeMessages(written).at(-2) as any;
    expect(endMessage.upstreamProof).toMatchObject({
      requestId: 'req-sink',
      model: 'gpt-5.4',
      pricedAt: 2.5,
      quoteUsed: {
        makerId: 'provider-peer',
        currentPrice: 2.5,
      },
      usage: {
        prompt_tokens: 1,
        completion_tokens: 2,
        total_tokens: 3,
      },
    });
  });

  it('rejects outdated client versions before billing or proxy forwarding', async () => {
    const providerWallet = ethers.Wallet.createRandom();
    const providerE2ee = generateKeyPair();
    const buyerWallet = ethers.Wallet.createRandom();
    const buyerE2ee = generateKeyPair();

    gateway = new ProviderGateway(
      {
        privateKey: providerWallet.privateKey as `0x${string}`,
        e2eePrivateKey: bytesToHex(providerE2ee.privateKey) as `0x${string}`,
        proxyUrl: 'http://127.0.0.1:1',
        models: [{ model: 'gpt-5.4', inputPer1m: 1, outputPer1m: 2 }],
        dailyLimitUsd: 100,
        trustedBuyerAddresses: [buyerWallet.address],
        escrowPoolAddress: '0x0000000000000000000000000000000000000001',
        rpcUrl: 'http://127.0.0.1:8545',
        chainId: 84532,
        bootstrapPeers: [],
      },
      async () => {
        throw new Error('p2p factory is not used by this test');
      },
    );
    (gateway as any).clientPolicy.updateOverride({
      minClientVersion: '0.2.0',
      recommendedVersion: '0.2.3',
    });
    const verifyAuthorization = vi.spyOn(gateway.billing, 'verifyAuthorization');

    const payload = await encrypt(
      JSON.stringify({
        model: 'gpt-5.4',
        stream: true,
        messages: [{ role: 'user', content: 'reply ok' }],
      }),
      buyerE2ee.secretKey,
      providerE2ee.publicKey,
    );
    const request = {
      ...makeRequest({
        buyerAddress: buyerWallet.address as `0x${string}`,
        sellerAddress: providerWallet.address as `0x${string}`,
        buyerPublicKey: bytesToHex(buyerE2ee.publicKey),
        payload,
      }),
      clientVersion: '0.1.0',
    };

    const written: Uint8Array[] = [];
    const stream: P2PStream = {
      source: (async function* () {
        yield encodeMessage(request);
        yield encodeMessage({ type: 'authorization', requestId: request.requestId, authorization: request.authorization, timestamp: Date.now() } as ProtocolMessage);
      })(),
      sink: vi.fn(async (source) => {
        for await (const chunk of source) {
          written.push(chunk);
        }
      }),
      close: vi.fn(async () => {}),
    };

    await (gateway as unknown as { _handleStream(stream: P2PStream): Promise<void> })._handleStream(stream);

    const messages = decodeMessages(written);
    expect(messages.map((message) => message.type)).toEqual(['error']);
    expect(messages[0]).toMatchObject({
      type: 'error',
      error: expect.stringContaining('"type":"client_upgrade_required"'),
    });
    expect(verifyAuthorization).not.toHaveBeenCalled();
  });

  it('returns a 429-style soft reject payload when provider load is already above the threshold', async () => {
    const providerWallet = ethers.Wallet.createRandom();
    const providerE2ee = generateKeyPair();
    const buyerWallet = ethers.Wallet.createRandom();
    const buyerE2ee = generateKeyPair();

    gateway = new ProviderGateway(
      {
        privateKey: providerWallet.privateKey as `0x${string}`,
        e2eePrivateKey: bytesToHex(providerE2ee.privateKey) as `0x${string}`,
        proxyUrl: 'http://127.0.0.1:1',
        models: [{ model: 'gpt-5.4', inputPer1m: 1, outputPer1m: 2 }],
        dailyLimitUsd: 100,
        trustedBuyerAddresses: [buyerWallet.address],
        escrowPoolAddress: '0x0000000000000000000000000000000000000001',
        rpcUrl: 'http://127.0.0.1:8545',
        chainId: 84532,
        bootstrapPeers: [],
      },
      async () => {
        throw new Error('p2p factory is not used by this test');
      },
    );
    for (let index = 0; index < gateway.protection.maxConcurrent; index++) {
      await gateway.protection.acquire();
    }

    const payload = await encrypt(
      JSON.stringify({
        model: 'gpt-5.4',
        stream: true,
        messages: [{ role: 'user', content: 'reply ok' }],
      }),
      buyerE2ee.secretKey,
      providerE2ee.publicKey,
    );
    const request = makeRequest({
      buyerAddress: buyerWallet.address as `0x${string}`,
      sellerAddress: providerWallet.address as `0x${string}`,
      buyerPublicKey: bytesToHex(buyerE2ee.publicKey),
      payload,
    });

    const written: Uint8Array[] = [];
    const stream: P2PStream = {
      source: (async function* () {
        yield encodeMessage(request);
        yield encodeMessage({ type: 'authorization', requestId: request.requestId, authorization: request.authorization, timestamp: Date.now() } as ProtocolMessage);
      })(),
      sink: vi.fn(async (source) => {
        for await (const chunk of source) {
          written.push(chunk);
        }
      }),
      close: vi.fn(async () => {}),
    };

    await (gateway as unknown as { _handleStream(stream: P2PStream): Promise<void> })._handleStream(stream);

    const messages = decodeMessages(written);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'error',
      providerHint: {
        loadHint: 1,
        inflight: gateway.protection.maxConcurrent,
      },
    });
    expect(messages[0]?.error).toContain('"type":"backpressure_soft_reject"');
    expect(messages[0]?.error).toContain('"statusCode":429');
  });

  it('rejects duplicate request replays before forwarding upstream a second time', async () => {
    let upstreamRequests = 0;
    proxyServer = http.createServer((_req, res) => {
      upstreamRequests++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.write('data: {"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n');
      res.end('data: [DONE]\n\n');
    });

    await new Promise<void>((resolve, reject) => {
      proxyServer?.once('error', reject);
      proxyServer?.listen(0, '127.0.0.1', () => {
        proxyServer?.off('error', reject);
        resolve();
      });
    });

    const address = proxyServer.address() as AddressInfo;
    const proxyUrl = `http://127.0.0.1:${address.port}`;
    const providerWallet = ethers.Wallet.createRandom();
    const providerE2ee = generateKeyPair();
    const buyerWallet = ethers.Wallet.createRandom();
    const buyerE2ee = generateKeyPair();

    gateway = new ProviderGateway(
      {
        privateKey: providerWallet.privateKey as `0x${string}`,
        e2eePrivateKey: bytesToHex(providerE2ee.privateKey) as `0x${string}`,
        proxyUrl,
        models: [{ model: 'gpt-5.4', inputPer1m: 1, outputPer1m: 2 }],
        dailyLimitUsd: 100,
        trustedBuyerAddresses: [buyerWallet.address],
        escrowPoolAddress: '0x0000000000000000000000000000000000000001',
        rpcUrl: 'http://127.0.0.1:8545',
        chainId: 84532,
        bootstrapPeers: [],
      },
      async () => {
        throw new Error('p2p factory is not used by this test');
      },
    );

    vi.spyOn(gateway.billing, 'reserveIntent').mockResolvedValue(undefined);
    vi.spyOn(gateway.billing, 'acceptSettlement').mockResolvedValue(undefined);
    vi.spyOn(gateway.claimBatcher, 'flush').mockResolvedValue(null);
    vi.spyOn(gateway.claimBatcher, 'queueAuthorization').mockResolvedValue(undefined);

    const payload = await encrypt(
      JSON.stringify({
        model: 'gpt-5.4',
        stream: true,
        messages: [{ role: 'user', content: 'reply ok' }],
      }),
      buyerE2ee.secretKey,
      providerE2ee.publicKey,
    );

    const request = makeRequest({
      requestId: 'req-duplicate',
      buyerAddress: buyerWallet.address as `0x${string}`,
      sellerAddress: providerWallet.address as `0x${string}`,
      buyerPublicKey: bytesToHex(buyerE2ee.publicKey),
      payload,
    });

    const firstStream = makeCollectingStream(request);
    await (gateway as unknown as { _handleStream(stream: P2PStream): Promise<void> })._handleStream(firstStream.stream);

    const secondStream = makeCollectingStream(request);
    await (gateway as unknown as { _handleStream(stream: P2PStream): Promise<void> })._handleStream(secondStream.stream);

    expect(upstreamRequests).toBe(1);
    expect(decodeTypes(firstStream.written)).toEqual(['stream_start', 'stream_chunk', 'stream_chunk', 'stream_end', 'settlement_ack']);
    expect(decodeMessages(secondStream.written)).toMatchObject([
      {
        type: 'error',
        requestId: 'req-duplicate',
        error: expect.stringContaining('"type":"duplicate_request"'),
      },
    ]);
  });

  it('enters upstream quota cooling when the proxy returns HTTP 429', async () => {
    proxyServer = http.createServer((_req, res) => {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '7',
      });
      res.end(JSON.stringify({
        error: {
          type: 'usage_limit_reached',
          message: 'The usage limit has been reached',
        },
      }));
    });

    await new Promise<void>((resolve, reject) => {
      proxyServer?.once('error', reject);
      proxyServer?.listen(0, '127.0.0.1', () => {
        proxyServer?.off('error', reject);
        resolve();
      });
    });

    const address = proxyServer.address() as AddressInfo;
    const proxyUrl = `http://127.0.0.1:${address.port}`;
    const providerWallet = ethers.Wallet.createRandom();
    const providerE2ee = generateKeyPair();
    const buyerWallet = ethers.Wallet.createRandom();
    const buyerE2ee = generateKeyPair();

    gateway = new ProviderGateway(
      {
        privateKey: providerWallet.privateKey as `0x${string}`,
        e2eePrivateKey: bytesToHex(providerE2ee.privateKey) as `0x${string}`,
        proxyUrl,
        models: [{ model: 'gpt-5.4', inputPer1m: 1, outputPer1m: 2 }],
        dailyLimitUsd: 100,
        trustedBuyerAddresses: [buyerWallet.address],
        escrowPoolAddress: '0x0000000000000000000000000000000000000001',
        rpcUrl: 'http://127.0.0.1:8545',
        chainId: 84532,
        bootstrapPeers: [],
      },
      async () => {
        throw new Error('p2p factory is not used by this test');
      },
    );

    vi.spyOn(gateway.billing, 'reserveIntent').mockResolvedValue(undefined);
    vi.spyOn(gateway.billing, 'acceptSettlement').mockResolvedValue(undefined);
    vi.spyOn(gateway.claimBatcher, 'flush').mockResolvedValue(null);
    vi.spyOn(gateway.claimBatcher, 'queueAuthorization').mockResolvedValue(undefined);

    const payload = await encrypt(
      JSON.stringify({
        model: 'gpt-5.4',
        stream: true,
        messages: [{ role: 'user', content: 'reply ok' }],
      }),
      buyerE2ee.secretKey,
      providerE2ee.publicKey,
    );

    const stream = makeCollectingStream(makeRequest({
      requestId: 'req-upstream-quota',
      buyerAddress: buyerWallet.address as `0x${string}`,
      sellerAddress: providerWallet.address as `0x${string}`,
      buyerPublicKey: bytesToHex(buyerE2ee.publicKey),
      payload,
    }));

    await (gateway as unknown as { _handleStream(stream: P2PStream): Promise<void> })._handleStream(stream.stream);

    expect(decodeMessages(stream.written)).toMatchObject([
      { type: 'stream_start', requestId: 'req-upstream-quota' },
      {
        type: 'error',
        requestId: 'req-upstream-quota',
        error: expect.stringContaining('"type":"upstream_quota"'),
      },
    ]);
    expect(gateway.protection.isOffline).toBe(true);
    expect(gateway.protection.offlineRemainingSeconds).toBe(7);
    expect(gateway.protection.forcedOfflineReason).toBe('upstream_quota');
  });

  it('cools only the affected AIMM account when multiple upstream accounts exist', async () => {
    proxyServer = http.createServer((_req, res) => {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '7',
        'x-cliproxy-auth-index': 'auth-a',
      });
      res.end(JSON.stringify({
        error: {
          type: 'usage_limit_reached',
          message: 'The usage limit has been reached',
        },
      }));
    });

    await new Promise<void>((resolve, reject) => {
      proxyServer?.once('error', reject);
      proxyServer?.listen(0, '127.0.0.1', () => {
        proxyServer?.off('error', reject);
        resolve();
      });
    });

    const address = proxyServer.address() as AddressInfo;
    const proxyUrl = `http://127.0.0.1:${address.port}`;
    const providerWallet = ethers.Wallet.createRandom();
    const providerE2ee = generateKeyPair();
    const buyerWallet = ethers.Wallet.createRandom();
    const buyerE2ee = generateKeyPair();

    gateway = new ProviderGateway(
      {
        privateKey: providerWallet.privateKey as `0x${string}`,
        e2eePrivateKey: bytesToHex(providerE2ee.privateKey) as `0x${string}`,
        proxyUrl,
        models: [{ model: 'gpt-5.4', inputPer1m: 1, outputPer1m: 2 }],
        aimmCliproxyManagementUrl: 'http://127.0.0.1:3121',
        aimmAccountTiers: [
          { authIndex: 'auth-a', tier: 'chatgpt-plus' },
          { authIndex: 'auth-b', tier: 'chatgpt-plus' },
        ],
        dailyLimitUsd: 100,
        trustedBuyerAddresses: [buyerWallet.address],
        escrowPoolAddress: '0x0000000000000000000000000000000000000001',
        rpcUrl: 'http://127.0.0.1:8545',
        chainId: 84532,
        bootstrapPeers: [],
      },
      async () => {
        throw new Error('p2p factory is not used by this test');
      },
    );

    vi.spyOn(gateway.billing, 'reserveIntent').mockResolvedValue(undefined);
    vi.spyOn(gateway.billing, 'acceptSettlement').mockResolvedValue(undefined);
    vi.spyOn(gateway.claimBatcher, 'flush').mockResolvedValue(null);
    vi.spyOn(gateway.claimBatcher, 'queueAuthorization').mockResolvedValue(undefined);

    const payload = await encrypt(
      JSON.stringify({
        model: 'gpt-5.4',
        stream: true,
        messages: [{ role: 'user', content: 'reply ok' }],
      }),
      buyerE2ee.secretKey,
      providerE2ee.publicKey,
    );

    const stream = makeCollectingStream(makeRequest({
      requestId: 'req-upstream-account-cooling',
      buyerAddress: buyerWallet.address as `0x${string}`,
      sellerAddress: providerWallet.address as `0x${string}`,
      buyerPublicKey: bytesToHex(buyerE2ee.publicKey),
      payload,
    }));

    await (gateway as unknown as { _handleStream(stream: P2PStream): Promise<void> })._handleStream(stream.stream);

    expect(gateway.protection.isOffline).toBe(false);
    expect(gateway.metricsSnapshot.coolingAccounts).toBe(1);
    expect(gateway.quotaWindowTracker?.perAccount()).toEqual([
      { authIndex: 'auth-a', uPrimary: 0, uWeekly: 0, u: 0.999, source: 'forced' },
      { authIndex: 'auth-b', uPrimary: 0, uWeekly: 0, u: 0, source: 'window' },
    ]);
  });

  async function startStreamingProxy(): Promise<string> {
    proxyServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.write('data: {"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n');
      res.end('data: [DONE]\n\n');
    });

    await new Promise<void>((resolve, reject) => {
      proxyServer?.once('error', reject);
      proxyServer?.listen(0, '127.0.0.1', () => {
        proxyServer?.off('error', reject);
        resolve();
      });
    });

    const address = proxyServer.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }
});

function makeRequest(input: {
  requestId?: string;
  buyerAddress: `0x${string}`;
  sellerAddress: `0x${string}`;
  buyerPublicKey: string;
  payload: string;
  quote?: QuoteMessage;
}): InferenceRequest {
  const authorization = {
    buyer: input.buyerAddress,
    seller: input.sellerAddress,
    amount: 10_000n,
    nonce: 1n,
    expiresAt: Math.floor(Date.now() / 1000) + 900,
    poolId: '0x0000000000000000000000000000000000000000000000000000000000000001',
    signature: '0xsig', nonceMode: 'bitmap',
    requestId: input.requestId ?? 'req-sink', payloadHash: hashInferencePayload(input.payload),
    ...lockedPrices({ model: 'gpt-5.4', inputPer1m: 1, outputPer1m: 2 }, input.quote?.currentPrice),
    maxInputTokens: inputTokenBudget({ model: 'gpt-5.4', stream: true, messages: [{ role: 'user', content: 'reply ok' }] }),
    maxOutputTokens: 1024,
  };

  return {
    type: 'request',
    requestId: input.requestId ?? 'req-sink',
    buyerAddress: input.buyerAddress,
    buyerPublicKey: input.buyerPublicKey,
    model: 'gpt-5.4',
    payload: input.payload,
    authorization,
    quote: input.quote,
    timestamp: Date.now(),
  };
}

function makeQuote(input: {
  makerId: string;
  makerAddress: `0x${string}`;
  currentPrice: number;
  privateKey: `0x${string}`;
}): QuoteMessage {
  return signQuote({
    makerId: input.makerId,
    makerAddress: input.makerAddress,
    nonce: '0000000000000001',
    model: 'gpt-5.4',
    p0: 2,
    alpha: 1,
    utilization: 0.25,
    maxConcurrent: 5,
    currentPrice: input.currentPrice,
    recentLatencyMs: 100,
    successRate: 1,
    timestamp: Date.now(),
    ttlMs: 10_000,
    schemaVersion: 1,
  }, input.privateKey);
}

function makeCollectingStream(request: InferenceRequest): { stream: P2PStream; written: Uint8Array[] } {
  const written: Uint8Array[] = [];
  return {
    written,
    stream: {
      source: (async function* () {
        yield encodeMessage(request);
        yield encodeMessage({ type: 'authorization', requestId: request.requestId, authorization: request.authorization, timestamp: Date.now() } as ProtocolMessage);
      })(),
      sink: vi.fn(async (source) => {
        for await (const chunk of source) {
          written.push(chunk);
        }
      }),
      close: vi.fn(async () => {}),
    },
  };
}

function decodeTypes(chunks: Uint8Array[]): ProtocolMessage['type'][] {
  return decodeMessages(chunks).map((message) => message.type);
}

function decodeMessages(chunks: Uint8Array[]): ProtocolMessage[] {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  const messages: ProtocolMessage[] = [];
  let remaining = combined;
  while (remaining.length > 0) {
    const decoded = decodeMessage(remaining);
    if (!decoded) {
      throw new Error('incomplete protocol message');
    }
    messages.push(decoded.message);
    remaining = remaining.slice(decoded.bytesRead);
  }
  return messages;
}

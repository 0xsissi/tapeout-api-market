import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_COST_PER_REQUEST, PAYMENT_TOKEN, formatPaymentAmount } from '@clawmarket/shared';

const {
  decrypt,
  deserializePublicKey,
  encrypt,
  generateKeyPair,
  poolIdFromAddress,
  serializePublicKey,
} = vi.hoisted(() => ({
  decrypt: vi.fn(),
  deserializePublicKey: vi.fn(),
  encrypt: vi.fn(),
  generateKeyPair: vi.fn(() => ({
    publicKey: new Uint8Array([1, 2, 3]),
    privateKey: new Uint8Array([4, 5, 6]),
  })),
  poolIdFromAddress: vi.fn(() =>
    '0x0000000000000000000000000000000000000000000000000000000000000001'
  ),
  serializePublicKey: vi.fn(() => 'buyer-public-key'),
}));

vi.mock('@clawmarket/crypto', async (importOriginal) => ({
  ...await importOriginal<any>(),
  AuthorizationSigner: vi.fn(),
  decrypt,
  deserializePublicKey,
  encrypt,
  generateKeyPair,
  poolIdFromAddress,
  serializePublicKey,
}));

function makeProvider(peerId: string, walletAddress: `0x${string}`) {
  return {
    announcement: {
      peerId,
      walletAddress,
      publicKey: `${peerId}-public-key`,
      multiaddrs: [
        `/dns4/${peerId}.example.com/tcp/19100/p2p/${peerId}`,
        `/dns4/bootstrap.example.com/tcp/9090/p2p/relay/p2p-circuit/p2p/${peerId}`,
      ],
      models: [],
      region: 'apac',
      maxConcurrent: 5,
      stakeAmount: 100n,
      reputation: {
        score: 90,
        totalTransactions: 10,
        successRate: 0.99,
        avgLatencyMs: 100,
      },
      timestamp: Date.now(),
      signature: '0xsig',
    },
    modelPricing: {
      model: 'gpt-test',
      inputPer1m: 1,
      outputPer1m: 2,
    },
    score: 10,
  };
}

function makeQuote(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    makerId: 'peer-a',
    makerAddress: '0x0000000000000000000000000000000000000011',
    nonce: '0000000000000001',
    model: 'gpt-test',
    p0: 2,
    alpha: 1,
    utilization: 0.25,
    maxConcurrent: 5,
    currentPrice: 4,
    recentLatencyMs: 100,
    successRate: 0.99,
    timestamp: Date.now(),
    ttlMs: 10_000,
    schemaVersion: 1,
    signature: '0xquote',
    ...overrides,
  };
}

function makeJsonRequest(body: unknown, headers?: Record<string, string>) {
  return Object.assign(
    Readable.from([Buffer.from(JSON.stringify(body))]) as any,
    { headers: { authorization: 'Bearer test-api-token', ...(headers ?? {}) } },
  );
}

function makeGetRequest(url: string, headers?: Record<string, string>) {
  return Object.assign(Readable.from([]) as any, {
    method: 'GET',
    url,
    headers: { authorization: 'Bearer test-api-token', ...(headers ?? {}) },
  });
}

class MockResponse {
  statusCode: number | undefined;
  headers: Record<string, string> = {};
  body = '';
  headersSent = false;
  writableEnded = false;

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  write(chunk: string): boolean {
    this.body += chunk;
    this.headersSent = true;
    return true;
  }

  end(chunk?: string): this {
    if (chunk) {
      this.body += chunk;
    }
    this.headersSent = true;
    this.writableEnded = true;
    return this;
  }
}

async function createGateway(overrides?: {
  router?: Record<string, unknown>;
  streamHandler?: Record<string, unknown>;
  qualityMonitor?: Record<string, unknown>;
  poolManager?: Record<string, unknown>;
  authorizationSigner?: Record<string, unknown>;
  consumerOptions?: Record<string, unknown>;
  consumerConfig?: Record<string, unknown>;
}) {
  const { ConsumerGateway } = await import('./local-server.js');

  const router = {
    findProviders: vi.fn(),
    listModels: vi.fn(async (modelHints: string[]) => modelHints),
    listCachedModels: vi.fn((modelHints: string[] = []) => modelHints),
    getCachedProviders: vi.fn(() => []),
    selectBest: vi.fn(),
    selectBestExcluding: vi.fn(),
    isProviderAvailable: vi.fn().mockResolvedValue(true),
    markFailed: vi.fn(),
    markPeerUnreachable: vi.fn(),
    markTemporarilyUnavailable: vi.fn(),
    markSuccess: vi.fn(),
    stopRefreshLoop: vi.fn(),
    ...overrides?.router,
  };
  const wallet = {
    getAddress: vi.fn(() => '0x00000000000000000000000000000000000000bb'),
    exportWallet: vi.fn(async () => ({
      address: '0x00000000000000000000000000000000000000bb',
      balance: '12.5',
      nativeBalance: '0.0005',
      nativeBalanceWei: '500000000000000',
    })),
  };
  const streamHandler = {
    sendRequest: vi.fn(),
    ...overrides?.streamHandler,
  };
  const qualityMonitor = {
    startRequest: vi.fn(),
    recordFirstToken: vi.fn(),
    endRequest: vi.fn(),
    ...overrides?.qualityMonitor,
  };
  const poolManager = {
    ensureSufficientBalance: vi.fn().mockResolvedValue(undefined),
    getAvailableBalance: vi.fn().mockResolvedValue(3_250_000n),
    getPendingWithdraw: vi.fn().mockResolvedValue({ amount: 0n, unlockAt: 0n }),
    getTokenAddress: vi.fn().mockResolvedValue('0x00000000000000000000000000000000000000cc'),
    allocateAuthorizationNonce: vi.fn().mockResolvedValue({ nonce: 1n, nonceMode: 'bitmap' }),
    depositWithApproval: vi.fn().mockResolvedValue({
      approvalTx: '0xapprove',
      depositTx: '0xdeposit',
    }),
    requestWithdraw: vi.fn().mockResolvedValue('0xwithdraw'),
    cancelWithdraw: vi.fn().mockResolvedValue('0xcancel'),
    completeWithdraw: vi.fn().mockResolvedValue('0xcomplete'),
    ...overrides?.poolManager,
  };
  const authorizationSigner = {
    signInferenceIntent: vi.fn(async (intent) => ({ ...intent, signature: '0xintent' })),
    signAuthorization: vi.fn(async (authorization) => ({ ...authorization, signature: '0xfinal' })),
    createAuthorization: vi.fn(async (seller, amount, nonce, expiresAt, poolId, nonceMode) => ({
      buyer: '0x00000000000000000000000000000000000000bb',
      seller,
      amount,
      nonce,
      expiresAt,
      poolId,
      nonceMode,
      signature: '0xauth',
    })),
    ...overrides?.authorizationSigner,
  };

  const gateway = new ConsumerGateway(
    {
      port: 3000,
      apiToken: 'test-api-token',
      rpcUrl: 'http://127.0.0.1:8545',
      chainId: 84532,
      escrowPoolAddress: '0x00000000000000000000000000000000000000aa',
      privateKey: '0x1111111111111111111111111111111111111111111111111111111111111111',
      ...overrides?.consumerConfig,
    } as any,
    router as any,
    wallet as any,
    streamHandler as any,
    qualityMonitor as any,
    overrides?.consumerOptions as any,
  );

  (gateway as any).poolManager = poolManager;
  (gateway as any).authorizationSigner = authorizationSigner;

  return {
    authorizationSigner,
    gateway,
    poolManager,
    qualityMonitor,
    router,
    streamHandler,
  };
}

describe('ConsumerGateway', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('filters out circuit-broken quotes before sampling providers', async () => {
    const expensiveProvider = makeProvider(
      'peer-hot',
      '0x0000000000000000000000000000000000000011',
    );
    const healthyProvider = makeProvider(
      'peer-cool',
      '0x0000000000000000000000000000000000000022',
    );
    const quoteCache = {
      size: vi.fn(() => 2),
      active: vi.fn(() => [
        {
          makerId: 'peer-hot',
          makerAddress: '0x0000000000000000000000000000000000000011',
          nonce: '0000000000000001',
          model: 'gpt-test',
          p0: 2,
          alpha: 1,
          utilization: 0.999,
          maxConcurrent: 5,
          currentPrice: 150,
          recentLatencyMs: 100,
          successRate: 0.99,
          timestamp: Date.now(),
          ttlMs: 10_000,
          schemaVersion: 1,
          signature: '0xquote-hot',
        },
        {
          makerId: 'peer-cool',
          makerAddress: '0x0000000000000000000000000000000000000022',
          nonce: '0000000000000002',
          model: 'gpt-test',
          p0: 2,
          alpha: 1,
          utilization: 0.25,
          maxConcurrent: 5,
          currentPrice: 4,
          recentLatencyMs: 100,
          successRate: 0.99,
          timestamp: Date.now(),
          ttlMs: 10_000,
          schemaVersion: 1,
          signature: '0xquote-cool',
        },
      ]),
    };
    const { gateway, router } = await createGateway({
      router: {
        findProviders: vi.fn().mockResolvedValue([expensiveProvider, healthyProvider]),
      },
      consumerOptions: {
        quoteCache,
        softmaxBeta: 3,
      },
    });

    const selection = await (gateway as any).selectQuoteBackedProvider('gpt-test', new Set<string>());

    expect(selection.result).toBeDefined();
    expect(selection.result.provider.announcement.peerId).toBe('peer-cool');
    expect(selection.result.quote.currentPrice).toBe(4);
    expect(quoteCache.active).toHaveBeenCalledWith('gpt-test');
    expect(router.findProviders).toHaveBeenCalledWith('gpt-test');
  }, 15_000);

  it('keeps quote-less providers eligible when another seller has the only active AIMM quote', async () => {
    const quotedProvider = makeProvider(
      'peer-quoted',
      '0x0000000000000000000000000000000000000011',
    );
    quotedProvider.modelPricing.inputPer1m = 80;
    quotedProvider.modelPricing.outputPer1m = 80;

    const legacyProvider = makeProvider(
      'peer-legacy',
      '0x0000000000000000000000000000000000000022',
    );
    legacyProvider.modelPricing.inputPer1m = 10;
    legacyProvider.modelPricing.outputPer1m = 10;

    const quoteCache = {
      size: vi.fn(() => 1),
      active: vi.fn(() => [
        makeQuote({
          makerId: 'peer-quoted',
          makerAddress: '0x0000000000000000000000000000000000000011',
          currentPrice: 80,
          p0: 80,
        }),
      ]),
    };

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const { gateway } = await createGateway({
        router: {
          findProviders: vi.fn().mockResolvedValue([quotedProvider, legacyProvider]),
        },
        consumerOptions: {
          quoteCache,
          softmaxBeta: 3,
        },
      });

      const selection = await (gateway as any).selectQuoteBackedProvider('gpt-test', new Set<string>());

      expect(selection.result).toBeDefined();
      expect(selection.result.provider.announcement.peerId).toBe('peer-legacy');
      expect(selection.result.quote).toBeNull();
      expect(selection.result.currentPrice).toBe(10);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('reports no_quote_cache when AIMM quote cache is not configured', async () => {
    const { gateway } = await createGateway();

    const selection = await (gateway as any).selectQuoteBackedProvider('gpt-test', new Set<string>());

    expect(selection).toEqual({
      fallback: 'no_quote_cache',
      cacheSize: 0,
      activeQuoteCount: 0,
    });
  });

  it('reports no_active_quotes when the cache has no quote for the model', async () => {
    const quoteCache = {
      size: vi.fn(() => 0),
      active: vi.fn(() => []),
    };
    const { gateway } = await createGateway({
      consumerOptions: { quoteCache },
    });

    const selection = await (gateway as any).selectQuoteBackedProvider('gpt-test', new Set<string>());

    expect(selection).toEqual({
      fallback: 'no_active_quotes',
      cacheSize: 0,
      activeQuoteCount: 0,
    });
  });

  it('reports price_circuit_tripped when active quotes exceed the quote price circuit', async () => {
    const quoteCache = {
      size: vi.fn(() => 1),
      active: vi.fn(() => [
        makeQuote({ makerId: 'peer-hot', currentPrice: 150, p0: 2 }),
      ]),
    };
    const { gateway } = await createGateway({
      consumerOptions: { quoteCache },
    });

    const selection = await (gateway as any).selectQuoteBackedProvider('gpt-test', new Set<string>());

    expect(selection).toMatchObject({
      fallback: 'price_circuit_tripped',
      cacheSize: 1,
      activeQuoteCount: 1,
    });
  });

  it('reports all_candidates_filtered when quotes are excluded by caller filters', async () => {
    const quoteCache = {
      size: vi.fn(() => 1),
      active: vi.fn(() => [
        makeQuote({ makerId: 'peer-a', currentPrice: 4, p0: 2 }),
      ]),
    };
    const { gateway } = await createGateway({
      consumerOptions: { quoteCache },
    });

    const selection = await (gateway as any).selectQuoteBackedProvider('gpt-test', new Set<string>(['peer-a']));

    expect(selection).toMatchObject({
      fallback: 'all_candidates_filtered',
      cacheSize: 1,
      activeQuoteCount: 1,
    });
  });

  it('falls back to a legacy-priced provider when the only active quote does not map to a discovered provider', async () => {
    const quoteCache = {
      size: vi.fn(() => 1),
      active: vi.fn(() => [
        makeQuote({ makerId: 'peer-with-quote', currentPrice: 4, p0: 2 }),
      ]),
    };
    const { gateway, router } = await createGateway({
      router: {
        findProviders: vi.fn().mockResolvedValue([
          makeProvider('other-peer', '0x0000000000000000000000000000000000000011'),
        ]),
      },
      consumerOptions: { quoteCache },
    });

    const selection = await (gateway as any).selectQuoteBackedProvider('gpt-test', new Set<string>());

    expect(selection.result).toBeDefined();
    expect(selection.result.provider.announcement.peerId).toBe('other-peer');
    expect(selection.result.quote).toBeNull();
    expect(selection.result.currentPrice).toBe(1.5);
    expect(router.findProviders).toHaveBeenCalledWith('gpt-test');
  });

  it('exposes buyer AIMM metrics for doctor and local scraping', async () => {
    const quoteCache = {
      size: vi.fn(() => 2),
    };
    const { gateway } = await createGateway({
      consumerOptions: {
        quoteCache,
      },
    });
    (gateway as any).outboundMetrics.ok = 3;
    (gateway as any).outboundMetrics.rejected = 1;
    (gateway as any).outboundMetrics.timeout = 0;
    (gateway as any).outboundMetrics.error = 2;
    (gateway as any).quoteFallbackMetrics.no_active_quotes = 4;

    const req = makeGetRequest('/metrics');
    const res = new MockResponse();

    await (gateway as any).handleRequest(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type'] ?? res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('aimm_quote_cache_size 2');
    expect(res.body).toContain('aimm_requests_outbound_total{result="ok"} 3');
    expect(res.body).toContain('aimm_requests_outbound_total{result="rejected"} 1');
    expect(res.body).toContain('aimm_requests_outbound_total{result="error"} 2');
    expect(res.body).toContain('aimm_quote_fallback_total{reason="no_active_quotes"} 4');
  });

  it('fails over to the next provider when the first attempt throws', async () => {
    encrypt.mockResolvedValue('encrypted-request');
    deserializePublicKey.mockReturnValue(new Uint8Array([9, 9, 9]));
    decrypt.mockResolvedValue(
      JSON.stringify({
        choices: [{ message: { content: 'fallback response' } }],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 7,
          total_tokens: 12,
        },
      }),
    );

    const firstProvider = makeProvider(
      'peer-1',
      '0x0000000000000000000000000000000000000011',
    );
    const secondProvider = makeProvider(
      'peer-2',
      '0x0000000000000000000000000000000000000022',
    );
    const { authorizationSigner, gateway, poolManager, qualityMonitor, router, streamHandler } =
      await createGateway({
        router: {
          selectBest: vi.fn().mockResolvedValue(firstProvider),
          selectBestExcluding: vi.fn().mockResolvedValue(secondProvider),
        },
        streamHandler: {
          sendRequest: vi
            .fn()
            .mockImplementationOnce(async function* () {
              throw new Error('first provider failed');
            })
            .mockImplementationOnce(async function* () {
              yield {
                type: 'response',
                requestId: 'req-2',
                payload: 'encrypted-response',
                timestamp: Date.now(),
                usage: {
                  prompt_tokens: 5,
                  completion_tokens: 7,
                  total_tokens: 12,
                },
                upstreamProof: {
                  requestId: 'req-2',
                  model: 'gpt-test',
                  pricedAt: 2.5,
                  quoteUsed: {
                    makerId: 'peer-2',
                    makerAddress: '0x0000000000000000000000000000000000000022',
                    model: 'gpt-test',
                    p0: 2,
                    alpha: 1,
                    utilization: 0.25,
                    maxConcurrent: 5,
                    currentPrice: 2.5,
                    recentLatencyMs: 120,
                    successRate: 0.99,
                    timestamp: Date.now(),
                    ttlMs: 10000,
                    schemaVersion: 1,
                    signature: '0xquote',
                  },
                },
              };
            }),
        },
        poolManager: {
          allocateAuthorizationNonce: vi
            .fn()
            .mockResolvedValueOnce({ nonce: 1n, nonceMode: 'bitmap' })
            .mockResolvedValueOnce({ nonce: 2n, nonceMode: 'bitmap' }),
        },
      });

    const req = makeJsonRequest({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const res = new MockResponse();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      await (gateway as any).handleChatCompletions(req, res);
    } finally {
      randomSpy.mockRestore();
    }

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [{ message: { content: 'fallback response' } }],
      upstreamProof: {
        requestId: 'req-2',
        pricedAt: 2.5,
        quoteUsed: {
          makerId: 'peer-2',
          currentPrice: 2.5,
        },
      },
    });
    expect(router.markFailed).toHaveBeenCalledWith('peer-1');
    expect(router.markSuccess).toHaveBeenCalledWith('peer-2');
    expect(streamHandler.sendRequest).toHaveBeenNthCalledWith(
      1,
      'peer-1',
      expect.objectContaining({ type: 'request' }),
      expect.objectContaining({ addresses: firstProvider.announcement.multiaddrs, settle: expect.any(Function) }),
    );
    expect(streamHandler.sendRequest).toHaveBeenNthCalledWith(
      2,
      'peer-2',
      expect.objectContaining({ type: 'request' }),
      expect.objectContaining({ addresses: secondProvider.announcement.multiaddrs, settle: expect.any(Function) }),
    );
    expect(authorizationSigner.createAuthorization).not.toHaveBeenCalled();
    expect(authorizationSigner.signInferenceIntent).toHaveBeenCalledTimes(2);
    expect(authorizationSigner.signInferenceIntent).toHaveBeenNthCalledWith(1, expect.objectContaining({ seller: '0x0000000000000000000000000000000000000011', nonce: 1n }));
    expect(authorizationSigner.signInferenceIntent).toHaveBeenNthCalledWith(2, expect.objectContaining({ seller: '0x0000000000000000000000000000000000000022', nonce: 2n }));
    expect(poolManager.allocateAuthorizationNonce).toHaveBeenCalledTimes(2);
    expect(qualityMonitor.startRequest).toHaveBeenNthCalledWith(1, 'peer-1', expect.any(String));
    expect(qualityMonitor.startRequest).toHaveBeenNthCalledWith(2, 'peer-2', expect.any(String));
    expect(qualityMonitor.endRequest).toHaveBeenCalledWith(expect.any(String), false);
    expect(encrypt).toHaveBeenCalledTimes(2);
  }, 15_000);

  it('skips unhealthy preselected alternatives before retrying the request', async () => {
    encrypt.mockResolvedValue('encrypted-request');
    deserializePublicKey.mockReturnValue(new Uint8Array([9, 9, 9]));
    decrypt.mockResolvedValue(
      JSON.stringify({
        choices: [{ message: { content: 'healthy alternative response' } }],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 7,
          total_tokens: 12,
        },
      }),
    );

    const firstProvider = makeProvider(
      'peer-1',
      '0x0000000000000000000000000000000000000011',
    );
    const unhealthyAlternative = makeProvider(
      'peer-2',
      '0x0000000000000000000000000000000000000022',
    );
    const healthyAlternative = makeProvider(
      'peer-3',
      '0x0000000000000000000000000000000000000033',
    );
    const { gateway, router, streamHandler } = await createGateway({
      router: {
        findProviders: vi
          .fn()
          .mockResolvedValue([firstProvider, unhealthyAlternative, healthyAlternative]),
        isProviderAvailable: vi
          .fn()
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(true),
        selectBestExcluding: vi.fn(),
      },
      streamHandler: {
        sendRequest: vi
          .fn()
          .mockImplementationOnce(async function* () {
            throw new Error('first provider failed');
          })
          .mockImplementationOnce(async function* () {
            yield {
              type: 'response',
              requestId: 'req-healthy-alt',
              payload: 'encrypted-response',
              timestamp: Date.now(),
              usage: {
                prompt_tokens: 5,
                completion_tokens: 7,
                total_tokens: 12,
              },
            };
          }),
      },
      poolManager: {
        allocateAuthorizationNonce: vi
          .fn()
          .mockResolvedValueOnce({ nonce: 1n, nonceMode: 'bitmap' })
          .mockResolvedValueOnce({ nonce: 2n, nonceMode: 'bitmap' }),
      },
    });
    (gateway as any).schedulerConfig.updateOverride({
      mode: 'new',
      rolloutPct: 100,
      topN: 3,
      enableP2C: false,
    });

    const req = makeJsonRequest({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      user: 'user-a',
    });
    const res = new MockResponse();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      await (gateway as any).handleChatCompletions(req, res);
    } finally {
      randomSpy.mockRestore();
    }

    expect(res.statusCode).toBe(200);
    expect(router.isProviderAvailable).toHaveBeenNthCalledWith(1, 'gpt-test', 'peer-2');
    expect(router.isProviderAvailable).toHaveBeenNthCalledWith(2, 'gpt-test', 'peer-3');
    expect(streamHandler.sendRequest).toHaveBeenNthCalledWith(
      1,
      'peer-1',
      expect.objectContaining({ type: 'request' }),
      expect.objectContaining({ addresses: firstProvider.announcement.multiaddrs, settle: expect.any(Function) }),
    );
    expect(streamHandler.sendRequest).toHaveBeenNthCalledWith(
      2,
      'peer-3',
      expect.objectContaining({ type: 'request' }),
      expect.objectContaining({ addresses: healthyAlternative.announcement.multiaddrs, settle: expect.any(Function) }),
    );
    expect(router.selectBestExcluding).not.toHaveBeenCalled();
  });

  it('clamps short-request authorization amounts to the protocol minimum', async () => {
    encrypt.mockResolvedValue('encrypted-request');
    deserializePublicKey.mockReturnValue(new Uint8Array([9, 9, 9]));
    decrypt.mockResolvedValue(
      JSON.stringify({
        choices: [{ message: { content: 'tiny request ok' } }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
      }),
    );

    const provider = makeProvider(
      'peer-min',
      '0x0000000000000000000000000000000000000011',
    );
    const quote = makeQuote({
      makerId: 'peer-min',
      makerAddress: '0x0000000000000000000000000000000000000011',
      currentPrice: 80,
      p0: 80,
    });

    const { authorizationSigner, gateway, poolManager, router, streamHandler } = await createGateway({
      router: {
        findProviders: vi.fn(async () => [provider]),
      },
      streamHandler: {
        sendRequest: vi.fn(async function* () {
          yield {
            type: 'response',
            requestId: 'req-min',
            payload: 'encrypted-response',
            timestamp: Date.now(),
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
            },
          };
        }),
      },
    });
    (gateway as any).quoteCache = {
      size: vi.fn(() => 1),
      active: vi.fn(() => [quote]),
      insert: vi.fn(),
    };

    const req = makeJsonRequest({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    });
    const res = new MockResponse();
    // This minimum-fee case opts out of proxy overhead; account-proxy bounds are tested separately.
    (gateway as any).config.inputOverheadTokens = 0;

    await (gateway as any).handleChatCompletions(req, res);

    expect(res.statusCode).toBe(200);
    expect(router.findProviders).toHaveBeenCalledWith('gpt-test');
    expect(streamHandler.sendRequest).toHaveBeenCalledTimes(1);
    expect(poolManager.ensureSufficientBalance).toHaveBeenCalledWith(0.01);
    expect(authorizationSigner.createAuthorization).not.toHaveBeenCalled();
    expect(authorizationSigner.signInferenceIntent).toHaveBeenCalledWith(expect.objectContaining({ amount: MIN_COST_PER_REQUEST, nonce: 1n, nonceMode: 'bitmap' }));
    expect((gateway as any).schedulerLogger.getRecent(1)).toEqual([
      expect.objectContaining({
        routeKind: 'aimm_quote',
        selectionReason: 'quote',
        selectedPeerId: 'peer-min',
      }),
    ]);
  });

  it('fails over when a non-stream provider closes before a terminal message', async () => {
    encrypt.mockResolvedValue('encrypted-request');
    deserializePublicKey.mockReturnValue(new Uint8Array([9, 9, 9]));
    decrypt
      .mockResolvedValueOnce(
        JSON.stringify({
          choices: [{ delta: { content: 'partial from broken provider' } }],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          choices: [{ message: { content: 'fresh provider response' } }],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 4,
            total_tokens: 7,
          },
        }),
      );

    const firstProvider = makeProvider(
      'peer-1',
      '0x0000000000000000000000000000000000000011',
    );
    const secondProvider = makeProvider(
      'peer-2',
      '0x0000000000000000000000000000000000000022',
    );
    const { gateway, qualityMonitor, router, streamHandler } = await createGateway({
      router: {
        selectBest: vi.fn().mockResolvedValue(firstProvider),
        selectBestExcluding: vi.fn().mockResolvedValue(secondProvider),
      },
      streamHandler: {
        sendRequest: vi
          .fn()
          .mockImplementationOnce(async function* () {
            yield {
              type: 'stream_chunk',
              requestId: 'req-broken',
              payload: 'encrypted-partial',
              timestamp: Date.now(),
            };
          })
          .mockImplementationOnce(async function* () {
            yield {
              type: 'response',
              requestId: 'req-fresh',
              payload: 'encrypted-response',
              timestamp: Date.now(),
              usage: {
                prompt_tokens: 3,
                completion_tokens: 4,
                total_tokens: 7,
              },
            };
          }),
      },
      poolManager: {
        allocateAuthorizationNonce: vi
          .fn()
          .mockResolvedValueOnce({ nonce: 1n, nonceMode: 'bitmap' })
          .mockResolvedValueOnce({ nonce: 2n, nonceMode: 'bitmap' }),
      },
    });

    const req = makeJsonRequest({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const res = new MockResponse();

    await (gateway as any).handleChatCompletions(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [{ message: { content: 'fresh provider response' } }],
    });
    expect(router.markFailed).toHaveBeenCalledWith('peer-1');
    expect(router.markSuccess).toHaveBeenCalledWith('peer-2');
    expect(streamHandler.sendRequest).toHaveBeenCalledTimes(2);
    expect(qualityMonitor.endRequest).toHaveBeenCalledWith(expect.any(String), false);
    expect(qualityMonitor.endRequest).toHaveBeenCalledWith(expect.any(String), true, 7);
  });

  it('fails over a stream request before sending headers when the first provider returns an auth error', async () => {
    encrypt.mockResolvedValue('encrypted-request');
    deserializePublicKey.mockReturnValue(new Uint8Array([9, 9, 9]));
    decrypt.mockResolvedValue(
      JSON.stringify({
        choices: [{ delta: { content: 'fallback stream response' } }],
      }),
    );

    const firstProvider = makeProvider(
      'peer-1',
      '0x0000000000000000000000000000000000000011',
    );
    const secondProvider = makeProvider(
      'peer-2',
      '0x0000000000000000000000000000000000000022',
    );
    const { gateway, qualityMonitor, router, streamHandler } = await createGateway({
      router: {
        selectBest: vi.fn().mockResolvedValue(firstProvider),
        selectBestExcluding: vi.fn().mockResolvedValue(secondProvider),
      },
      streamHandler: {
        sendRequest: vi
          .fn()
          .mockImplementationOnce(async function* () {
            yield {
              type: 'error',
              requestId: 'req-auth-bad',
              error: JSON.stringify({
                type: 'internal_error',
                message:
                  'Proxy returned HTTP 401: {"error":{"message":"Your authentication token has been invalidated. Please try signing in again.","code":"token_invalidated"}}',
              }),
              timestamp: Date.now(),
            };
          })
          .mockImplementationOnce(async function* () {
            yield {
              type: 'stream_chunk',
              requestId: 'req-stream-good',
              payload: 'encrypted-response',
              timestamp: Date.now(),
            };
            yield {
              type: 'stream_end',
              requestId: 'req-stream-good',
              timestamp: Date.now(),
              usage: {
                prompt_tokens: 3,
                completion_tokens: 4,
                total_tokens: 7,
              },
            };
          }),
      },
      poolManager: {
        allocateAuthorizationNonce: vi
          .fn()
          .mockResolvedValueOnce({ nonce: 1n, nonceMode: 'bitmap' })
          .mockResolvedValueOnce({ nonce: 2n, nonceMode: 'bitmap' }),
      },
    });

    const req = makeJsonRequest({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });
    const res = new MockResponse();

    await (gateway as any).handleChatCompletions(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('fallback stream response');
    expect(res.body).toContain('[DONE]');
    expect(router.markTemporarilyUnavailable).toHaveBeenCalledWith(
      'peer-1',
      'gpt-test',
      900000,
      'Your authentication token has been invalidated. Please try signing in again.',
    );
    expect(router.markSuccess).toHaveBeenCalledWith('peer-2');
    expect(streamHandler.sendRequest).toHaveBeenCalledTimes(2);
    expect(qualityMonitor.endRequest).toHaveBeenCalledWith(expect.any(String), false);
    expect(qualityMonitor.endRequest).toHaveBeenCalledWith(expect.any(String), true, 7);
  });

  it('does not emit SSE headers when a stream provider closes before any messages, allowing failover', async () => {
    encrypt.mockResolvedValue('encrypted-request');
    deserializePublicKey.mockReturnValue(new Uint8Array([9, 9, 9]));
    decrypt.mockResolvedValue(
      JSON.stringify({
        choices: [{ delta: { content: 'healthy stream response' } }],
      }),
    );

    const firstProvider = makeProvider(
      'peer-1',
      '0x0000000000000000000000000000000000000011',
    );
    const secondProvider = makeProvider(
      'peer-2',
      '0x0000000000000000000000000000000000000022',
    );
    const { gateway, router, streamHandler } = await createGateway({
      router: {
        selectBest: vi.fn().mockResolvedValue(firstProvider),
        selectBestExcluding: vi.fn().mockResolvedValue(secondProvider),
      },
      streamHandler: {
        sendRequest: vi
          .fn()
          .mockImplementationOnce(async function* () {})
          .mockImplementationOnce(async function* () {
            yield {
              type: 'stream_chunk',
              requestId: 'req-stream-good',
              payload: 'encrypted-response',
              timestamp: Date.now(),
            };
            yield {
              type: 'stream_end',
              requestId: 'req-stream-good',
              timestamp: Date.now(),
              usage: {
                prompt_tokens: 1,
                completion_tokens: 2,
                total_tokens: 3,
              },
            };
          }),
      },
      poolManager: {
        allocateAuthorizationNonce: vi
          .fn()
          .mockResolvedValueOnce({ nonce: 1n, nonceMode: 'bitmap' })
          .mockResolvedValueOnce({ nonce: 2n, nonceMode: 'bitmap' }),
      },
    });

    const req = makeJsonRequest({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });
    const res = new MockResponse();

    await (gateway as any).handleChatCompletions(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('healthy stream response');
    expect(router.markPeerUnreachable).toHaveBeenCalledWith(
      'peer-1',
      90_000,
      'Provider stream closed before any protocol messages were received',
    );
    expect(router.markSuccess).toHaveBeenCalledWith('peer-2');
    expect(streamHandler.sendRequest).toHaveBeenCalledTimes(2);
  });

  it('fails over when a stream provider ends cleanly but emits no text tokens', async () => {
    encrypt.mockResolvedValue('encrypted-request');
    deserializePublicKey.mockReturnValue(new Uint8Array([9, 9, 9]));
    decrypt.mockResolvedValue(
      JSON.stringify({
        choices: [{ delta: { content: 'non-empty fallback' } }],
      }),
    );

    const firstProvider = makeProvider(
      'peer-1',
      '0x0000000000000000000000000000000000000011',
    );
    const secondProvider = makeProvider(
      'peer-2',
      '0x0000000000000000000000000000000000000022',
    );
    const { gateway, router, streamHandler } = await createGateway({
      router: {
        selectBest: vi.fn().mockResolvedValue(firstProvider),
        selectBestExcluding: vi.fn().mockResolvedValue(secondProvider),
      },
      streamHandler: {
        sendRequest: vi
          .fn()
          .mockImplementationOnce(async function* () {
            yield {
              type: 'stream_end',
              requestId: 'req-empty',
              timestamp: Date.now(),
              usage: {
                prompt_tokens: 4,
                completion_tokens: 0,
                total_tokens: 4,
              },
            };
          })
          .mockImplementationOnce(async function* () {
            yield {
              type: 'stream_chunk',
              requestId: 'req-fallback',
              payload: 'encrypted-response',
              timestamp: Date.now(),
            };
            yield {
              type: 'stream_end',
              requestId: 'req-fallback',
              timestamp: Date.now(),
              usage: {
                prompt_tokens: 4,
                completion_tokens: 2,
                total_tokens: 6,
              },
            };
          }),
      },
      poolManager: {
        allocateAuthorizationNonce: vi
          .fn()
          .mockResolvedValueOnce({ nonce: 1n, nonceMode: 'bitmap' })
          .mockResolvedValueOnce({ nonce: 2n, nonceMode: 'bitmap' }),
      },
    });

    const req = makeJsonRequest({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });
    const res = new MockResponse();

    await (gateway as any).handleChatCompletions(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('non-empty fallback');
    expect(router.markFailed).toHaveBeenCalledWith('peer-1');
    expect(router.markSuccess).toHaveBeenCalledWith('peer-2');
    expect(streamHandler.sendRequest).toHaveBeenCalledTimes(2);
  });

  it('accepts structured text payloads from provider chunks without treating them as empty', async () => {
    encrypt.mockResolvedValue('encrypted-request');
    deserializePublicKey.mockReturnValue(new Uint8Array([9, 9, 9]));
    decrypt.mockResolvedValue(
      JSON.stringify({
        choices: [{
          delta: {
            content: [
              { type: 'output_text', text: 'structured ' },
              { type: 'output_text', text: 'payload' },
            ],
          },
        }],
      }),
    );

    const provider = makeProvider(
      'peer-1',
      '0x0000000000000000000000000000000000000011',
    );
    const { gateway, router, streamHandler } = await createGateway({
      router: {
        selectBest: vi.fn().mockResolvedValue(provider),
      },
      streamHandler: {
        sendRequest: vi.fn(async function* () {
          yield {
            type: 'stream_chunk',
            requestId: 'req-structured',
            payload: 'encrypted-response',
            timestamp: Date.now(),
          };
          yield {
            type: 'stream_end',
            requestId: 'req-structured',
            timestamp: Date.now(),
            usage: {
              prompt_tokens: 2,
              completion_tokens: 2,
              total_tokens: 4,
            },
          };
        }),
      },
    });

    const req = makeJsonRequest({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });
    const res = new MockResponse();

    await (gateway as any).handleChatCompletions(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('structured payload');
    expect(router.markSuccess).toHaveBeenCalledWith('peer-1');
    expect(streamHandler.sendRequest).toHaveBeenCalledTimes(1);
  });

  it('lists discoverable models from config instead of the legacy hardcoded set', async () => {
    const { gateway, router } = await createGateway({
      router: {
        listCachedModels: vi.fn(() => ['gpt-5.4', 'gemini-2.5-pro']),
        getCachedProviders: vi.fn((model: string) => (model === 'gpt-5.4' ? [makeProvider('peer-1', '0x0000000000000000000000000000000000000011')] : [])),
      },
    });

    (gateway as any).config.discoverableModels = ['gpt-5.4'];

    const res = new MockResponse();
    await (gateway as any).handleModels(res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      object: 'list',
      data: [{ id: 'gpt-5.4' }],
    });
    expect(router.listCachedModels).toHaveBeenCalledWith(['gpt-5.4']);
    expect(router.getCachedProviders).toHaveBeenCalledWith('gpt-5.4');
    expect(router.getCachedProviders).toHaveBeenCalledWith('gemini-2.5-pro');
    expect(router.findProviders).not.toHaveBeenCalled();
  });

  it('reports network seller status for the buyer dashboard', async () => {
    const provider = makeProvider(
      'peer-1',
      '0x0000000000000000000000000000000000000011',
    );
    const { gateway, router } = await createGateway({
      router: {
        listCachedModels: vi.fn(() => ['gemini-2.5-pro', 'gpt-5.4']),
        getCachedProviders: vi.fn((model: string) => (model === 'gpt-5.4' ? [provider] : [])),
      },
    });

    (gateway as any).config.discoverableModels = ['gpt-5.4'];

    const res = new MockResponse();
    await (gateway as any).handleRequest({ headers: { authorization: 'Bearer test-api-token' }, method: 'GET', url: '/v1/network/status' }, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      object: 'clawmarket.network_status',
      models: [
        {
          model: 'gemini-2.5-pro',
          providerCount: 0,
          bestProvider: null,
          providers: [],
        },
        {
          model: 'gpt-5.4',
          providerCount: 1,
          bestProvider: {
            peerId: 'peer-1',
            walletAddress: '0x0000000000000000000000000000000000000011',
            model: 'gpt-test',
            inputPer1m: 1,
            outputPer1m: 2,
          },
        },
      ],
      bestProvider: {
        peerId: 'peer-1',
      },
    });
    expect(router.listCachedModels).toHaveBeenCalledWith(['gpt-5.4']);
    expect(router.getCachedProviders).toHaveBeenCalledWith('gemini-2.5-pro');
    expect(router.getCachedProviders).toHaveBeenCalledWith('gpt-5.4');
    expect(router.findProviders).not.toHaveBeenCalled();
  });

  it('returns wallet and escrow credit balances', async () => {
    const { gateway, poolManager } = await createGateway({
      poolManager: {
        getAvailableBalance: vi.fn().mockResolvedValue(42_500_000n),
        getPendingWithdraw: vi.fn().mockResolvedValue({ amount: 20_000_000n, unlockAt: 1_900_000_000n }),
      },
    });

    const res = new MockResponse();
    await (gateway as any).handleRequest({ headers: { authorization: 'Bearer test-api-token' }, method: 'GET', url: '/v1/wallet' }, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      object: 'clawmarket.wallet',
      address: '0x00000000000000000000000000000000000000bb',
      usdcBalance: '12.5',
      nativeBalance: '0.0005',
      nativeBalanceWei: '500000000000000',
      escrowAvailable: '42.5',
      escrowAvailableRaw: '42500000',
      credits: {
        unit: 'USDC',
        available: '42.5',
      },
      pendingWithdraw: {
        amount: '20',
        amountRaw: '20000000',
        unlocksAt: 1900000000000,
      },
    });
    expect(poolManager.getAvailableBalance).toHaveBeenCalled();
    expect(poolManager.getPendingWithdraw).toHaveBeenCalled();
  });

  it('purchases API credits by approving and depositing USDC into EscrowPool', async () => {
    const { gateway, poolManager } = await createGateway();
    const req = makeJsonRequest({ amountUsd: 5.25 });
    const res = new MockResponse();

    await (gateway as any).handleRequest(
      Object.assign(req, { method: 'POST', url: '/v1/credits/purchase' }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      object: 'clawmarket.credits.purchase',
      amountUsd: 5.25,
      approvalTx: '0xapprove',
      depositTx: '0xdeposit',
    });
    expect(poolManager.depositWithApproval).toHaveBeenCalledWith(5.25);
  });

  it('does not retry once stream bytes have been written to the client', async () => {
    encrypt.mockResolvedValue('encrypted-request');
    deserializePublicKey.mockReturnValue(new Uint8Array([9, 9, 9]));
    decrypt.mockResolvedValue(
      JSON.stringify({
        choices: [{ delta: { content: 'partial token' } }],
      }),
    );

    const provider = makeProvider(
      'peer-1',
      '0x0000000000000000000000000000000000000011',
    );
    const { gateway, qualityMonitor, router } = await createGateway({
      router: {
        selectBest: vi.fn().mockResolvedValue(provider),
        selectBestExcluding: vi.fn(),
      },
      streamHandler: {
        sendRequest: vi.fn().mockImplementationOnce(async function* () {
          yield {
            type: 'stream_chunk',
            requestId: 'req-stream',
            payload: 'encrypted-stream-chunk',
            timestamp: Date.now(),
          };
          throw new Error('stream broke');
        }),
      },
      poolManager: {
        allocateAuthorizationNonce: vi
          .fn()
          .mockResolvedValue({ nonce: 1n, nonceMode: 'bitmap' }),
      },
    });

    const req = makeJsonRequest({
      model: 'gpt-test',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    });
    const res = new MockResponse();

    await expect((gateway as any).handleChatCompletions(req, res)).rejects.toThrow('stream broke');

    expect(res.headersSent).toBe(true);
    expect(res.body).toContain('partial token');
    expect(router.selectBestExcluding).not.toHaveBeenCalled();
    expect(router.markFailed).toHaveBeenCalledWith('peer-1');
    expect(router.markSuccess).not.toHaveBeenCalled();
    expect(qualityMonitor.endRequest).toHaveBeenCalledWith(expect.any(String), false);
  });

  it('marks a provider peer unreachable when transport setup fails before any protocol messages', async () => {
    encrypt.mockResolvedValue('encrypted-request');
    deserializePublicKey.mockReturnValue(new Uint8Array([9, 9, 9]));

    const provider = makeProvider(
      'peer-1',
      '0x0000000000000000000000000000000000000011',
    );
    const { gateway, router } = await createGateway({
      router: {
        selectBest: vi.fn().mockResolvedValue(provider),
        selectBestExcluding: vi.fn().mockResolvedValue(null),
      },
      streamHandler: {
        sendRequest: vi.fn().mockImplementationOnce(async function* () {
          throw new Error(
            'dialProtocol fallback for peer-1: Remote closed connection during opening',
          );
        }),
      },
      poolManager: {
        allocateAuthorizationNonce: vi
          .fn()
          .mockResolvedValue({ nonce: 1n, nonceMode: 'bitmap' }),
      },
    });

    const req = makeJsonRequest({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const res = new MockResponse();

    await (gateway as any).handleChatCompletions(req, res);

    expect(router.markPeerUnreachable).toHaveBeenCalledWith(
      'peer-1',
      90_000,
      expect.stringContaining('Remote closed connection during opening'),
    );
    expect(router.markFailed).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(502);
  });

  it('marks a provider as temporarily unavailable for the current model on upstream 429', async () => {
    encrypt.mockResolvedValue('encrypted-request');
    deserializePublicKey.mockReturnValue(new Uint8Array([9, 9, 9]));

    const provider = makeProvider(
      'peer-1',
      '0x0000000000000000000000000000000000000011',
    );
    const { gateway, router } = await createGateway({
      router: {
        selectBest: vi.fn().mockResolvedValue(provider),
        selectBestExcluding: vi.fn().mockResolvedValue(null),
      },
      streamHandler: {
        sendRequest: vi.fn().mockImplementationOnce(async function* () {
          yield {
            type: 'error',
            requestId: 'req-429',
            error: JSON.stringify({
              type: 'internal_error',
              message:
                'Proxy returned HTTP 429: {"error":{"code":"model_cooldown","message":"All credentials for model gpt-test are cooling down via provider codex","reset_seconds":90}}',
            }),
            timestamp: Date.now(),
          };
        }),
      },
      poolManager: {
        allocateAuthorizationNonce: vi
          .fn()
          .mockResolvedValue({ nonce: 1n, nonceMode: 'bitmap' }),
      },
    });

    const req = makeJsonRequest({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const res = new MockResponse();

    await (gateway as any).handleChatCompletions(req, res);

    expect(router.markTemporarilyUnavailable).toHaveBeenCalledWith(
      'peer-1',
      'gpt-test',
      90_000,
      'All credentials for model gpt-test are cooling down via provider codex',
    );
    expect(router.markFailed).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.message).toContain('已尝试 1 个已发现 seller');
  });

  it('fails over to another seller when the first seller hits usage_limit_reached', async () => {
    encrypt.mockResolvedValue('encrypted-request');
    deserializePublicKey.mockReturnValue(new Uint8Array([9, 9, 9]));
    decrypt.mockResolvedValue(
      JSON.stringify({
        choices: [{ message: { content: 'rerouted after quota' } }],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 5,
          total_tokens: 9,
        },
      }),
    );

    const firstProvider = makeProvider(
      'peer-1',
      '0x0000000000000000000000000000000000000011',
    );
    const secondProvider = makeProvider(
      'peer-2',
      '0x0000000000000000000000000000000000000022',
    );
    const { gateway, router } = await createGateway({
      router: {
        findProviders: vi.fn().mockResolvedValue([firstProvider, secondProvider]),
        selectBest: vi.fn().mockResolvedValue(firstProvider),
        selectBestExcluding: vi.fn().mockResolvedValue(secondProvider),
      },
      streamHandler: {
        sendRequest: vi
          .fn()
          .mockImplementationOnce(async function* () {
            yield {
              type: 'error',
              requestId: 'req-usage-limit',
              error: JSON.stringify({
                type: 'internal_error',
                message:
                  'Proxy returned HTTP 429: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":1684}}',
              }),
              timestamp: Date.now(),
            };
          })
          .mockImplementationOnce(async function* () {
            yield {
              type: 'response',
              requestId: 'req-usage-limit',
              payload: 'encrypted-response',
              timestamp: Date.now(),
              usage: {
                prompt_tokens: 4,
                completion_tokens: 5,
                total_tokens: 9,
              },
            };
          }),
      },
      poolManager: {
        allocateAuthorizationNonce: vi
          .fn()
          .mockResolvedValueOnce({ nonce: 1n, nonceMode: 'bitmap' })
          .mockResolvedValueOnce({ nonce: 2n, nonceMode: 'bitmap' }),
      },
    });

    const req = makeJsonRequest({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const res = new MockResponse();

    await (gateway as any).handleChatCompletions(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      choices: [{ message: { content: 'rerouted after quota' } }],
    });
    expect(router.markTemporarilyUnavailable).toHaveBeenCalledWith(
      'peer-1',
      'gpt-test',
      1_684_000,
      'The usage limit has been reached',
    );
    expect(router.markSuccess).toHaveBeenCalledWith('peer-2');
  });

  it('fails over when a provider reports upstream quota cooling with retry-after', async () => {
    encrypt.mockResolvedValue('encrypted-request');
    deserializePublicKey.mockReturnValue(new Uint8Array([9, 9, 9]));
    decrypt.mockResolvedValue(
      JSON.stringify({
        choices: [{ message: { content: 'fallback after cooling' } }],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 5,
          total_tokens: 9,
        },
      }),
    );

    const firstProvider = makeProvider(
      'peer-1',
      '0x0000000000000000000000000000000000000011',
    );
    const secondProvider = makeProvider(
      'peer-2',
      '0x0000000000000000000000000000000000000022',
    );
    const { gateway, router } = await createGateway({
      router: {
        findProviders: vi.fn().mockResolvedValue([firstProvider, secondProvider]),
        selectBest: vi.fn().mockResolvedValue(firstProvider),
        selectBestExcluding: vi.fn().mockResolvedValue(secondProvider),
      },
      streamHandler: {
        sendRequest: vi
          .fn()
          .mockImplementationOnce(async function* () {
            yield {
              type: 'error',
              requestId: 'req-upstream-cooling',
              error: JSON.stringify({
                type: 'upstream_quota',
                message: 'The usage limit has been reached',
                statusCode: 503,
                retryAfterSeconds: 7,
                providerHint: {
                  retryAfterSeconds: 7,
                },
              }),
              timestamp: Date.now(),
            };
          })
          .mockImplementationOnce(async function* () {
            yield {
              type: 'response',
              requestId: 'req-upstream-cooling',
              payload: 'encrypted-response',
              timestamp: Date.now(),
              usage: {
                prompt_tokens: 4,
                completion_tokens: 5,
                total_tokens: 9,
              },
            };
          }),
      },
      poolManager: {
        allocateAuthorizationNonce: vi
          .fn()
          .mockResolvedValueOnce({ nonce: 1n, nonceMode: 'bitmap' })
          .mockResolvedValueOnce({ nonce: 2n, nonceMode: 'bitmap' }),
      },
    });

    const req = makeJsonRequest({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const res = new MockResponse();

    await (gateway as any).handleChatCompletions(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      choices: [{ message: { content: 'fallback after cooling' } }],
    });
    expect(router.markTemporarilyUnavailable).toHaveBeenCalledWith(
      'peer-1',
      'gpt-test',
      7_000,
      'The usage limit has been reached',
    );
    expect(router.markFailed).not.toHaveBeenCalledWith('peer-1');
    expect(router.markSuccess).toHaveBeenCalledWith('peer-2');
  });

  it('fails over to the next provider on a backpressure soft reject without counting a hard failure', async () => {
    encrypt.mockResolvedValue('encrypted-request');
    deserializePublicKey.mockReturnValue(new Uint8Array([9, 9, 9]));
    decrypt.mockResolvedValue(
      JSON.stringify({
        choices: [{ message: { content: 'rerouted response' } }],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 5,
          total_tokens: 9,
        },
      }),
    );

    const firstProvider = makeProvider(
      'peer-1',
      '0x0000000000000000000000000000000000000011',
    );
    const secondProvider = makeProvider(
      'peer-2',
      '0x0000000000000000000000000000000000000022',
    );
    const { gateway, router, streamHandler } = await createGateway({
      router: {
        selectBest: vi.fn().mockResolvedValue(firstProvider),
        selectBestExcluding: vi.fn().mockResolvedValue(secondProvider),
      },
      streamHandler: {
        sendRequest: vi
          .fn()
          .mockImplementationOnce(async function* () {
            yield {
              type: 'error',
              requestId: 'req-soft-reject',
              error: JSON.stringify({
                type: 'backpressure_soft_reject',
                message: 'Provider overloaded, retry after 3s',
                statusCode: 429,
                retryAfterSeconds: 3,
                providerHint: { loadHint: 0.95, inflight: 5, queueDepth: 2 },
              }),
              timestamp: Date.now(),
            };
          })
          .mockImplementationOnce(async function* () {
            yield {
              type: 'response',
              requestId: 'req-soft-reject',
              payload: 'encrypted-response',
              timestamp: Date.now(),
              usage: {
                prompt_tokens: 4,
                completion_tokens: 5,
                total_tokens: 9,
              },
            };
          }),
      },
      poolManager: {
        allocateAuthorizationNonce: vi
          .fn()
          .mockResolvedValueOnce({ nonce: 1n, nonceMode: 'bitmap' })
          .mockResolvedValueOnce({ nonce: 2n, nonceMode: 'bitmap' }),
      },
    });

    const req = makeJsonRequest({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const res = new MockResponse();

    await (gateway as any).handleChatCompletions(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      choices: [{ message: { content: 'rerouted response' } }],
    });
    expect(router.markTemporarilyUnavailable).toHaveBeenCalledWith(
      'peer-1',
      'gpt-test',
      3_000,
      'Provider overloaded, retry after 3s',
    );
    expect(router.markFailed).not.toHaveBeenCalledWith('peer-1');
    expect(router.markSuccess).toHaveBeenCalledWith('peer-2');
  });

  it('logs no_candidate_after_filter when rollout finds only disqualified providers', async () => {
    const overpricedProvider = makeProvider(
      'peer-1',
      '0x0000000000000000000000000000000000000011',
    );
    overpricedProvider.modelPricing.inputPer1m = 5;
    overpricedProvider.modelPricing.outputPer1m = 7;

    const { gateway } = await createGateway({
      router: {
        findProviders: vi.fn().mockResolvedValue([overpricedProvider]),
        selectBest: vi.fn(),
        selectBestExcluding: vi.fn(),
      },
    });
    (gateway as any).schedulerConfig.updateOverride({ mode: 'new', rolloutPct: 100 });

    const req = makeJsonRequest({
      model: 'gpt-test',
      max_price_per_1m: 3,
      user: 'user-a',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const res = new MockResponse();

    await (gateway as any).handleChatCompletions(req, res);

    expect(res.statusCode).toBe(503);
    expect((gateway as any).schedulerLogger.getRecent(1)).toEqual([
      expect.objectContaining({
        errorKind: 'no_candidate_after_filter',
        selectionReason: 'no_candidate',
      }),
    ]);
  });

  it('rejects clients below the minimum supported version with HTTP 426', async () => {
    const { gateway } = await createGateway();
    (gateway as any).clientPolicy.updateOverride({
      minClientVersion: '0.2.0',
      recommendedVersion: '0.2.3',
    });

    const req = makeJsonRequest({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
    }, {
      'x-claw-client-version': '0.1.0',
    });
    const res = new MockResponse();

    await (gateway as any).handleChatCompletions(req, res);

    expect(res.statusCode).toBe(426);
    expect(JSON.parse(res.body)).toMatchObject({
      error: {
        type: 'client_upgrade_required',
        minClientVersion: '0.2.0',
        recommendedVersion: '0.2.3',
        upgradeCommand: 'tam self-update',
      },
    });
  });

  it('forwards the caller client version into the P2P inference request', async () => {
    encrypt.mockResolvedValue('encrypted-request');
    deserializePublicKey.mockReturnValue(new Uint8Array([9, 9, 9]));
    decrypt.mockResolvedValue(
      JSON.stringify({
        choices: [{ message: { content: 'hello back' } }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 2,
          total_tokens: 3,
        },
      }),
    );

    const provider = makeProvider(
      'peer-1',
      '0x0000000000000000000000000000000000000011',
    );
    const { gateway, streamHandler } = await createGateway({
      router: {
        selectBest: vi.fn().mockResolvedValue(provider),
      },
      streamHandler: {
        sendRequest: vi.fn().mockImplementationOnce(async function* () {
          yield {
            type: 'response',
            requestId: 'req-version-forwarding',
            payload: 'encrypted-response',
            timestamp: Date.now(),
            usage: {
              prompt_tokens: 1,
              completion_tokens: 2,
              total_tokens: 3,
            },
          };
        }),
      },
      poolManager: {
        allocateAuthorizationNonce: vi
          .fn()
          .mockResolvedValue({ nonce: 1n, nonceMode: 'bitmap' }),
      },
    });

    const req = makeJsonRequest({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
    }, {
      'x-claw-client-version': '0.2.0',
    });
    const res = new MockResponse();

    await (gateway as any).handleChatCompletions(req, res);

    expect(streamHandler.sendRequest).toHaveBeenCalledWith(
      'peer-1',
      expect.objectContaining({
        clientVersion: '0.2.0',
        protocolVersion: '3.0.0',
      }),
      expect.objectContaining({ addresses: provider.announcement.multiaddrs, settle: expect.any(Function) }),
    );
  });
});

describe('local wallet API authorization', () => {
  it('rejects the managed per-call budget before reserving payment or contacting a seller', async () => {
    const provider = makeProvider('peer-a', '0x0000000000000000000000000000000000000011');
    const { gateway, poolManager, streamHandler } = await createGateway({ router: { findProviders: vi.fn().mockResolvedValue([provider]), selectBest: vi.fn().mockResolvedValue(provider) } });
    const response = new MockResponse();
    await (gateway as any).handleChatCompletions(makeJsonRequest({ model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }], max_cost_token: '0.000001' }), response);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.type).toBe('budget_exceeded');
    expect(poolManager.allocateAuthorizationNonce).not.toHaveBeenCalled();
    expect(streamHandler.sendRequest).not.toHaveBeenCalled();
  });

  it('returns the signed fee to the manager and keeps the local budget parameter out of upstream requests', async () => {
    encrypt.mockResolvedValue('encrypted-request');
    deserializePublicKey.mockReturnValue(new Uint8Array([9, 9, 9]));
    decrypt.mockResolvedValue('hello');
    const provider = makeProvider('peer-a', '0x0000000000000000000000000000000000000011');
    const sendRequest = vi.fn(async function* (_peer, request, options) {
      const terminal = { type: 'response', requestId: request.requestId, payload: 'result', usage: { prompt_tokens: 1, completion_tokens: 20, total_tokens: 21 } };
      yield terminal;
      await options.settle(terminal);
    });
    const { gateway, authorizationSigner } = await createGateway({ router: { findProviders: vi.fn().mockResolvedValue([provider]), selectBest: vi.fn().mockResolvedValue(provider) }, streamHandler: { sendRequest } });
    const response = new MockResponse();
    await (gateway as any).handleChatCompletions(makeJsonRequest({ model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }], max_cost_token: '1' }), response);
    expect(response.statusCode).toBe(200);
    const fee = authorizationSigner.signAuthorization.mock.calls[0]![0].amount;
    expect(JSON.parse(response.body).tamSettlement).toEqual({ amountToken: formatPaymentAmount(fee), symbol: PAYMENT_TOKEN.symbol, seller: provider.announcement.walletAddress, status: 'authorized' });
    expect(JSON.parse(encrypt.mock.calls[0]![0])).not.toHaveProperty('max_cost_token');
  });

  it('does not authorize a second seller when the acknowledgement of a final payment is lost', async () => {
    encrypt.mockResolvedValue('encrypted-request');
    deserializePublicKey.mockReturnValue(new Uint8Array([9, 9, 9]));
    decrypt.mockResolvedValue(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }));
    const first = makeProvider('peer-a', '0x0000000000000000000000000000000000000011');
    const second = makeProvider('peer-b', '0x0000000000000000000000000000000000000022');
    const sendRequest = vi.fn(async function* (_peer, request, options) {
      const terminal = { type: 'response', requestId: request.requestId, payload: 'result', usage: { prompt_tokens: 1, completion_tokens: 20, total_tokens: 21 } };
      yield terminal;
      await options.settle(terminal);
      throw new Error('Provider ACK lost');
    });
    const { gateway, poolManager, authorizationSigner } = await createGateway({
      router: { findProviders: vi.fn().mockResolvedValue([first, second]), selectBest: vi.fn().mockResolvedValue(first), selectBestExcluding: vi.fn().mockResolvedValue(second) },
      streamHandler: { sendRequest },
    });
    const response = new MockResponse();
    await (gateway as any).handleChatCompletions(makeJsonRequest({ model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] }), response);
    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.body).error.type).toBe('settlement_uncertain');
    expect(sendRequest).toHaveBeenCalledOnce();
    expect(poolManager.allocateAuthorizationNonce).toHaveBeenCalledOnce();
    expect(authorizationSigner.signAuthorization).toHaveBeenCalledOnce();
  });

  it('rejects wallet operations without a token and rejects hostile browser origins even with a token', async () => {
    const { gateway, poolManager } = await createGateway();
    const unauthorized = Object.assign(makeJsonRequest({ amountUsd: 5 }), { method: 'POST', url: '/v1/escrow/deposit', headers: {} });
    const response = new MockResponse();
    await (gateway as any).handleRequest(unauthorized, response);
    expect(response.statusCode).toBe(401);
    expect(poolManager.depositWithApproval).not.toHaveBeenCalled();
    const hostile = Object.assign(makeJsonRequest({ amountUsd: 5 }, { origin: 'https://evil.example', host: '127.0.0.1:3000' }), { method: 'POST', url: '/v1/escrow/deposit' });
    const forbidden = new MockResponse();
    await (gateway as any).handleRequest(hostile, forbidden);
    expect(forbidden.statusCode).toBe(403);
    expect(poolManager.depositWithApproval).not.toHaveBeenCalled();
  });

  it('signs a smaller final payment only after a complete nonempty delivery', async () => {
    const { modelProvenanceRequestBinding } = await import('@clawmarket/crypto');
    const { gateway, authorizationSigner } = await createGateway();
    const request = { authorization: { buyer: '0xbuyer', seller: '0xseller', nonce: 1n, poolId: '0xpool', nonceMode: 'bitmap', expiresAt: 9999999999, requestId: 'settlement-test', payloadHash: '0xpayload',
      amount: 500_000n, inputPrice: 100_000_000n, outputPrice: 200_000_000n, maxInputTokens: 500, maxOutputTokens: 1000 } };
    (gateway as any).provenanceBindings.set(request, modelProvenanceRequestBinding({ model: 'test', messages: [{ role: 'user', content: 'hello' }] }, request.authorization as any, 84532));
    await (gateway as any).signSettlement(request, { usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
    expect(authorizationSigner.signAuthorization).toHaveBeenCalledWith(expect.objectContaining({ amount: 20_000n, nonce: 1n }));
    authorizationSigner.signAuthorization.mockClear();
    await expect((gateway as any).signSettlement(request, { usage: { prompt_tokens: 100, completion_tokens: 1001, total_tokens: 1101 } })).rejects.toThrow();
    expect(authorizationSigner.signAuthorization).not.toHaveBeenCalled();
  });
});

describe('buyer provenance verification before collectible payment', () => {
  const requestBody = { model: 'gpt-test', messages: [{ role: 'user' as const, content: 'hello' }], max_tokens: 128 };
  const policy = { mode: 'required', allowedOrigins: ['https://official.example'] };

  async function run(stream: boolean, proofMode: 'valid' | 'missing' | 'response' | 'nonce' | 'model' | 'invalid', mode = 'required') {
    const { modelProvenanceRequestBinding, ModelProvenanceTextDigest } = await import('@clawmarket/crypto');
    encrypt.mockResolvedValue('encrypted-request'); deserializePublicKey.mockReturnValue(new Uint8Array([9]));
    decrypt.mockResolvedValue(JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }));
    const provider = makeProvider('peer-a', '0x0000000000000000000000000000000000000011');
    const verify = vi.fn(async () => proofMode === 'invalid' ? null : { origin: 'https://official.example', model: 'gpt-test' });
    const sendRequest = vi.fn(async function* (_peer, request, options) {
      const digest = new ModelProvenanceTextDigest(); digest.update('hello');
      const usage = { prompt_tokens: 1, completion_tokens: 20, total_tokens: 21 };
      const binding = { ...modelProvenanceRequestBinding(requestBody, request.authorization, 84532), responseHash: digest.digest(), usage };
      if (proofMode === 'response') binding.responseHash = '0xwrong';
      if (proofMode === 'nonce') binding.nonce = '999';
      if (proofMode === 'model') binding.requestedModel = 'imitation';
      const terminal = { type: 'stream_end', requestId: request.requestId, usage,
        modelProvenanceProof: proofMode === 'missing' ? undefined : { version: 1, scheme: 'test-only', binding, evidence: { fixture: true }, verified: true } };
      yield { type: 'stream_chunk', requestId: request.requestId, payload: 'encrypted-chunk' };
      yield terminal;
      await options.settle(terminal);
    });
    const context = await createGateway({
      consumerConfig: { modelProvenance: { ...policy, mode } }, consumerOptions: { modelProvenanceVerifier: { scheme: 'test-only', verify } },
      router: { findProviders: vi.fn().mockResolvedValue([provider]), selectBest: vi.fn().mockResolvedValue(provider) }, streamHandler: { sendRequest },
    });
    const response = new MockResponse();
    await (context.gateway as any).handleChatCompletions(makeJsonRequest({ ...requestBody, stream }), response);
    return { ...context, response, verify, sendRequest };
  }

  it.each([false, true])('signs only after a matching adapter verdict, stream=%s', async stream => {
    const { response, verify, authorizationSigner } = await run(stream, 'valid');
    expect(authorizationSigner.signAuthorization).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();
    expect(verify.mock.invocationCallOrder[0]).toBeLessThan(authorizationSigner.signAuthorization.mock.invocationCallOrder[0]);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"status":"verified"');
    expect(response.writableEnded).toBe(true);
  });

  it.each([false, true].flatMap(stream => ['missing', 'response', 'nonce', 'model', 'invalid'].map(proofMode => ({ stream, proofMode }))))('refuses $proofMode proof without payment or failover, stream=$stream', async ({ stream, proofMode }) => {
    const { response, authorizationSigner, sendRequest, qualityMonitor } = await run(stream, proofMode as any);
    expect(authorizationSigner.signAuthorization).not.toHaveBeenCalled();
    expect(sendRequest).toHaveBeenCalledOnce();
    expect(response.body).toContain('model_provenance_failed');
    expect(response.body).not.toContain('"finish_reason":"stop"');
    expect(response.body).not.toContain('"status":"verified"');
    expect(response.writableEnded).toBe(true);
    expect(qualityMonitor.endRequest).toHaveBeenCalledWith(expect.any(String), false);
  });

  it('keeps optional missing evidence explicitly unverified', async () => {
    const { response, authorizationSigner, verify } = await run(false, 'missing', 'optional');
    expect(authorizationSigner.signAuthorization).toHaveBeenCalledOnce(); expect(verify).not.toHaveBeenCalled();
    expect(JSON.parse(response.body).tamProvenance).toEqual({ status: 'unverified', reason: 'proof_missing' });
  });

  it('fails at construction when required mode has no verifier', async () => {
    await expect(createGateway({ consumerConfig: { modelProvenance: policy } })).rejects.toThrow('verifier_unavailable');
  });
});

import { PAYMENT_TOKEN, PAYMENT_NATIVE_SYMBOL, formatPaymentAmount, assertPaymentDeployment } from '@clawmarket/shared';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

import {
  Scheduler,
  SchedulerConfigManager,
  SchedulerLogger,
  SessionStickyTable,
  type P2PRouter,
} from '@clawmarket/consumer-gateway';
import {
  INFERENCE_INTENT_TYPES, getInferenceIntentDomain, hashInferencePayload, verifyInferenceIntent,
  getDefaultAuthorizationDomain,
  poolIdFromAddress,
  verifyAuthorizationSignature,
  encrypt,
  decrypt,
  serializePublicKey,
  deserializePublicKey,
  type KeyPair,
} from '@clawmarket/crypto';
import type { StreamHandler } from '@clawmarket/p2p-node';
import {
  AUTH_DEFAULT_TTL_SECONDS,
  inputTokenBudget, lockedPrices, tokenCost, settlementAmount, validateChatRequest,
  PROTOCOL_VERSION,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type HostedAuthorizationQuote,
  type HostedGatewayDepositResponse,
  type HostedGatewayExecuteToken,
  type HostedGatewayPermitDepositRequest,
  type HostedGatewayPrepareRequest,
  type HostedGatewayPrepareResponse,
  type InferenceRequest,
  type ProviderErrorPayload,
  type ProviderRuntimeHint,
  type SignedAuthorization,
  type SignedInferenceIntent,
  type ProtocolMessage,
  type TokenUsage,
} from '@clawmarket/shared';
import {
  createWalletClient,
  createPublicClient,
  http as viemHttp,
  type Chain,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import type { PrivateKeyAccount } from 'viem/accounts';

type ScoredProvider = Awaited<ReturnType<P2PRouter['findProviders']>>[number];

export interface HostedGatewayConfig {
  inputOverheadTokens?: number;
  apiToken?: string;
  port?: number;
  host?: string;
  publicBaseUrl?: string;
  escrowPoolAddress: `0x${string}`;
  rpcUrl: string;
  chainId: number;
  relayerPrivateKey?: `0x${string}`;
  discoverableModels?: string[];
  authorizationTtlSeconds?: number;
  maxProviderAttempts?: number;
}

interface PreparedRequest {
  preparedRequestId: string;
  requestId: string;
  buyer: `0x${string}`;
  body: ChatCompletionRequest;
  bodyHash: string;
  provider: ScoredProvider;
  alternatives: ScoredProvider[];
  quote: HostedAuthorizationQuote;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostMicroUsdc: bigint;
  expiresAtMs: number;
  createdAt: number;
  payload: string;
  executing?: boolean;
}

interface ProviderResponseMeta {
  providerHint: ProviderRuntimeHint | null;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_PROVIDER_ATTEMPTS = 2;
const PREPARED_REQUEST_TTL_MS = 10 * 60 * 1000;
const ESCROW_POOL_ABI = [
  {
    type: 'function',
    name: 'depositWithPermit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'buyer', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

export class HostedGateway {
  private readonly router: P2PRouter;
  private readonly streamHandler: StreamHandler;
  private readonly e2eeKeyPair: KeyPair;
  private readonly config: Required<Omit<HostedGatewayConfig, 'apiToken' | 'relayerPrivateKey' | 'discoverableModels'>> &
    Pick<HostedGatewayConfig, 'apiToken' | 'relayerPrivateKey' | 'discoverableModels'>;
  private readonly schedulerConfig = new SchedulerConfigManager();
  private readonly schedulerLogger: SchedulerLogger;
  private readonly scheduler: Scheduler;
  private readonly preparedRequests = new Map<string, PreparedRequest>();
  private readonly pendingSettlements = new Map<string, { intent: SignedInferenceIntent; amount: bigint; resolve: (a: SignedAuthorization) => void; submitted: boolean; ack: Promise<void> }>();
  private readonly rateWindows = new Map<string, { count: number; start: number }>();
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private server: http.Server | null = null;
  private relayerClient: WalletClient | null = null;
  private relayerAccount: PrivateKeyAccount | null = null;

  constructor(config: HostedGatewayConfig, router: P2PRouter, streamHandler: StreamHandler, e2eeKeyPair: KeyPair) {
    this.config = {
      apiToken: config.apiToken ?? process.env.CLAWMARKET_HOSTED_API_TOKEN,
      port: config.port ?? DEFAULT_PORT,
      host: config.host ?? DEFAULT_HOST,
      publicBaseUrl: config.publicBaseUrl ?? `http://${config.host ?? DEFAULT_HOST}:${config.port ?? DEFAULT_PORT}`,
      escrowPoolAddress: config.escrowPoolAddress,
      rpcUrl: config.rpcUrl,
      chainId: config.chainId,
      relayerPrivateKey: config.relayerPrivateKey,
      discoverableModels: config.discoverableModels ?? [],
      inputOverheadTokens: config.inputOverheadTokens ?? 512,
      authorizationTtlSeconds: config.authorizationTtlSeconds ?? AUTH_DEFAULT_TTL_SECONDS,
      maxProviderAttempts: config.maxProviderAttempts ?? DEFAULT_MAX_PROVIDER_ATTEMPTS,
    };
    if (this.config.apiToken && this.config.apiToken.length < 32) throw new Error('Hosted relayer token must contain at least 32 characters');
    this.router = router;
    this.streamHandler = streamHandler;
    this.e2eeKeyPair = e2eeKeyPair;

    this.schedulerConfig.updateOverride({ mode: 'new', rolloutPct: 100, killSwitch: false });
    const schedulerCfg = this.schedulerConfig.get();
    const sticky = new SessionStickyTable({
      capacity: schedulerCfg.stickyMaxSize ?? schedulerCfg.stickyTableCapacity,
      ttlMs: schedulerCfg.stickyTTLMs,
    });
    this.schedulerLogger = new SchedulerLogger(schedulerCfg);
    this.scheduler = new Scheduler(this.router, sticky, this.schedulerConfig, this.schedulerLogger);

    if (this.config.relayerPrivateKey) {
      const account = privateKeyToAccount(this.config.relayerPrivateKey);
      this.relayerAccount = account;
      this.relayerClient = createWalletClient({
        account,
        chain: chainFor(this.config.chainId, this.config.rpcUrl),
        transport: viemHttp(this.config.rpcUrl),
      });
    }
  }

  async start(): Promise<void> {
    await assertPaymentDeployment(this.config.escrowPoolAddress, this.config.rpcUrl, this.config.chainId);
    if (this.server) {
      return;
    }
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => {
        console.error('[HostedGateway] request failed:', error);
        if (!res.headersSent) {
          sendError(res, error);
        } else {
          res.end();
        }
      });
    });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
    this.server.maxConnections = 128;
    this.cleanupTimer = setInterval(() => this.cleanupPreparedRequests(), 30_000);
    this.cleanupTimer.unref();
    await new Promise<void>((resolve) => this.server!.listen(this.config.port, this.config.host, resolve));
    console.log(`[HostedGateway] Listening on ${this.config.publicBaseUrl}`);
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (!this.server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server!.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = null;
  }

  async prepare(input: HostedGatewayPrepareRequest): Promise<HostedGatewayPrepareResponse> {
    await assertPaymentDeployment(this.config.escrowPoolAddress, this.config.rpcUrl, this.config.chainId);
    this.cleanupPreparedRequests();
    const body = input.request;
    validateChatRequest(body);
    if (!isAddress(input.buyer)) {
      throw new HttpError(400, 'Invalid buyer address', 'invalid_request');
    }
    if (!body?.model) {
      throw new HttpError(400, 'Missing request.model', 'invalid_request');
    }

    const requestId = randomUUID();
    const logBuilder = this.schedulerLogger.startRequest(requestId, body.model, 'hosted-gateway');
    const selection = await this.scheduler.select({
      model: body.model,
      requestId,
      body,
      userMaxPrice: body.max_price_per_1m,
      excludedPeerIds: new Set(),
      logBuilder,
    });
    const provider = selection.provider;
    if (!provider) {
      logBuilder.setOutcome('error', 'no_provider').finalize();
      throw new HttpError(503, `No provider available for model ${body.model}`, 'service_unavailable');
    }

    validateChatRequest(body);
    const estimatedInputTokens = inputTokenBudget(body, this.config.inputOverheadTokens);
    const estimatedOutputTokens = body.max_tokens ?? 1024;
    const prices = lockedPrices(provider.modelPricing);
    const estimatedCostMicroUsdc = tokenCost(estimatedInputTokens, estimatedOutputTokens, prices.inputPrice, prices.outputPrice);
    const payload = await encrypt(JSON.stringify(body), this.e2eeKeyPair.privateKey, deserializePublicKey(provider.announcement.publicKey));
    const expiresAt = Math.floor(Date.now() / 1000) + this.config.authorizationTtlSeconds;
    const quote: HostedAuthorizationQuote = {
      buyer: input.buyer,
      seller: provider.announcement.walletAddress,
      amount: estimatedCostMicroUsdc.toString(),
      nonce: deriveBitmapNonce(requestId, input.buyer, provider.announcement.walletAddress).toString(),
      expiresAt,
      poolId: poolIdFromAddress(this.config.escrowPoolAddress),
      nonceMode: 'bitmap', requestId, payloadHash: hashInferencePayload(payload),
      inputPrice: prices.inputPrice.toString(), outputPrice: prices.outputPrice.toString(),
      maxInputTokens: estimatedInputTokens, maxOutputTokens: estimatedOutputTokens,
    };
    const preparedRequestId = randomUUID();
    const prepared: PreparedRequest = {
      preparedRequestId,
      requestId,
      buyer: input.buyer,
      body,
      bodyHash: hashJson(body),
      provider,
      alternatives: selection.alternatives,
      quote,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedCostMicroUsdc,
      expiresAtMs: Date.now() + PREPARED_REQUEST_TTL_MS,
      createdAt: Date.now(),
      payload,
    };
    this.cleanupPreparedRequests();
    if (this.preparedRequests.size >= 1000) throw new HttpError(429, 'Too many pending requests', 'capacity_limit');
    let preparedBytes = payload.length + JSON.stringify(body).length;
    for (const item of this.preparedRequests.values()) preparedBytes += item.payload.length + JSON.stringify(item.body).length;
    if (preparedBytes > 32 * 1_048_576) throw new HttpError(429, 'Prepared request memory budget exceeded', 'capacity_limit');
    this.preparedRequests.set(preparedRequestId, prepared);

    logBuilder
      .setAttempts(0)
      .setLatency(undefined, Date.now() - prepared.createdAt)
      .setOutcome('success')
      .finalize();

    return this.buildPrepareResponse(prepared);
  }

  encodeExecuteToken(token: HostedGatewayExecuteToken): string {
    return `claw_${Buffer.from(JSON.stringify(token), 'utf8').toString('base64url')}`;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const now = Date.now();
    const ip = req.socket.remoteAddress ?? 'unknown';
    for (const [key, value] of this.rateWindows) if (now - value.start > 60_000) this.rateWindows.delete(key);
    if (!this.rateWindows.has(ip) && this.rateWindows.size >= 4096) { sendJson(res, 429, { error: { message: 'Gateway busy' } }); return; }
    const window = this.rateWindows.get(ip) ?? { count: 0, start: now };
    this.rateWindows.set(ip, window);
    if (++window.count > 120) { sendJson(res, 429, { error: { message: 'Rate limit exceeded' } }); return; }
    this.cleanupPreparedRequests();
    if (req.method === 'POST' && new URL(req.url ?? '/', this.config.publicBaseUrl).pathname === '/v1/claw/settle') {
      const body = await readJsonBody<any>(req);
      const pending = this.pendingSettlements.get(body.preparedRequestId);
      if (!pending || pending.submitted) { sendJson(res, 409, { error: { message: 'Settlement not pending' } }); return; }
      const auth = quoteToSignedAuthorization(body.authorization);
      const intent = pending.intent;
      if (auth.buyer.toLowerCase() !== intent.buyer.toLowerCase() || auth.seller.toLowerCase() !== intent.seller.toLowerCase() ||
          auth.amount !== pending.amount || auth.nonce !== intent.nonce || auth.poolId.toLowerCase() !== intent.poolId.toLowerCase() ||
          auth.expiresAt !== intent.expiresAt || auth.nonceMode !== intent.nonceMode ||
          !(await verifyAuthorizationSignature(auth, intent.buyer, getDefaultAuthorizationDomain(this.config.escrowPoolAddress, this.config.chainId)))) {
        sendJson(res, 401, { error: { message: 'Invalid final payment signature' } }); return;
      }
      if (pending.submitted) { sendJson(res, 409, { error: { message: 'Settlement already submitted' } }); return; }
      pending.submitted = true; pending.resolve(auth);
      await pending.ack;
      sendJson(res, 200, { accepted: true }); return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', this.config.publicBaseUrl);
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        peerPublicKey: serializePublicKey(this.e2eeKeyPair.publicKey),
        relayerEnabled: this.relayerClient != null,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      await this.handleModels(res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/claw/prepare') {
      await this.handlePrepare(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      await this.handleChatCompletions(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/claw/deposit/permit') {
      await this.handleDepositWithPermit(req, res);
      return;
    }

    sendJson(res, 404, { error: { message: 'Not found', type: 'not_found' } });
  }

  private async handleModels(res: http.ServerResponse): Promise<void> {
    const models = await this.router.listModels(this.config.discoverableModels ?? []);
    sendJson(res, 200, {
      object: 'list',
      data: models.map((id) => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'clawmarket',
      })),
    });
  }

  private async handlePrepare(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const raw = await readJsonBody<any>(req);
      const buyer = normalizeAddress(raw?.buyer ?? req.headers['x-claw-buyer-address']);
      const request = raw?.request ?? raw;
      const response = await this.prepare({ buyer: buyer as `0x${string}`, request });
      sendJson(res, 200, response);
    } catch (error) {
      sendError(res, error);
    }
  }

  private async handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJsonBody<ChatCompletionRequest>(req);
    const token = parseExecuteToken(req);
    if (!token) {
      sendJson(res, 401, {
        error: {
          message: 'Hosted Gateway requires a Claw execute token from /v1/claw/prepare',
          type: 'authorization_required',
        },
      });
      return;
    }

    const prepared = this.preparedRequests.get(token.preparedRequestId);
    if (!prepared || Date.now() > prepared.expiresAtMs) {
      sendJson(res, 409, { error: { message: 'Prepared request expired or not found', type: 'prepared_expired' } });
      return;
    }
    if (hashJson(body) !== prepared.bodyHash) {
      sendJson(res, 409, { error: { message: 'Request body does not match prepared quote', type: 'request_mismatch' } });
      return;
    }

    const authorization = quoteToSignedAuthorization(token.authorization);
    const validation = await this.validateAuthorization(prepared, authorization);
    if (!validation.ok) {
      sendJson(res, 401, { error: { message: validation.message, type: 'invalid_authorization' } });
      return;
    }

    if (prepared.executing) { sendJson(res, 409, { error: { message: 'Request already executing' } }); return; }
    prepared.executing = true;
    try {
      await this.executePrepared(prepared, authorization, res);
      this.preparedRequests.delete(prepared.preparedRequestId);
    } catch (error) {
      const payload = parseProviderError(error);
      if (payload?.providerHint) {
        this.router.observeProvider(prepared.provider.announcement.peerId, payload.providerHint);
      }
      if (payload?.statusCode === 429 || payload?.type === 'backpressure_soft_reject') {
        this.router.markTemporarilyUnavailable(
          prepared.provider.announcement.peerId,
          prepared.body.model,
          Math.max(1, payload.retryAfterSeconds ?? 1) * 1000,
          payload.type,
        );
      } else {
        this.router.markFailed(prepared.provider.announcement.peerId);
      }
      if (!res.headersSent) {
        sendJson(res, payload?.statusCode ?? 502, {
          error: {
            message: payload?.message ?? (error instanceof Error ? error.message : 'Provider request failed'),
            type: payload?.type ?? 'upstream_error',
          },
        });
      } else {
        if (!res.writableEnded) { res.write(`data: ${JSON.stringify({ error: { message: 'Settlement or delivery failed' } })}\n\n`); res.end(); }
      }
    } finally {
      this.pendingSettlements.delete(prepared.preparedRequestId);
      this.preparedRequests.delete(prepared.preparedRequestId);
    }
  }

  private async handleDepositWithPermit(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.config.apiToken || req.headers.authorization !== `Bearer ${this.config.apiToken}`) {
      sendJson(res, 401, { error: { message: 'Relayer access token required' } }); return;
    }
    if (!this.relayerClient) {
      sendJson(res, 503, {
        error: { message: 'Gasless relayer is not configured', type: 'relayer_unavailable' },
      });
      return;
    }

    try {
      const body = await readJsonBody<HostedGatewayPermitDepositRequest>(req);
      if (!isAddress(body.buyer) || !isHex(body.r) || !isHex(body.s)) {
        throw new HttpError(400, 'Invalid permit payload', 'invalid_request');
      }
      await assertPaymentDeployment(this.config.escrowPoolAddress, this.config.rpcUrl, this.config.chainId);
      const txHash = await this.relayerClient.writeContract({
        account: this.relayerAccount!,
        address: this.config.escrowPoolAddress,
        abi: ESCROW_POOL_ABI,
        functionName: 'depositWithPermit',
        chain: chainFor(this.config.chainId, this.config.rpcUrl),
        args: [
          body.buyer,
          BigInt(body.amount),
          BigInt(body.deadline),
          body.v,
          body.r,
          body.s,
        ],
      });
      // A successful response means credited, just like the local buyer deposit API.
      const receipt = await createPublicClient({ chain: chainFor(this.config.chainId, this.config.rpcUrl), transport: viemHttp(this.config.rpcUrl) }).waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') throw new HttpError(502, `Deposit reverted: ${txHash}`, 'deposit_reverted');
      sendJson(res, 200, { txHash } satisfies HostedGatewayDepositResponse);
    } catch (error) {
      sendError(res, error);
    }
  }

  private async executePrepared(
    prepared: PreparedRequest,
    authorization: SignedAuthorization,
    res: http.ServerResponse,
  ): Promise<void> {
    const provider = prepared.provider;
    const providerPubKey = deserializePublicKey(provider.announcement.publicKey);
    const encryptedPayload = prepared.payload;
    const inferenceReq: InferenceRequest = {
      type: 'request',
      requestId: prepared.requestId,
      payload: encryptedPayload,
      buyerPublicKey: serializePublicKey(this.e2eeKeyPair.publicKey),
      buyerAddress: authorization.buyer,
      model: prepared.body.model,
      authorization,
      clientVersion: 'hosted-gateway',
      protocolVersion: PROTOCOL_VERSION,
      timestamp: Date.now(),
    };

    let resolveAck!: () => void, rejectAck!: (error: unknown) => void;
    const ack = new Promise<void>((resolve, reject) => { resolveAck = resolve; rejectAck = reject; });
    void ack.catch(() => {});
    const settle = async (message: ProtocolMessage): Promise<SignedAuthorization> => {
      const intent = authorization as SignedInferenceIntent;
      const amount = settlementAmount(intent, (message as any).usage);
      let timer: ReturnType<typeof setTimeout>;
      try {
        return await new Promise<SignedAuthorization>((resolve, reject) => {
          this.pendingSettlements.set(prepared.preparedRequestId, { intent, amount, resolve, submitted: false, ack });
          timer = setTimeout(() => reject(new Error('Buyer delivery confirmation timed out')), 12_000);
        });
      } finally { clearTimeout(timer!); this.pendingSettlements.delete(prepared.preparedRequestId); }
    };
    const startedAt = Date.now();
    let responseMeta: ProviderResponseMeta;
    try {
      responseMeta = prepared.body.stream === true
        ? await this.handleStreamResponse(res, inferenceReq, provider, providerPubKey, prepared.preparedRequestId, settle)
        : await this.handleNonStreamResponse(res, inferenceReq, provider, providerPubKey, prepared.preparedRequestId, settle);
      resolveAck();
    } catch (error) { rejectAck(error); throw error; }
    this.router.recordObservedLatency(provider.announcement.peerId, Date.now() - startedAt);
    if (responseMeta.providerHint) {
      this.router.observeProvider(provider.announcement.peerId, responseMeta.providerHint);
    }
    this.router.markSuccess(provider.announcement.peerId);
  }

  private async handleStreamResponse(
    res: http.ServerResponse,
    inferenceReq: InferenceRequest,
    provider: ScoredProvider,
    providerPubKey: Uint8Array,
    preparedRequestId: string,
    settle: (message: ProtocolMessage) => Promise<SignedAuthorization>,
  ): Promise<ProviderResponseMeta> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...corsHeaders(),
    });

    let providerHint: ProviderRuntimeHint | null = null;
    let sawTerminal = false, content = '';
    for await (const msg of this.streamHandler.sendRequest(provider.announcement.peerId, inferenceReq, {
      addresses: provider.announcement.multiaddrs,
      settle,
    })) {
      if (msg.type === 'stream_chunk' && msg.payload) {
        const decrypted = await decrypt(msg.payload, this.e2eeKeyPair.privateKey, providerPubKey);
        const parsed = parseProviderPayload(decrypted);
        if (!parsed.content) {
          continue;
        }
        content += parsed.content;
        res.write(`data: ${JSON.stringify({
          id: inferenceReq.requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          choices: [{ index: 0, delta: { content: parsed.content }, finish_reason: null }],
        })}\n\n`);
      } else if (msg.type === 'stream_end') {
        if (!content.trim()) throw new Error('Empty provider delivery');
        settlementAmount(inferenceReq.authorization as SignedInferenceIntent, (msg as any).usage);
        sawTerminal = true;
        providerHint = normalizeProviderHint((msg as any).providerHint);
        res.write(`data: ${JSON.stringify({
          id: inferenceReq.requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: (msg as any).usage ?? undefined,
          clawSettlement: { preparedRequestId },
          modelProvenanceProof: (msg as any).modelProvenanceProof,
        })}\n\n`);
      } else if (msg.type === 'error') {
        throw new Error(msg.error ?? 'Provider error');
      }
    }
    if (!sawTerminal) throw new Error('Provider stream ended without a terminal message');
    res.write('data: [DONE]\n\n'); res.end(); return { providerHint };
  }

  private async handleNonStreamResponse(
    res: http.ServerResponse,
    inferenceReq: InferenceRequest,
    provider: ScoredProvider,
    providerPubKey: Uint8Array,
    preparedRequestId: string,
    settle: (message: ProtocolMessage) => Promise<SignedAuthorization>,
  ): Promise<ProviderResponseMeta> {
    let fullContent = '';
    let usage: TokenUsage | undefined;
    let providerHint: ProviderRuntimeHint | null = null;
    let sawTerminal = false;

    for await (const msg of this.streamHandler.sendRequest(provider.announcement.peerId, inferenceReq, {
      addresses: provider.announcement.multiaddrs,
      settle,
    })) {
      if (msg.type === 'response' && msg.payload) {
        const decrypted = await decrypt(msg.payload, this.e2eeKeyPair.privateKey, providerPubKey);
        const parsed = parseProviderPayload(decrypted);
        fullContent = parsed.content ?? '';
        usage = (msg as any).usage;
        providerHint = normalizeProviderHint((msg as any).providerHint);
        sawTerminal = true;
      } else if (msg.type === 'stream_chunk' && msg.payload) {
        const decrypted = await decrypt(msg.payload, this.e2eeKeyPair.privateKey, providerPubKey);
        const parsed = parseProviderPayload(decrypted);
        fullContent += parsed.content ?? '';
        usage = parsed.usage ?? usage;
      } else if (msg.type === 'stream_end') {
        usage = (msg as any).usage ?? usage;
        providerHint = normalizeProviderHint((msg as any).providerHint);
        sawTerminal = true;
      } else if (msg.type === 'error') {
        throw new Error(msg.error ?? 'Provider error');
      }
      if (sawTerminal) {
        if (!fullContent.trim()) throw new Error('Empty provider delivery');
        settlementAmount(inferenceReq.authorization as SignedInferenceIntent, usage);
        sendJson(res, 200, { id: inferenceReq.requestId, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: inferenceReq.model,
          choices: [{ index: 0, message: { role: 'assistant', content: fullContent }, finish_reason: 'stop' }], usage,
          clawSettlement: { preparedRequestId }, modelProvenanceProof: (msg as any).modelProvenanceProof });
      }
    }

    if (!sawTerminal) {
      throw new Error('Provider stream closed before a terminal message was received');
    }

    return { providerHint };
  }

  private async validateAuthorization(
    prepared: PreparedRequest,
    authorization: SignedAuthorization,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (authorization.buyer.toLowerCase() !== prepared.buyer.toLowerCase()) {
      return { ok: false, message: 'Authorization buyer does not match prepared buyer' };
    }
    if (authorization.seller.toLowerCase() !== prepared.provider.announcement.walletAddress.toLowerCase()) {
      return { ok: false, message: 'Authorization seller does not match selected provider' };
    }
    if (authorization.poolId.toLowerCase() !== poolIdFromAddress(this.config.escrowPoolAddress).toLowerCase()) {
      return { ok: false, message: 'Authorization poolId mismatch' };
    }
    if (authorization.amount !== prepared.estimatedCostMicroUsdc) {
      return { ok: false, message: 'Authorization amount below prepared quote' };
    }
    if (authorization.expiresAt < nowSeconds) {
      return { ok: false, message: 'Authorization expired' };
    }
    const intent = authorization as SignedInferenceIntent;
    if (intent.requestId !== prepared.requestId || intent.payloadHash !== prepared.quote.payloadHash ||
        intent.inputPrice !== BigInt(prepared.quote.inputPrice) || intent.outputPrice !== BigInt(prepared.quote.outputPrice) ||
        intent.maxInputTokens !== prepared.quote.maxInputTokens || intent.maxOutputTokens !== prepared.quote.maxOutputTokens ||
        intent.nonce !== BigInt(prepared.quote.nonce) || intent.expiresAt !== prepared.quote.expiresAt || intent.nonceMode !== 'bitmap') return { ok: false, message: 'Intent does not match prepared request' };
    const valid = await verifyInferenceIntent(intent, this.config.escrowPoolAddress, this.config.chainId);
    return valid ? { ok: true } : { ok: false, message: 'Authorization signature invalid' };
  }

  private buildPrepareResponse(prepared: PreparedRequest): HostedGatewayPrepareResponse {
    const domain = getInferenceIntentDomain(this.config.escrowPoolAddress, this.config.chainId);
    return {
      preparedRequestId: prepared.preparedRequestId,
      requestId: prepared.requestId,
      executeUrl: `${this.config.publicBaseUrl}/v1/chat/completions`,
      estimatedInputTokens: prepared.estimatedInputTokens,
      estimatedOutputTokens: prepared.estimatedOutputTokens,
      paymentToken: PAYMENT_TOKEN,
      estimatedCostBaseUnits: prepared.estimatedCostMicroUsdc.toString(),
      estimatedCostToken: formatPaymentAmount(prepared.estimatedCostMicroUsdc),
      estimatedCostMicroUsdc: prepared.estimatedCostMicroUsdc.toString(),
      estimatedCostUsd: formatMicroUsdc(prepared.estimatedCostMicroUsdc),
      authorization: prepared.quote,
      typedData: {
        domain,
        primaryType: 'InferenceIntent',
        types: INFERENCE_INTENT_TYPES as any,
        message: {
          ...prepared.quote,
          buyer: prepared.quote.buyer,
          seller: prepared.quote.seller,
          amount: prepared.quote.amount,
          nonce: prepared.quote.nonce,
          expiresAt: prepared.quote.expiresAt,
          poolId: prepared.quote.poolId,
          nonceMode: 1,
        },
      },
      provider: {
        peerId: prepared.provider.announcement.peerId,
        walletAddress: prepared.provider.announcement.walletAddress,
        model: prepared.body.model,
        pricing: prepared.provider.modelPricing,
        score: prepared.provider.score,
      },
      alternatives: prepared.alternatives.map((provider) => ({
        peerId: provider.announcement.peerId,
        walletAddress: provider.announcement.walletAddress,
        pricing: provider.modelPricing,
        score: provider.score,
      })),
    };
  }

  private cleanupPreparedRequests(): void {
    const now = Date.now();
    for (const [id, prepared] of this.preparedRequests) {
      if (prepared.expiresAtMs <= now) {
        this.preparedRequests.delete(id);
      }
    }
  }
}

function parseExecuteToken(req: http.IncomingMessage): HostedGatewayExecuteToken | null {
  const authHeader = firstHeader(req.headers.authorization);
  const rawHeaderToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : null;
  const token = rawHeaderToken ?? firstHeader(req.headers['x-claw-execute-token']);
  if (token) {
    return decodeExecuteToken(token);
  }

  const preparedRequestId = firstHeader(req.headers['x-claw-prepared-request-id']);
  const authorizationHeader = firstHeader(req.headers['x-claw-authorization']);
  if (!preparedRequestId || !authorizationHeader) {
    return null;
  }
  try {
    return {
      preparedRequestId,
      authorization: JSON.parse(Buffer.from(authorizationHeader, 'base64url').toString('utf8')),
    };
  } catch {
    return null;
  }
}

function decodeExecuteToken(token: string): HostedGatewayExecuteToken | null {
  const encoded = token.startsWith('claw_') ? token.slice('claw_'.length) : token;
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as HostedGatewayExecuteToken;
  } catch {
    return null;
  }
}

function quoteToSignedAuthorization(
  quote: HostedAuthorizationQuote & { signature: `0x${string}` },
): SignedAuthorization {
  return {
    buyer: quote.buyer,
    seller: quote.seller,
    ...('payloadHash' in quote ? { requestId: quote.requestId, payloadHash: quote.payloadHash, inputPrice: BigInt(quote.inputPrice), outputPrice: BigInt(quote.outputPrice), maxInputTokens: quote.maxInputTokens, maxOutputTokens: quote.maxOutputTokens } : {}),
    amount: BigInt(quote.amount),
    nonce: BigInt(quote.nonce),
    expiresAt: quote.expiresAt,
    poolId: quote.poolId,
    nonceMode: quote.nonceMode,
    signature: quote.signature,
  };
}

function deriveBitmapNonce(requestId: string, buyer: string, seller: string): bigint {
  const digest = createHash('sha256').update(`${requestId}:${buyer.toLowerCase()}:${seller.toLowerCase()}`).digest('hex');
  return BigInt(`0x${digest}`);
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function formatMicroUsdc(value: bigint): string { return formatPaymentAmount(value); }

function parseProviderPayload(payload: string): { content?: string; usage?: TokenUsage } {
  try {
    const parsed = JSON.parse(payload) as any;
    const choice = parsed?.choices?.[0];
    const content = choice?.delta?.content ?? choice?.message?.content ?? parsed?.content;
    return { content: typeof content === 'string' ? content : undefined, usage: parsed?.usage };
  } catch {
    return { content: payload };
  }
}

function normalizeProviderHint(value: unknown): ProviderRuntimeHint | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const hint = value as ProviderRuntimeHint;
  return {
    ...(typeof hint.loadHint === 'number' ? { loadHint: hint.loadHint } : {}),
    ...(typeof hint.inflight === 'number' ? { inflight: hint.inflight } : {}),
    ...(typeof hint.queueDepth === 'number' ? { queueDepth: hint.queueDepth } : {}),
    ...(typeof hint.retryAfterSeconds === 'number' ? { retryAfterSeconds: hint.retryAfterSeconds } : {}),
    ...(typeof hint.observedLatencyMs === 'number' ? { observedLatencyMs: hint.observedLatencyMs } : {}),
  };
}

function parseProviderError(error: unknown): ProviderErrorPayload | null {
  const message = error instanceof Error ? error.message : String(error);
  try {
    return JSON.parse(message) as ProviderErrorPayload;
  } catch {
    return null;
  }
}

function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1_048_576) { reject(new HttpError(413, 'Request body too large', 'body_limit')); req.resume(); return; } chunks.push(chunk); });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
      } catch {
        reject(new HttpError(400, 'Invalid JSON body', 'invalid_request'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders() });
  res.end(JSON.stringify(body));
}

function sendError(res: http.ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    sendJson(res, error.statusCode, { error: { message: error.message, type: error.type } });
    return;
  }
  sendJson(res, 500, {
    error: { message: error instanceof Error ? error.message : String(error), type: 'internal_error' },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': [
      'Content-Type',
      'Authorization',
      'X-Claw-Authorization',
      'X-Claw-Buyer-Address',
      'X-Claw-Execute-Token',
      'X-Claw-Prepared-Request-Id',
    ].join(', '),
  };
}

function normalizeAddress(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && isAddress(raw) ? raw : null;
}

function isAddress(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isHex(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[a-fA-F0-9]+$/.test(value);
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function chainFor(chainId: number, rpcUrl: string): Chain {
  if (chainId === baseSepolia.id) {
    return baseSepolia;
  }
  return {
    id: chainId,
    name: `Chain ${chainId}`,
    nativeCurrency: { name: PAYMENT_NATIVE_SYMBOL, symbol: PAYMENT_NATIVE_SYMBOL, decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly type: string,
  ) {
    super(message);
  }
}

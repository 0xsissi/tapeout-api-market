import { PAYMENT_TOKEN, PAYMENT_SCALE, formatPaymentAmount, parsePaymentAmount, requirePaymentLimit, paymentBudget } from '@clawmarket/shared';
/**
 * Consumer Gateway — Main HTTP server exposing an OpenAI-compatible API on localhost.
 * Uses Node.js native `http` module. Routes incoming chat completion requests through
 * the P2P network to the best available provider, handling EscrowPool
 * authorizations and E2EE.
 */

import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { loadApiToken, validLocalRequest } from './api-security.js';

import type {
  ConsumerConfig,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ClientVersionPolicy,
  InferenceRequest,
  ProviderErrorPayload,
  ProviderRuntimeHint,
  QuoteMessage,
  TokenUsage,
  UpstreamProof,
  SignedInferenceIntent,
  ProtocolMessage,
  ModelProvenancePolicy,
  ModelProvenanceRequestBinding,
  ModelProvenanceVerification,
  ModelProvenanceVerifier,
} from '@clawmarket/shared';
import {
  AUTH_DEFAULT_TTL_SECONDS,
  validateChatRequest, inputTokenBudget, lockedPrices, tokenCost, settlementAmount,
  ClientPolicyManager,
  PROTOCOL_VERSION,
  UNKNOWN_CLIENT_VERSION,
  isClientVersionAllowed,
  normalizeVersion,
} from '@clawmarket/shared';
import { AuthorizationSigner, poolIdFromAddress, hashInferencePayload } from '@clawmarket/crypto';
import { encrypt, decrypt, generateKeyPair, serializePublicKey, deserializePublicKey } from '@clawmarket/crypto';
import { assertModelProvenanceReady, modelProvenanceRequestBinding, ModelProvenanceTextDigest, ModelProvenanceError, verifyModelProvenance } from '@clawmarket/crypto';
import type { StreamHandler } from '@clawmarket/p2p-node';

import { P2PRouter, type ScoredProvider } from './router.js';
import { WalletManager } from './wallet.js';
import { PoolManager } from './pool-manager.js';
import { QualityMonitor } from './quality-monitor.js';
import { SchedulerAdminServer } from './scheduler/admin-endpoint.js';
import { SchedulerConfigManager } from './scheduler/config.js';
import { SchedulerLogger } from './scheduler/logger.js';
import { Scheduler } from './scheduler/scheduler.js';
import { SessionStickyTable } from './scheduler/session-sticky.js';
import { LocalQuoteCache } from './quote-cache.js';
import { softmaxSample } from './scheduler/softmax.js';

const MAX_PROVIDER_ATTEMPTS = 3;
const QUOTE_PRICE_CIRCUIT_MULTIPLIER = 50;
const DEFAULT_DISCOVERABLE_MODELS = [
  'gpt-5.4',
  'gpt-4o',
  'gpt-4o-mini',
  'claude-3-opus',
  'claude-3-sonnet',
  'claude-3-haiku',
];

interface NetworkProviderStatus {
  peerId: string;
  walletAddress: string;
  region: string;
  score: number;
  model: string;
  inputPer1m: number;
  outputPer1m: number;
  p0?: number;
  alpha?: number;
  maxConcurrent: number;
  reputation: unknown;
  updatedAt: number;
  multiaddrs: string[];
}

interface NetworkModelStatus {
  model: string;
  providerCount: number;
  bestProvider: NetworkProviderStatus | null;
  providers: NetworkProviderStatus[];
  error?: string;
}

interface ProviderResponseMeta {
  providerHint: ProviderRuntimeHint | null;
  upstreamProof: UpstreamProof | null;
}

export interface ConsumerGatewayOptions {
  quoteCache?: LocalQuoteCache;
  softmaxBeta?: number;
  modelProvenanceVerifier?: ModelProvenanceVerifier;
}

interface PricedProviderCandidate {
  provider: ScoredProvider;
  quote: QuoteMessage | null;
  currentPrice: number;
}

type QuoteSelectionFallbackReason =
  | 'no_quote_cache'
  | 'no_active_quotes'
  | 'no_provider_match'
  | 'all_candidates_filtered'
  | 'price_circuit_tripped';

interface QuoteSelectionFallback {
  fallback: QuoteSelectionFallbackReason;
  cacheSize: number;
  activeQuoteCount: number;
}

interface QuoteSelectionSuccess {
  result: {
    provider: ScoredProvider;
    quote: QuoteMessage | null;
    currentPrice: number;
    alternatives: PricedProviderCandidate[];
  };
}

type QuoteSelectionResult = QuoteSelectionSuccess | QuoteSelectionFallback;

interface ConsumerMetricsSnapshot {
  quoteCacheSize: number;
  requestsOutboundTotal: {
    ok: number;
    rejected: number;
    timeout: number;
    error: number;
  };
  quoteFallbackTotal: Record<QuoteSelectionFallbackReason, number>;
}

/**
 * Consumer-facing HTTP gateway that translates OpenAI-compatible requests
 * into P2P inference requests routed to the best available provider.
 */
export class ConsumerGateway {
  private config: ConsumerConfig;
  private server: http.Server | null = null;
  private router: P2PRouter;
  private wallet: WalletManager;
  private poolManager: PoolManager | null = null;
  private qualityMonitor: QualityMonitor;
  private streamHandler: StreamHandler;
  private authorizationSigner: AuthorizationSigner | null = null;
  private readonly settlementAttempts = new WeakSet<InferenceRequest>();
  private readonly settlementAmounts = new WeakMap<InferenceRequest, bigint>();
  private readonly provenanceBindings = new WeakMap<InferenceRequest, ModelProvenanceRequestBinding>();
  private readonly provenanceResults = new WeakMap<InferenceRequest, ModelProvenanceVerification>();
  private readonly provenancePolicy: ModelProvenancePolicy;
  private readonly provenanceVerifier?: ModelProvenanceVerifier;
  private e2eeKeyPair = generateKeyPair();
  private schedulerConfig: SchedulerConfigManager;
  private clientPolicy: ClientPolicyManager;
  private schedulerLogger: SchedulerLogger;
  private sessionSticky: SessionStickyTable;
  private scheduler: Scheduler;
  private schedulerAdminServer: SchedulerAdminServer;
  private schedulerConfigUnsubscribe: (() => void) | null = null;
  private readonly quoteCache: LocalQuoteCache | null;
  private readonly softmaxBeta: number;
  private readonly outboundMetrics: ConsumerMetricsSnapshot['requestsOutboundTotal'] = {
    ok: 0,
    rejected: 0,
    timeout: 0,
    error: 0,
  };
  private readonly quoteFallbackMetrics: Record<QuoteSelectionFallbackReason, number> = {
    no_quote_cache: 0,
    no_active_quotes: 0,
    no_provider_match: 0,
    all_candidates_filtered: 0,
    price_circuit_tripped: 0,
  };

  constructor(
    config: ConsumerConfig,
    router: P2PRouter,
    wallet: WalletManager,
    streamHandler: StreamHandler,
    qualityMonitor?: QualityMonitor,
    options?: ConsumerGatewayOptions,
  ) {
    this.config = config;
    this.provenancePolicy = structuredClone(config.modelProvenance ?? { mode: 'off' });
    this.provenanceVerifier = options?.modelProvenanceVerifier;
    assertModelProvenanceReady(this.provenancePolicy, this.provenanceVerifier);
    config.maxRequestCostToken = requirePaymentLimit(config.maxRequestCostToken, config.maxRequestCostUsd, 'maxRequestCostToken');
    this.router = router;
    this.wallet = wallet;
    this.streamHandler = streamHandler;
    this.qualityMonitor = qualityMonitor ?? new QualityMonitor();
    this.schedulerConfig = new SchedulerConfigManager();
    this.clientPolicy = new ClientPolicyManager();
    this.schedulerLogger = new SchedulerLogger(this.schedulerConfig.get());
    this.sessionSticky = new SessionStickyTable({
      capacity: this.schedulerConfig.get().stickyMaxSize,
      ttlMs: this.schedulerConfig.get().stickyTTLMs,
    });
    this.scheduler = new Scheduler(
      this.router,
      this.sessionSticky,
      this.schedulerConfig,
      this.schedulerLogger,
    );
    this.schedulerAdminServer = new SchedulerAdminServer(
      this.schedulerConfig,
      this.schedulerLogger,
      this.sessionSticky,
    );
    this.quoteCache = options?.quoteCache ?? null;
    this.softmaxBeta = options?.softmaxBeta ?? 3;
    this.schedulerConfigUnsubscribe = this.schedulerConfig.onChange((_previous, next) => {
      this.schedulerLogger.updateConfig(next);
      this.sessionSticky.updateConfig({
        capacity: next.stickyMaxSize,
        ttlMs: next.stickyTTLMs,
      });
    });
  }

  /**
   * Start the HTTP server and initialise dependent services.
   */
  async start(): Promise<void> {
    this.schedulerConfig.startWatching();
    this.clientPolicy.startWatching();
    const poolAddress = this.getEscrowPoolAddress();
    await this.wallet.init(this.config.privateKey, poolAddress);
    const privateKey = this.wallet.getPrivateKey();
    this.poolManager = new PoolManager(
      privateKey,
      poolAddress,
      this.config.rpcUrl,
      this.config.chainId,
    );
    this.authorizationSigner = new AuthorizationSigner(
      privateKey,
      poolAddress,
      this.config.rpcUrl,
      this.config.chainId,
    );

    this.config.apiToken = this.config.apiToken ?? process.env.CLAWMARKET_API_TOKEN ?? loadApiToken();
    if (this.config.apiToken.length < 32) throw new Error('Local API token must contain at least 32 characters');
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        console.error('[ConsumerGateway] Unhandled error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Internal server error', type: 'server_error' } }));
          return;
        }
        if (!res.writableEnded) {
          res.end();
        }
      });
    });

    await new Promise<void>((resolve) => {
      this.server!.requestTimeout = 30_000;
      this.server!.headersTimeout = 10_000;
      this.server!.maxConnections = 128;
      this.server!.listen(this.config.port, '127.0.0.1', () => {
        console.log(`[ConsumerGateway] Listening on http://127.0.0.1:${this.config.port}`);
        resolve();
      });
    });
    await this.schedulerAdminServer.start();
  }

  /**
   * Gracefully stop the HTTP server.
   */
  async stop(): Promise<void> {
    if (this.server?.listening) await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = null;
    this.router.stopRefreshLoop();
    this.schedulerConfig.stopWatching();
    this.clientPolicy.stopWatching();
    await this.schedulerAdminServer.stop();
    this.schedulerConfigUnsubscribe?.();
    this.schedulerConfigUnsubscribe = null;
    console.log('[ConsumerGateway] Server stopped');
  }

  get metricsSnapshot(): ConsumerMetricsSnapshot {
    return {
      quoteCacheSize: this.quoteCache?.size() ?? 0,
      requestsOutboundTotal: { ...this.outboundMetrics },
      quoteFallbackTotal: { ...this.quoteFallbackMetrics },
    };
  }

  // ---- HTTP routing ----

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!validLocalRequest(req, this.config.port)) {
      res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Forbidden host or origin' } })); return;
    }
    if (req.url !== '/health' && (!this.config.apiToken || req.headers.authorization !== `Bearer ${this.config.apiToken}`)) {
      res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Local API token required' } })); return;
    }
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    const url = req.url ?? '';

    if (req.method === 'GET' && url === '/health') {
      return this.handleHealth(res);
    }

    if (req.method === 'GET' && url === '/metrics') {
      return this.handleMetrics(res);
    }

    if (req.method === 'GET' && url === '/v1/models') {
      return this.handleModels(res);
    }

    if (req.method === 'GET' && url === '/v1/network/status') {
      return this.handleNetworkStatus(res);
    }

    if (req.method === 'GET' && (url === '/v1/wallet' || url === '/v1/escrow/balance' || url === '/v1/credits')) {
      return this.handleWalletSummary(res);
    }

    if (req.method === 'POST' && (url === '/v1/escrow/deposit' || url === '/v1/credits/purchase')) {
      return this.handleDeposit(req, res);
    }

    if (req.method === 'POST' && url === '/v1/escrow/withdraw/request') {
      return this.handleWithdrawRequest(req, res);
    }

    if (req.method === 'POST' && url === '/v1/escrow/withdraw/cancel') {
      return this.handleWithdrawCancel(res);
    }

    if (req.method === 'POST' && url === '/v1/escrow/withdraw/complete') {
      return this.handleWithdrawComplete(res);
    }

    if (req.method === 'POST' && url === '/v1/chat/completions') {
      return this.handleChatCompletions(req, res);
    }

    res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders() });
    res.end(JSON.stringify({ error: { message: 'Not found', type: 'invalid_request' } }));
  }

  // ---- Route handlers ----

  private handleHealth(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    res.end(
      JSON.stringify({
        status: 'ok',
        address: this.wallet.getAddress(),
        port: this.config.port,
        paymentToken: PAYMENT_TOKEN,
        escrowPool: this.getEscrowPoolAddress(),
        chainId: this.config.chainId,
      }),
    );
  }

  private handleMetrics(res: http.ServerResponse): void {
    const snapshot = this.metricsSnapshot;
    const lines = [
      '# HELP aimm_quote_cache_size Active quote entries stored locally.',
      '# TYPE aimm_quote_cache_size gauge',
      `aimm_quote_cache_size ${snapshot.quoteCacheSize}`,
      '# HELP aimm_requests_outbound_total Total outbound buyer requests grouped by result.',
      '# TYPE aimm_requests_outbound_total counter',
      `aimm_requests_outbound_total{result="ok"} ${snapshot.requestsOutboundTotal.ok}`,
      `aimm_requests_outbound_total{result="rejected"} ${snapshot.requestsOutboundTotal.rejected}`,
      `aimm_requests_outbound_total{result="timeout"} ${snapshot.requestsOutboundTotal.timeout}`,
      `aimm_requests_outbound_total{result="error"} ${snapshot.requestsOutboundTotal.error}`,
      '# HELP aimm_quote_fallback_total Total AIMM quote selection fallbacks grouped by reason.',
      '# TYPE aimm_quote_fallback_total counter',
      ...Object.entries(snapshot.quoteFallbackTotal).map(([reason, count]) =>
        `aimm_quote_fallback_total{reason="${reason}"} ${count}`,
      ),
    ];
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', ...corsHeaders() });
    res.end(`${lines.join('\n')}\n`);
  }

  private async handleModels(res: http.ServerResponse): Promise<void> {
    const models = this.router.listCachedModels(this.getDiscoverableModels())
      .filter((model) => this.router.getCachedProviders(model).length > 0);

    const data = models.map((id) => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'clawmarket',
    }));

    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    res.end(JSON.stringify({ object: 'list', data }));
  }

  private async handleNetworkStatus(res: http.ServerResponse): Promise<void> {
    const models: NetworkModelStatus[] = [];
    const visibleModels = this.router.listCachedModels(this.getDiscoverableModels());

    for (const model of visibleModels) {
      try {
        const providers = this.router.getCachedProviders(model);
        models.push({
          model,
          providerCount: providers.length,
          bestProvider: providers[0] ? serializeScoredProvider(providers[0]) : null,
          providers: providers.slice(0, 5).map(serializeScoredProvider),
        });
      } catch (err) {
        models.push({
          model,
          providerCount: 0,
          bestProvider: null,
          providers: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const bestModel = models.find((item) => item.bestProvider) ?? null;
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    res.end(
      JSON.stringify({
        object: 'clawmarket.network_status',
        paymentToken: PAYMENT_TOKEN,
        settlementPool: this.getEscrowPoolAddress(),
        updatedAt: Date.now(),
        routingStrategy: this.config.routingStrategy,
        maxPriceInputPer1m: this.config.maxPriceInputPer1m,
        maxPriceOutputPer1m: this.config.maxPriceOutputPer1m,
        models,
        bestProvider: bestModel?.bestProvider ?? null,
      }),
    );
  }

  private getDiscoverableModels(): string[] {
    const configured = this.config.discoverableModels?.map((item) => item.trim()).filter(Boolean) ?? [];
    return configured.length > 0 ? Array.from(new Set(configured)) : DEFAULT_DISCOVERABLE_MODELS;
  }

  private async handleWalletSummary(res: http.ServerResponse): Promise<void> {
    try {
      const wallet = await this.wallet.exportWallet();
      const escrowAvailableRaw = await this.poolManager!.getAvailableBalance();
      const pendingWithdraw = await this.poolManager!.getPendingWithdraw();
      const tokenAddress = await this.poolManager!.getTokenAddress();

      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(
        JSON.stringify({
          object: 'clawmarket.wallet',
          address: wallet.address,
          usdcBalance: wallet.balance,
          tokenBalance: wallet.balance,
          nativeBalance: wallet.nativeBalance,
          nativeBalanceWei: wallet.nativeBalanceWei,
          escrowPool: this.getEscrowPoolAddress(),
          paymentToken: PAYMENT_TOKEN,
          escrowAvailable: formatMicroUsdc(escrowAvailableRaw),
          escrowAvailableRaw: escrowAvailableRaw.toString(),
          tokenAddress,
          credits: {
            unit: PAYMENT_TOKEN.symbol,
            available: formatMicroUsdc(escrowAvailableRaw),
            availableRaw: escrowAvailableRaw.toString(),
          },
          pendingWithdraw: pendingWithdraw.unlockAt > 0n
            ? {
                amount: formatMicroUsdc(pendingWithdraw.amount),
                amountRaw: pendingWithdraw.amount.toString(),
                unlocksAt: Number(pendingWithdraw.unlockAt) * 1000,
              }
            : null,
        }),
      );
    } catch (err) {
      console.error('[ConsumerGateway] Failed to load wallet summary:', err);
      res.writeHead(502, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ error: { message: 'Wallet summary unavailable', type: 'wallet_error' } }));
    }
  }

  private async handleDeposit(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: AmountRequest;
    try {
      body = await parseJsonBody<AmountRequest>(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON body', type: 'invalid_request' } }));
      return;
    }

    const amountUsd = parseAmountUsd(body);
    if (amountUsd == null) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ error: { message: 'amountToken must be a positive number', type: 'invalid_request' } }));
      return;
    }

    try {
      const result = await this.poolManager!.depositWithApproval(amountUsd);
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(
        JSON.stringify({
          object: 'clawmarket.credits.purchase',
          paymentToken: PAYMENT_TOKEN,
          amountToken: amountUsd,
          amountUsd,
          escrowPool: this.getEscrowPoolAddress(),
          approvalTx: result.approvalTx ?? null,
          depositTx: result.depositTx,
        }),
      );
    } catch (err) {
      console.error('[ConsumerGateway] Deposit failed:', err);
      const message = err instanceof Error && err.message ? `Deposit failed: ${err.message}` : 'Deposit failed';
      res.writeHead(502, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ error: { message, type: 'escrow_error' } }));
    }
  }

  private async handleWithdrawRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: AmountRequest;
    try {
      body = await parseJsonBody<AmountRequest>(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON body', type: 'invalid_request' } }));
      return;
    }

    const amountUsd = parseAmountUsd(body);
    if (amountUsd == null) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ error: { message: 'amountToken must be a positive number', type: 'invalid_request' } }));
      return;
    }

    try {
      const tx = await this.poolManager!.requestWithdraw(amountUsd);
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(
        JSON.stringify({
          object: 'clawmarket.escrow.withdraw_request',
          paymentToken: PAYMENT_TOKEN,
          amountToken: amountUsd,
          amountUsd,
          escrowPool: this.getEscrowPoolAddress(),
          tx,
        }),
      );
    } catch (err) {
      console.error('[ConsumerGateway] Withdraw request failed:', err);
      res.writeHead(502, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ error: { message: 'Withdraw request failed', type: 'escrow_error' } }));
    }
  }

  private async handleWithdrawCancel(res: http.ServerResponse): Promise<void> {
    try {
      const tx = await this.poolManager!.cancelWithdraw();
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ object: 'clawmarket.escrow.withdraw_cancel', tx }));
    } catch (err) {
      console.error('[ConsumerGateway] Withdraw cancel failed:', err);
      res.writeHead(502, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ error: { message: 'Withdraw cancel failed', type: 'escrow_error' } }));
    }
  }

  private async handleWithdrawComplete(res: http.ServerResponse): Promise<void> {
    try {
      const tx = await this.poolManager!.completeWithdraw();
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ object: 'clawmarket.escrow.withdraw_complete', tx }));
    } catch (err) {
      console.error('[ConsumerGateway] Withdraw complete failed:', err);
      res.writeHead(502, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ error: { message: 'Withdraw complete failed', type: 'escrow_error' } }));
    }
  }

  private async handleChatCompletions(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const clientVersion = readClientVersion(req.headers['x-claw-client-version']);
    const clientPolicy = this.clientPolicy.get();
    const policyDecision = isClientVersionAllowed(clientVersion, clientPolicy);
    if (!policyDecision.allowed) {
      console.warn(
        `[client-policy] Rejecting /v1/chat/completions for client ${clientVersion}: ${policyDecision.reason}`,
      );
      res.writeHead(426, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ error: buildClientUpgradeError(clientPolicy, policyDecision.reason) }));
      return;
    }

    // 1. Parse request body
    let body: ChatCompletionRequest;
    let managedCap: string | undefined;
    try {
      body = await parseJsonBody<ChatCompletionRequest>(req);
      validateChatRequest(body);
      body.max_tokens ??= 1024;
      managedCap = (body as ChatCompletionRequest & { max_cost_token?: string }).max_cost_token;
      if (managedCap != null && (typeof managedCap !== 'string' || parsePaymentAmount(managedCap) <= 0n)) throw new Error('Invalid managed request budget');
      // This is a local payment limit, not an upstream model parameter.
      delete (body as ChatCompletionRequest & { max_cost_token?: string }).max_cost_token;
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON body', type: 'invalid_request' } }));
      return;
    }

    const requestId = randomUUID();
    const requestStartedAt = Date.now();
    const isStream = body.stream === true;
    const triedPeerIds = new Set<string>();
    let lastErr: unknown = null;
    let sessionKeyHash: string | null = null;
    let preselectedAlternatives: ScoredProvider[] = [];
    let preselectedQuoteAlternatives: PricedProviderCandidate[] = [];
    let noCandidateErrorKind: 'no_provider' | 'no_candidate_after_filter' = 'no_provider';
    let staleQuoteRejects = 0;
    const logBuilder = this.schedulerLogger.startRequest(requestId, body.model, clientVersion);
    let logFinalized = false;
    const finalizeLog = (
      outcome: 'success' | 'failover' | 'error',
      attempts: number,
      errorKind?: string,
    ) => {
      if (logFinalized) {
        return;
      }
      logFinalized = true;
      logBuilder
        .setAttempts(attempts)
        .setLatency(undefined, Date.now() - requestStartedAt)
        .setOutcome(outcome, errorKind)
        .finalize();
    };

    const estimatedInputTokens = inputTokenBudget(body, this.config.inputOverheadTokens);
    const estimatedOutputTokens = body.max_tokens ?? 1024;

    for (let attempt = 0; attempt < MAX_PROVIDER_ATTEMPTS; attempt++) {
      let provider: ScoredProvider | null = null;
      let selectedQuote: QuoteMessage | null = null;
      if (attempt === 0) {
        const quoteSelection = await this.selectQuoteBackedProvider(
          body.model,
          triedPeerIds,
          body.max_price_per_1m,
        );
        if ('result' in quoteSelection) {
          provider = quoteSelection.result.provider;
          selectedQuote = quoteSelection.result.quote;
          preselectedQuoteAlternatives = [...quoteSelection.result.alternatives];
          logBuilder.setSelected(
            provider.announcement.peerId,
            quoteSelection.result.currentPrice,
            selectedQuote ? 'quote' : 'legacy',
            preselectedQuoteAlternatives.map((candidate) => candidate.provider.announcement.peerId),
          ).setRouteKind(selectedQuote ? 'aimm_quote' : 'scheduler');
        } else {
          this.recordQuoteFallbackMetric(quoteSelection.fallback);
          logBuilder.setQuoteFallback(quoteSelection.fallback);
          console.log('[ConsumerGateway] AIMM quote selection fallback', {
            model: body.model,
            reason: quoteSelection.fallback,
            cacheSize: quoteSelection.cacheSize,
            activeQuoteCount: quoteSelection.activeQuoteCount,
          });
          const selection = await this.scheduler.select({
            model: body.model,
            requestId,
            body,
            userMaxPrice: body.max_price_per_1m,
            excludedPeerIds: triedPeerIds,
            logBuilder,
          });
          provider = selection.provider;
          preselectedAlternatives = [...selection.alternatives];
          sessionKeyHash = selection.sessionKeyHash;
          if (selection.source === 'no_candidate' && selection.rolledOut) {
            noCandidateErrorKind = 'no_candidate_after_filter';
          }
        }
      } else if (preselectedQuoteAlternatives.length > 0) {
        while (preselectedQuoteAlternatives.length > 0) {
          const candidate = preselectedQuoteAlternatives.shift() ?? null;
          if (!candidate) {
            continue;
          }
          if (!(await this.router.isProviderAvailable(body.model, candidate.provider.announcement.peerId))) {
            continue;
          }
          provider = candidate.provider;
          selectedQuote = candidate.quote;
          break;
        }
        if (provider && selectedQuote) {
          logBuilder.setSelected(
            provider.announcement.peerId,
            selectedQuote.currentPrice,
            'quote',
            preselectedQuoteAlternatives.map((candidate) => candidate.provider.announcement.peerId),
          ).setRouteKind('aimm_quote');
        } else if (provider) {
          logBuilder.setSelected(
            provider.announcement.peerId,
            averageProviderPrice(provider),
            'legacy',
            preselectedQuoteAlternatives.map((candidate) => candidate.provider.announcement.peerId),
          ).setRouteKind('scheduler');
        }
      } else if (preselectedAlternatives.length > 0) {
        while (preselectedAlternatives.length > 0) {
          const candidate = preselectedAlternatives.shift() ?? null;
          if (!candidate) {
            continue;
          }
          if (!(await this.router.isProviderAvailable(body.model, candidate.announcement.peerId))) {
            continue;
          }
          provider = candidate;
          break;
        }
        if (provider) {
          logBuilder.setSelected(
            provider.announcement.peerId,
            averageProviderPrice(provider),
            'top_n',
            preselectedAlternatives.map((candidate) => candidate.announcement.peerId),
          );
        }
      } else {
        provider = await this.router.selectBestExcluding(body.model, triedPeerIds);
        if (provider) {
          logBuilder.setSelected(
            provider.announcement.peerId,
            averageProviderPrice(provider),
            'legacy',
            [],
          );
        }
      }

      if (!provider) {
        break;
      }

      const peerId = provider.announcement.peerId;
      const providerAddress = provider.announcement.walletAddress;
      const prices = lockedPrices(provider.modelPricing, selectedQuote?.currentPrice);
      const maximumAmount = tokenCost(estimatedInputTokens, estimatedOutputTokens, prices.inputPrice, prices.outputPrice);
      const authorizationAmountUsd = Number(maximumAmount) / Number(PAYMENT_SCALE);
      if (maximumAmount > paymentBudget(this.config.maxRequestCostToken!) || (managedCap != null && maximumAmount > parsePaymentAmount(managedCap))) {
        finalizeLog('error', attempt + 1, 'budget_exceeded');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Request exceeds configured payment budget', type: 'budget_exceeded' } })); return;
      }

      triedPeerIds.add(peerId);

      let signedAuthorization;
      try {
        await this.poolManager!.ensureSufficientBalance(authorizationAmountUsd);
        const { nonce, nonceMode } = await this.poolManager!.allocateAuthorizationNonce(
          providerAddress,
          requestId,
        );
        signedAuthorization = {
          buyer: this.wallet.getAddress(), seller: providerAddress, amount: maximumAmount, nonce,
          expiresAt: Math.floor(Date.now() / 1000) + this.getAuthorizationTtlSeconds(), poolId: this.getPoolId(), nonceMode,
        };
        if (nonceMode !== 'bitmap') throw new Error('Delivery-confirmed settlement requires a bitmap-capable escrow pool');
      } catch (err) {
        console.error('[ConsumerGateway] Failed to prepare payment intent:', err);
        finalizeLog('error', attempt + 1, 'payment_error');
        res.writeHead(502, { 'Content-Type': 'application/json', ...corsHeaders() });
        res.end(
          JSON.stringify({ error: { message: 'Payment authorization unavailable', type: 'payment_error' } }),
        );
        return;
      }

      const providerPubKey = deserializePublicKey(provider.announcement.publicKey);
      let encryptedPayload: string;
      try {
        encryptedPayload = await encrypt(
          JSON.stringify(body),
          this.e2eeKeyPair.privateKey,
          providerPubKey,
        );
      } catch (err) {
        console.error('[ConsumerGateway] Encryption failed:', err);
        finalizeLog('error', attempt + 1, 'internal_error');
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders() });
        res.end(JSON.stringify({ error: { message: 'Encryption failed', type: 'internal_error' } }));
        return;
      }

      const intent = await this.authorizationSigner!.signInferenceIntent({ ...signedAuthorization,
        requestId, payloadHash: hashInferencePayload(encryptedPayload), ...prices,
        maxInputTokens: estimatedInputTokens, maxOutputTokens: estimatedOutputTokens });
      const inferenceReq: InferenceRequest = {
        type: 'request',
        requestId,
        payload: encryptedPayload,
        buyerPublicKey: serializePublicKey(this.e2eeKeyPair.publicKey),
        buyerAddress: this.wallet.getAddress(),
        model: body.model,
        authorization: intent,
        quote: selectedQuote ?? undefined,
        clientVersion,
        protocolVersion: PROTOCOL_VERSION,
        timestamp: Date.now(),
      };
      this.provenanceBindings.set(inferenceReq, modelProvenanceRequestBinding(body, intent, this.config.chainId));

      let trackingStarted = false;
      const attemptStartedAt = Date.now();

      try {
        this.qualityMonitor.startRequest(peerId, requestId);
        trackingStarted = true;

        let responseMeta: ProviderResponseMeta;
        if (isStream) {
          responseMeta = await this.handleStreamResponse(
            res,
            inferenceReq,
            peerId,
            provider.announcement.multiaddrs,
            providerPubKey,
            requestId,
          );
        } else {
          responseMeta = await this.handleNonStreamResponse(
            res,
            inferenceReq,
            peerId,
            provider.announcement.multiaddrs,
            providerPubKey,
            requestId,
            body.model,
          );
        }

        if (typeof (this.router as any).recordObservedLatency === 'function') {
          this.router.recordObservedLatency(peerId, Date.now() - attemptStartedAt);
        }
        if (responseMeta.providerHint) {
          if (typeof (this.router as any).observeProvider === 'function') {
            this.router.observeProvider(peerId, responseMeta.providerHint);
          }
        }
        this.router.markSuccess(peerId);
        this.recordOutboundMetric('ok');
        this.scheduler.onSuccess(sessionKeyHash, peerId);
        finalizeLog(attempt === 0 ? 'success' : 'failover', attempt + 1);
        return;
      } catch (err) {
        lastErr = err;
        if (err instanceof ModelProvenanceError) {
          this.router.markFailed(peerId);
          this.recordOutboundMetric('rejected');
          this.qualityMonitor.endRequest(requestId, false);
          finalizeLog('error', attempt + 1, 'model_provenance_failed');
          const error = { message: err.message, type: 'model_provenance_failed', code: err.code };
          if (res.headersSent) {
            if (!res.writableEnded) { res.write(`data: ${JSON.stringify({ error })}\n\n`); res.end(); }
          } else { res.writeHead(422, { 'Content-Type': 'application/json', ...corsHeaders() }); res.end(JSON.stringify({ error })); }
          return;
        }
        if (this.settlementAttempts.has(inferenceReq)) {
          // The final receipt may already be collectible even if the ACK was lost.
          // Switching sellers here would authorize payment twice for one user request.
          finalizeLog('error', attempt + 1, 'settlement_uncertain');
          const error = { message: 'Delivery completed but payment acknowledgement is unknown. Do not automatically retry.',
            type: 'settlement_uncertain', requestId, seller: providerAddress };
          if (res.headersSent) {
            if (!res.writableEnded) { res.write(`data: ${JSON.stringify({ error })}\n\n`); res.end(); }
          } else {
            res.writeHead(422, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error }));
          }
          return;
        }
        const failure = classifyProviderFailure(err, body.model);
        if (failure.kind === 'stale_quote' && this.quoteCache && failure.currentQuote) {
          this.quoteCache.insert(failure.currentQuote);
          triedPeerIds.delete(peerId);
          this.qualityMonitor.cancelRequest(requestId);
          staleQuoteRejects++;
          if (staleQuoteRejects <= 5) {
            attempt--;
            continue;
          }
        }
        console.error(
          `[ConsumerGateway] Request ${requestId} attempt ${attempt + 1} with ${peerId} failed:`,
          err,
        );
        if (failure.providerHint) {
          if (typeof (this.router as any).observeProvider === 'function') {
            this.router.observeProvider(peerId, failure.providerHint);
          }
        }
        if (failure.kind === 'model_cooldown' || failure.kind === 'backpressure') {
          this.recordOutboundMetric('rejected');
          this.router.markTemporarilyUnavailable(
            peerId,
            body.model,
            failure.cooldownMs,
            failure.reason,
          );
        } else if (failure.kind === 'transport_unreachable') {
          this.recordOutboundMetric('error');
          if (typeof (this.router as any).markPeerUnreachable === 'function') {
            this.router.markPeerUnreachable(peerId, 90_000, failure.reason ?? 'transport_unreachable');
          } else {
            this.router.markFailed(peerId);
          }
        } else {
          this.recordOutboundMetric(failure.kind === 'timeout' ? 'timeout' : 'error');
          this.router.markFailed(peerId);
        }
        this.scheduler.onFailure(sessionKeyHash, peerId, failure.kind);
        if (trackingStarted) {
          this.qualityMonitor.endRequest(requestId, false);
        }

        if (res.headersSent) {
          finalizeLog('error', attempt + 1, failure.kind);
          throw err;
        }

        console.warn(
          `[ConsumerGateway] attempt ${attempt + 1} to ${peerId} failed, trying next provider`,
        );
      }
    }

    if (triedPeerIds.size === 0) {
      finalizeLog('error', 0, noCandidateErrorKind);
      res.writeHead(503, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(
        JSON.stringify({
          error: { message: `No provider available for model ${body.model}`, type: 'service_unavailable', code: noCandidateErrorKind },
        }),
      );
      return;
    }

    console.error(`[ConsumerGateway] Request ${requestId} exhausted failover attempts:`, lastErr);
    const finalFailure = classifyProviderFailure(lastErr, body.model);
    finalizeLog('error', triedPeerIds.size, finalFailure.kind);
    const statusCode =
      finalFailure.kind === 'model_cooldown' || finalFailure.kind === 'backpressure' ? 503 : 502;
    res.writeHead(statusCode, { 'Content-Type': 'application/json', ...corsHeaders() });
    res.end(
      JSON.stringify({
        error: {
          message: formatExhaustedProviderFailure(lastErr, body.model, triedPeerIds.size, finalFailure.kind),
          type: statusCode === 503 ? 'service_unavailable' : 'upstream_error',
          code: finalFailure.kind,
        },
      }),
    );
  }

  // ---- Stream / non-stream response handling ----

  private async handleStreamResponse(
    res: http.ServerResponse,
    inferenceReq: InferenceRequest,
    peerId: string,
    providerAddresses: string[] | undefined,
    providerPubKey: Uint8Array,
    requestId: string,
  ): Promise<ProviderResponseMeta> {
    let firstToken = true;
    let totalTokens = 0;
    let streamErr: Error | null = null;
    let sawTerminalMessage = false;
    let receivedMessages = 0;
    let providerHint: ProviderRuntimeHint | null = null;
    let upstreamProof: UpstreamProof | null = null;
    let streamOpened = false;
    let emittedChunks = 0;
    const digest = new ModelProvenanceTextDigest();
    let finalUsage: TokenUsage | undefined;

    const ensureStreamOpened = () => {
      if (streamOpened) {
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...corsHeaders(),
      });
      streamOpened = true;
    };

    for await (const msg of this.streamHandler.sendRequest(peerId, inferenceReq, {
      addresses: providerAddresses,
      settle: async message => {
        if (!sawTerminalMessage || streamErr || emittedChunks === 0) throw new Error('Cannot pay for incomplete or empty delivery');
        return this.signSettlement(inferenceReq, message, digest.digest());
      },
    })) {
      receivedMessages += 1;
      if (msg.type === 'stream_chunk' && msg.payload) {
        const decrypted = await decrypt(msg.payload, this.e2eeKeyPair.privateKey, providerPubKey);
        const parsedChunk = parseProviderStreamPayload(decrypted);
        const content = parsedChunk.content;
        if (firstToken) {
          this.qualityMonitor.recordFirstToken(requestId);
          firstToken = false;
        }

        if (!content) {
          continue;
        }
        digest.update(content);

        // Write SSE chunk
        ensureStreamOpened();
        const chunk = {
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        emittedChunks++;
        totalTokens++;
      } else if (msg.type === 'stream_end') {
        sawTerminalMessage = true;
        providerHint = normalizeProviderRuntimeHint((msg as any).providerHint);
        upstreamProof = normalizeUpstreamProof((msg as any).upstreamProof);
        finalUsage = (msg as any).usage;
        if (!streamOpened && emittedChunks === 0) {
          streamErr = new Error('Provider returned an empty response before any tokens were emitted');
          break;
        }
        // Completion is emitted after verification and the settlement acknowledgement.
      } else if (msg.type === 'error') {
        sawTerminalMessage = true;
        const providerError = parseProviderErrorPayload(msg.error ?? '');
        if (providerError?.type === 'stale_quote' && providerError.currentQuote) {
          streamErr = new StaleQuoteError(providerError.message, providerError.currentQuote);
          break;
        }
        if (!streamOpened && emittedChunks === 0) {
          streamErr = new Error(msg.error ?? 'Provider error');
          break;
        }
        ensureStreamOpened();
        const errChunk = {
          error: { message: msg.error ?? 'Provider error', type: 'upstream_error' },
        };
        res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        streamErr = new Error(msg.error ?? 'Provider error');
        break;
      }
    }

    if (!streamErr && !sawTerminalMessage) {
      const reason = receivedMessages === 0
        ? 'Provider stream closed before any protocol messages were received'
        : 'Provider stream closed before a terminal message was received';
      if (streamOpened || emittedChunks > 0) {
        ensureStreamOpened();
        const errChunk = {
          error: { message: reason, type: 'upstream_error' },
        };
        res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
      }
      streamErr = new Error(reason);
    }

    if (!streamErr && this.provenancePolicy.mode === 'required' && this.provenanceResults.get(inferenceReq)?.status !== 'verified') throw new ModelProvenanceError('verification_missing');
    if (streamOpened) {
      if (!streamErr) {
        res.write(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: finalUsage, upstreamProof: upstreamProof ?? undefined,
          tamProvenance: this.provenanceResults.get(inferenceReq) ?? { status: 'unverified', reason: 'disabled' } })}\n\n`);
        this.qualityMonitor.endRequest(requestId, true, finalUsage?.total_tokens ?? totalTokens);
        res.write('data: [DONE]\n\n');
      }
      res.end();
    }

    if (streamErr) {
      throw streamErr;
    }

    return { providerHint, upstreamProof };
  }

  private async handleNonStreamResponse(
    res: http.ServerResponse,
    inferenceReq: InferenceRequest,
    peerId: string,
    providerAddresses: string[] | undefined,
    providerPubKey: Uint8Array,
    requestId: string,
    model: string,
  ): Promise<ProviderResponseMeta> {
    let fullContent = '';
    let usage: TokenUsage | undefined;
    let firstToken = true;
    let sawTerminalMessage = false;
    let receivedMessages = 0;
    let providerHint: ProviderRuntimeHint | null = null;
    let upstreamProof: UpstreamProof | null = null;

    for await (const msg of this.streamHandler.sendRequest(peerId, inferenceReq, {
      addresses: providerAddresses,
      settle: async message => {
        if (!sawTerminalMessage || !fullContent.trim()) throw new Error('Cannot pay for incomplete or empty delivery');
        const digest = new ModelProvenanceTextDigest(); digest.update(fullContent);
        return this.signSettlement(inferenceReq, message, digest.digest());
      },
    })) {
      receivedMessages += 1;
      if (msg.type === 'response' && msg.payload) {
        const decrypted = await decrypt(msg.payload, this.e2eeKeyPair.privateKey, providerPubKey);
        const parsedChunk = parseProviderStreamPayload(decrypted);
        fullContent = parsedChunk.content ?? decrypted;
        usage = (msg as any).usage;
        providerHint = normalizeProviderRuntimeHint((msg as any).providerHint);
        upstreamProof = normalizeUpstreamProof((msg as any).upstreamProof);
        sawTerminalMessage = true;
        if (firstToken) {
          this.qualityMonitor.recordFirstToken(requestId);
          firstToken = false;
        }
      } else if (msg.type === 'stream_chunk' && msg.payload) {
        const decrypted = await decrypt(msg.payload, this.e2eeKeyPair.privateKey, providerPubKey);
        const parsedChunk = parseProviderStreamPayload(decrypted);
        if (parsedChunk.content) {
          fullContent += parsedChunk.content;
        }
        if (parsedChunk.usage) {
          usage = parsedChunk.usage;
        }
        if (firstToken) {
          this.qualityMonitor.recordFirstToken(requestId);
          firstToken = false;
        }
      } else if (msg.type === 'stream_end') {
        sawTerminalMessage = true;
        usage = (msg as any).usage;
        providerHint = normalizeProviderRuntimeHint((msg as any).providerHint);
        upstreamProof = normalizeUpstreamProof((msg as any).upstreamProof);
      } else if (msg.type === 'error') {
        sawTerminalMessage = true;
        const providerError = parseProviderErrorPayload(msg.error ?? '');
        if (providerError?.type === 'stale_quote' && providerError.currentQuote) {
          throw new StaleQuoteError(providerError.message, providerError.currentQuote);
        }
        throw new Error(msg.error ?? 'Provider error');
      }
    }

    if (!sawTerminalMessage) {
      const reason = receivedMessages === 0
        ? 'Provider stream closed before any protocol messages were received'
        : 'Provider stream closed before a terminal message was received';
      throw new Error(reason);
    }
    if (this.provenancePolicy.mode === 'required' && this.provenanceResults.get(inferenceReq)?.status !== 'verified') throw new ModelProvenanceError('verification_missing');

    const tokenCount = usage?.total_tokens ?? estimateTokens(fullContent);
    this.qualityMonitor.endRequest(requestId, true, tokenCount);

    const response: ChatCompletionResponse = {
      id: requestId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: fullContent },
          finish_reason: 'stop',
        },
      ],
      usage: usage ?? {
        prompt_tokens: 0,
        completion_tokens: tokenCount,
        total_tokens: tokenCount,
      },
      upstreamProof: upstreamProof ?? undefined,
      tamProvenance: this.provenanceResults.get(inferenceReq) ?? { status: 'unverified', reason: 'disabled' },
    };

    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    res.end(JSON.stringify({ ...response, tamSettlement: this.settlementAmounts.has(inferenceReq) ? { amountToken: formatPaymentAmount(this.settlementAmounts.get(inferenceReq)!), symbol: PAYMENT_TOKEN.symbol, seller: inferenceReq.authorization.seller, status: 'authorized' } : undefined }));
    return { providerHint, upstreamProof };
  }

  private async signSettlement(request: InferenceRequest, message: ProtocolMessage, responseHash: string) {
    const intent = request.authorization as SignedInferenceIntent;
    const amount = settlementAmount(intent, (message as any).usage);
    const binding = this.provenanceBindings.get(request);
    if (!binding) throw new ModelProvenanceError('binding_missing');
    const result = await verifyModelProvenance((message as any).modelProvenanceProof,
      { ...binding, responseHash, usage: (message as any).usage }, this.provenancePolicy, this.provenanceVerifier);
    this.provenanceResults.set(request, result);
    const { buyer, seller, nonce, expiresAt, poolId, nonceMode } = intent;
    const authorization = await this.authorizationSigner!.signAuthorization({ buyer, seller, amount, nonce, expiresAt, poolId, nonceMode });
    this.settlementAttempts.add(request);
    this.settlementAmounts.set(request, amount);
    return authorization;
  }

  private getEscrowPoolAddress(): `0x${string}` {
    return this.config.escrowPoolAddress;
  }

  private getPoolId(): `0x${string}` {
    return this.config.poolId ?? poolIdFromAddress(this.getEscrowPoolAddress());
  }

  private getAuthorizationTtlSeconds(): number {
    return this.config.authorizationTtlSeconds ?? AUTH_DEFAULT_TTL_SECONDS;
  }

  private async selectQuoteBackedProvider(
    model: string,
    excludedPeerIds: Set<string>,
    userMaxPrice?: number,
  ): Promise<QuoteSelectionResult> {
    if (!this.quoteCache) {
      return {
        fallback: 'no_quote_cache',
        cacheSize: 0,
        activeQuoteCount: 0,
      };
    }

    const cacheSize = this.quoteCache.size();
    const allActiveQuotes = this.quoteCache.active(model);
    if (allActiveQuotes.length === 0) {
      return {
        fallback: 'no_active_quotes',
        cacheSize,
        activeQuoteCount: 0,
      };
    }

    const filterCounts = {
      excluded: 0,
      price_circuit_tripped: 0,
      user_price_limit: 0,
    };
    const activeQuotes = allActiveQuotes.filter((quote) => {
      if (excludedPeerIds.has(quote.makerId)) {
        filterCounts.excluded++;
        return false;
      }
      if (quote.currentPrice > Math.max(quote.p0, 0) * QUOTE_PRICE_CIRCUIT_MULTIPLIER) {
        filterCounts.price_circuit_tripped++;
        return false;
      }
      if (userMaxPrice != null && quote.currentPrice > userMaxPrice) {
        filterCounts.user_price_limit++;
        return false;
      }
      return true;
    });
    if (activeQuotes.length === 0) {
      return {
        fallback: filterCounts.price_circuit_tripped > 0
          ? 'price_circuit_tripped'
          : 'all_candidates_filtered',
        cacheSize,
        activeQuoteCount: allActiveQuotes.length,
      };
    }

    const providers = dedupeProviders(
      await this.router.findProviders(model),
      this.router.getCachedProviders(model),
    );
    const providersByPeerId = new Map(
      providers.map((provider) => [provider.announcement.peerId, provider] as const),
    );

    const activeQuotePeerIds = new Set(allActiveQuotes.map((quote) => quote.makerId));
    const quoteBackedCandidates: PricedProviderCandidate[] = [];
    for (const quote of activeQuotes) {
      const provider = providersByPeerId.get(quote.makerId);
      if (!provider) {
        continue;
      }
      quoteBackedCandidates.push({
        provider,
        quote,
        currentPrice: quote.currentPrice,
      });
    }

    const quotedPeerIds = new Set(
      quoteBackedCandidates.map((candidate) => candidate.provider.announcement.peerId),
    );
    // Keep legacy-priced providers in the first-pass market so sellers with
    // working inference transport but missing AIMM quotes are still reachable.
    const legacyCandidates = providers
      .filter((provider) => !quotedPeerIds.has(provider.announcement.peerId))
      .filter((provider) => !activeQuotePeerIds.has(provider.announcement.peerId))
      .filter((provider) => !excludedPeerIds.has(provider.announcement.peerId))
      .map((provider) => ({
        provider,
        quote: null,
        currentPrice: averageProviderPrice(provider),
      }))
      .filter((candidate) => userMaxPrice == null || candidate.currentPrice <= userMaxPrice);

    const candidates = [...quoteBackedCandidates, ...legacyCandidates]
      .sort((left, right) => left.currentPrice - right.currentPrice);

    if (candidates.length === 0) {
      return {
        fallback: quoteBackedCandidates.length === 0 ? 'no_provider_match' : 'all_candidates_filtered',
        cacheSize,
        activeQuoteCount: allActiveQuotes.length,
      };
    }

    const selected = softmaxSample(candidates, this.softmaxBeta);
    if (!selected) {
      return {
        fallback: 'all_candidates_filtered',
        cacheSize,
        activeQuoteCount: allActiveQuotes.length,
      };
    }

    const alternatives = candidates
      .filter((candidate) => candidate !== selected)
      .sort((left, right) => left.currentPrice - right.currentPrice);

    return {
      result: {
        provider: selected.provider,
        quote: selected.quote,
        currentPrice: selected.currentPrice,
        alternatives,
      },
    };
  }

  private recordOutboundMetric(result: 'ok' | 'rejected' | 'timeout' | 'error'): void {
    this.outboundMetrics[result] += 1;
  }

  private recordQuoteFallbackMetric(reason: QuoteSelectionFallbackReason): void {
    this.quoteFallbackMetrics[reason] += 1;
  }
}

// ---- Utility functions ----

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Claw-Client-Version',
  };
}

function readClientVersion(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return normalizeVersion(raw ?? UNKNOWN_CLIENT_VERSION);
}

function buildClientUpgradeError(
  policy: ClientVersionPolicy,
  reason?: 'below_min' | 'banned',
): {
  type: 'client_upgrade_required';
  message: string;
  minClientVersion: string;
  recommendedVersion: string;
  upgradeUrl: string;
  upgradeCommand: 'tam self-update';
} {
  const targetVersion = policy.recommendedVersion || policy.minClientVersion;
  const defaultMessage = reason === 'banned'
    ? `当前客户端版本已停用，请升级到 v${targetVersion}。`
    : `客户端版本过低，请升级到 v${targetVersion} 及以上。`;

  return {
    type: 'client_upgrade_required',
    message: policy.upgradeMessage ?? defaultMessage,
    minClientVersion: policy.minClientVersion,
    recommendedVersion: policy.recommendedVersion,
    upgradeUrl: policy.upgradeUrl,
    upgradeCommand: 'tam self-update',
  };
}

function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_048_576) { reject(new Error('Request body too large')); req.resume(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Rough token estimate: ~4 characters per token (GPT-family heuristic).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}


interface AmountRequest {
  amount?: number | string;
  amountToken?: number | string;
  amountUsd?: number | string;
}

function parseAmountUsd(body: AmountRequest): number | null {
  const raw = body.amountToken ?? body.amount ?? (PAYMENT_TOKEN.symbol === 'USDC' ? body.amountUsd : undefined);
  const amount = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  try {
    const units = parsePaymentAmount(raw!);
    if (units > BigInt(Number.MAX_SAFE_INTEGER) || parsePaymentAmount(amount) !== units) return null;
  } catch { return null; }
  return amount;
}

function formatMicroUsdc(value: bigint): string { return formatPaymentAmount(value); }

function parseProviderStreamPayload(
  payload: string,
): { content?: string; usage?: TokenUsage } {
  try {
    const parsed = JSON.parse(payload) as {
      choices?: Array<{
        delta?: { content?: unknown; text?: unknown };
        message?: { content?: unknown };
      }>;
      usage?: TokenUsage;
      output_text?: unknown;
    };

    const content = parsed.choices
      ?.map((choice) =>
        extractTextContent(choice.delta?.content)
        ?? extractTextContent(choice.delta?.text)
        ?? extractTextContent(choice.message?.content)
        ?? '',
      )
      .join('')
      || extractTextContent(parsed.output_text)
      || undefined;

    return {
      content: content && content.length > 0 ? content : undefined,
      usage: parsed.usage,
    };
  } catch {
    return { content: payload };
  }
}

function extractTextContent(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.length > 0 ? value : null;
  }
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => extractTextContent(item))
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
      .join('');
    return joined.length > 0 ? joined : null;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  return extractTextContent(record.text)
    ?? extractTextContent(record.content)
    ?? extractTextContent(record.value)
    ?? extractTextContent(record.output_text);
}

function classifyProviderFailure(
  error: unknown,
  model: string,
):
  | { kind: 'generic' | 'timeout' | 'transport_unreachable'; providerHint?: ProviderRuntimeHint; reason?: string }
  | { kind: 'stale_quote'; reason: string; currentQuote?: QuoteMessage; providerHint?: ProviderRuntimeHint }
  | {
      kind: 'backpressure' | 'model_cooldown';
      cooldownMs: number;
      reason: string;
      providerHint?: ProviderRuntimeHint;
    } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof StaleQuoteError) {
    return {
      kind: 'stale_quote',
      reason: error.message,
      currentQuote: error.currentQuote,
    };
  }
  const providerError = parseProviderErrorPayload(message);
  if (providerError?.type === 'stale_quote') {
    return {
      kind: 'stale_quote',
      reason: providerError.message,
      currentQuote: providerError.currentQuote,
      providerHint: providerError.providerHint,
    };
  }
  if (providerError?.type === 'backpressure_soft_reject') {
    return {
      kind: 'backpressure',
      cooldownMs: Math.max(1_000, (providerError.retryAfterSeconds ?? 5) * 1000),
      reason: providerError.message,
      providerHint: providerError.providerHint,
    };
  }
  if (providerError?.type === 'upstream_quota') {
    return {
      kind: 'model_cooldown',
      cooldownMs: Math.max(1_000, (providerError.retryAfterSeconds ?? 300) * 1000),
      reason: providerError.message,
      providerHint: providerError.providerHint,
    };
  }

  const normalized = message.toLowerCase();
  if (
    normalized.includes('auth_unavailable') ||
    normalized.includes('token_invalidated') ||
    normalized.includes('authentication token has been invalidated')
  ) {
    return {
      kind: 'model_cooldown',
      cooldownMs: extractCooldownMs(message, 15 * 60_000),
      reason: extractProviderFailureReason(message, model),
      providerHint: providerError?.providerHint,
    };
  }
  if (
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('aborterror')
  ) {
    return { kind: 'timeout', providerHint: providerError?.providerHint };
  }
  if (isTransportUnreachableError(normalized)) {
    return {
      kind: 'transport_unreachable',
      reason: message,
      providerHint: providerError?.providerHint,
    };
  }
  const isRateLimited =
    providerError?.statusCode === 429 ||
    normalized.includes('http 429') ||
    normalized.includes('usage_limit_reached') ||
    normalized.includes('model_cooldown');

  if (!isRateLimited) {
    return { kind: 'generic', providerHint: providerError?.providerHint };
  }

  const cooldownMs = extractCooldownMs(message);
  return {
    kind: 'model_cooldown',
    cooldownMs,
    reason: extractProviderFailureReason(message, model),
    providerHint: providerError?.providerHint,
  };
}

function isTransportUnreachableError(normalizedMessage: string): boolean {
  return (
    normalizedMessage.includes('remote closed connection during opening') ||
    normalizedMessage.includes('closed before any protocol messages were received') ||
    normalizedMessage.includes('dialprotocol fallback') ||
    normalizedMessage.includes('open stream on direct connection') ||
    normalizedMessage.includes('dial direct address')
  );
}

function parseProviderErrorPayload(message: string): ProviderErrorPayload | null {
  const parsed = tryParseJson(message);
  if (
    !parsed ||
    typeof parsed.type !== 'string' ||
    typeof parsed.message !== 'string'
  ) {
    return null;
  }

  return {
    type: parsed.type,
    message: parsed.message,
    statusCode: typeof parsed.statusCode === 'number' ? parsed.statusCode : undefined,
    retryAfterSeconds:
      typeof parsed.retryAfterSeconds === 'number' ? parsed.retryAfterSeconds : undefined,
    providerHint: normalizeProviderRuntimeHint(parsed.providerHint) ?? undefined,
    currentQuote:
      parsed.currentQuote && typeof parsed.currentQuote === 'object'
        ? parsed.currentQuote as QuoteMessage
        : undefined,
  };
}

function normalizeUpstreamProof(value: unknown): UpstreamProof | null {
  return value && typeof value === 'object' ? value as UpstreamProof : null;
}

function formatProviderRequestFailure(error: unknown, model: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const explicitMessage =
    parseProviderErrorPayload(message)?.message ??
    extractJsonField(message, 'message');

  if (explicitMessage) {
    return `Provider request failed: ${explicitMessage}`;
  }

  return `Provider request failed for model ${model}`;
}

function formatExhaustedProviderFailure(
  error: unknown,
  model: string,
  attemptCount: number,
  kind: string,
): string {
  const suffix = formatProviderRequestFailure(error, model);
  if (kind === 'model_cooldown' || kind === 'backpressure') {
    return `已尝试 ${attemptCount} 个已发现 seller，但 ${model} 当前都不可用。最后错误：${suffix}`;
  }
  return suffix;
}

function extractCooldownMs(message: string, defaultMs: number = 15 * 60_000): number {
  const parsedSeconds =
    extractJsonNumberField(message, 'reset_seconds') ??
    extractJsonNumberField(message, 'resets_in_seconds') ??
    extractCooldownSecondsFromText(message);
  const seconds = parsedSeconds ?? Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return defaultMs;
  }

  return seconds * 1000;
}

function extractProviderFailureReason(message: string, model: string): string {
  const explicitMessage = extractJsonField(message, 'message');
  if (explicitMessage) {
    return explicitMessage;
  }

  const providerPayload = parseProviderErrorPayload(message);
  if (providerPayload?.message) {
    return providerPayload.message;
  }

  if (message.toLowerCase().includes('usage_limit_reached')) {
    return `usage_limit_reached for ${model}`;
  }

  if (message.toLowerCase().includes('model_cooldown')) {
    return `model_cooldown for ${model}`;
  }

  return `provider temporarily unavailable for ${model}`;
}

function extractJsonField(input: string, field: 'message'): string | null {
  let candidate = input.trim();

  for (let index = 0; index < 4; index++) {
    const parsed = tryParseJson(candidate);
    if (!parsed || typeof parsed !== 'object') {
      break;
    }

    if (typeof parsed[field] === 'string' && parsed[field].trim()) {
      candidate = parsed[field];
      continue;
    }

    if (parsed.error && typeof parsed.error === 'object' && typeof parsed.error[field] === 'string') {
      return parsed.error[field];
    }
  }

  return null;
}

function tryParseJson(input: string): Record<string, any> | null {
  try {
    return JSON.parse(input) as Record<string, any>;
  } catch {
    const start = input.indexOf('{');
    const end = input.lastIndexOf('}');
    if (start === -1 || end <= start) {
      return null;
    }

    try {
      return JSON.parse(input.slice(start, end + 1)) as Record<string, any>;
    } catch {
      return null;
    }
  }
}

function normalizeProviderRuntimeHint(value: unknown): ProviderRuntimeHint | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const next: ProviderRuntimeHint = {};

  if (typeof candidate.loadHint === 'number' && Number.isFinite(candidate.loadHint)) {
    next.loadHint = Math.min(1, Math.max(0, candidate.loadHint));
  }
  if (typeof candidate.inflight === 'number' && Number.isFinite(candidate.inflight)) {
    next.inflight = Math.max(0, Math.round(candidate.inflight));
  }
  if (typeof candidate.queueDepth === 'number' && Number.isFinite(candidate.queueDepth)) {
    next.queueDepth = Math.max(0, Math.round(candidate.queueDepth));
  }
  if (
    typeof candidate.retryAfterSeconds === 'number' &&
    Number.isFinite(candidate.retryAfterSeconds) &&
    candidate.retryAfterSeconds > 0
  ) {
    next.retryAfterSeconds = Math.round(candidate.retryAfterSeconds);
  }
  if (
    typeof candidate.observedLatencyMs === 'number' &&
    Number.isFinite(candidate.observedLatencyMs) &&
    candidate.observedLatencyMs > 0
  ) {
    next.observedLatencyMs = candidate.observedLatencyMs;
  }

  return Object.keys(next).length > 0 ? next : null;
}

function extractJsonNumberField(input: string, field: 'reset_seconds' | 'resets_in_seconds'): number | null {
  let candidate = input.trim();

  for (let index = 0; index < 4; index++) {
    const parsed = tryParseJson(candidate);
    if (!parsed || typeof parsed !== 'object') {
      break;
    }

    if (typeof parsed[field] === 'number') {
      return parsed[field];
    }

    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      candidate = parsed.message;
      continue;
    }

    if (parsed.error && typeof parsed.error === 'object') {
      if (typeof parsed.error[field] === 'number') {
        return parsed.error[field];
      }
      if (typeof parsed.error.message === 'string' && parsed.error.message.trim()) {
        candidate = parsed.error.message;
        continue;
      }
    }
  }

  return null;
}

function extractCooldownSecondsFromText(message: string): number | null {
  const match = message.match(/(?:reset_seconds|resets_in_seconds)[^0-9]*(\d+)/i);
  if (!match) {
    return null;
  }

  const seconds = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(seconds) ? seconds : null;
}

function serializeScoredProvider(provider: ScoredProvider): NetworkProviderStatus {
  return {
    peerId: provider.announcement.peerId,
    walletAddress: provider.announcement.walletAddress,
    region: provider.announcement.region,
    score: provider.score,
    model: provider.modelPricing.model,
    inputPer1m: provider.modelPricing.inputPer1m,
    outputPer1m: provider.modelPricing.outputPer1m,
    p0: provider.modelPricing.p0,
    alpha: provider.modelPricing.alpha,
    maxConcurrent: provider.announcement.maxConcurrent,
    reputation: provider.announcement.reputation,
    updatedAt: provider.announcement.timestamp,
    multiaddrs: provider.announcement.multiaddrs ?? [],
  };
}

function averageProviderPrice(provider: ScoredProvider): number {
  return (provider.modelPricing.inputPer1m + provider.modelPricing.outputPer1m) / 2;
}

function dedupeProviders(...lists: ScoredProvider[][]): ScoredProvider[] {
  const byPeer = new Map<string, ScoredProvider>();
  for (const list of lists) {
    for (const provider of list) {
      const existing = byPeer.get(provider.announcement.peerId);
      if (!existing || provider.score > existing.score) {
        byPeer.set(provider.announcement.peerId, provider);
      }
    }
  }
  return Array.from(byPeer.values());
}

class StaleQuoteError extends Error {
  constructor(
    message: string,
    readonly currentQuote: QuoteMessage,
  ) {
    super(message);
    this.name = 'StaleQuoteError';
  }
}

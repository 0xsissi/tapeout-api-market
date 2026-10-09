import { PAYMENT_TOKEN, PAYMENT_SCALE, paymentBudget, requirePaymentLimit, assertPaymentDeployment, formatPaymentAmount } from '@clawmarket/shared';
/**
 * ProviderGateway — Main sidecar that bridges P2P network to an OpenAI-compatible backend
 *
 * Flow:
 *   P2P Stream (encrypted)
 *     -> ProviderGateway decrypts + verifies payment proof
 *     -> HTTP POST {backend}/v1/chat/completions
 *     -> upstream backend handles auth / routing / inference
 *     -> SSE streaming response
 *     -> ProviderGateway encrypts + sends back via P2P Stream
 *
 * The backend can be a local reverse proxy, a hosted OpenAI-compatible API,
 * or any other service that exposes /v1/chat/completions.
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { ethers } from 'ethers';

import {
  decrypt,
  encrypt,
  generateKeyPair,
  getPublicKey,
  bytesToHex,
  hexToBytes,
  deserializePublicKey,
  hashInferencePayload,
  modelProvenanceRequestBinding, ModelProvenanceTextDigest, assertModelProvenanceBinding,
} from '@clawmarket/crypto';
import { encodeMessage, decodeMessage } from '@clawmarket/p2p-node';
import {
  ClientPolicyManager,
  validateChatRequest, inputTokenBudget, lockedPrices, tokenCost, settlementAmount, verifyQuote,
  PROTOCOL_ID,
  SUBSCRIPTION_PRESETS,
  isQuoteExpired,
  type ClientVersionPolicy,
  type SubscriptionTier,
  UNKNOWN_CLIENT_VERSION,
  isClientVersionAllowed,
  normalizeVersion,
} from '@clawmarket/shared';
import type {
  ProviderConfig,
  InferenceRequest,
  ProtocolMessage,
  ProviderErrorPayload,
  QuoteMessage,
  RejectWithQuote,
  ProviderRuntimeHint,
  StreamChunkMessage,
  StreamEndMessage,
  TokenUsage,
  ModelPricing,
  SignedAuthorization,
  SignedInferenceIntent,
  AuthorizationMessage,
  ChatCompletionRequest,
  ProviderInferenceBackend,
  ModelProvenanceRequestBinding,
} from '@clawmarket/shared';

import { BillingManager } from './billing.js';
import { ProtectionManager } from './protection.js';
import { ClaimBatcher } from './claim-batcher.js';
import { MiningReporter } from './mining-reporter.js';
import { UtilizationTracker } from './utilization.js';
import { QuoteBroadcaster } from './quote-broadcaster.js';
import { CliproxyUsageClient } from './cliproxy-usage-client.js';
import { QuotaWindowTracker, type AccountQuota } from './quota-window-tracker.js';
import { parseClaudeHeaders } from './upstream/ratelimit-header-parser.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { CoolingManager } from './cooling-manager.js';
import { approvedBuyer } from './trusted-buyers.js';

/** Parsed proxy URL parts */
interface ProxyTarget {
  hostname: string;
  port: number;
  protocol: 'http:' | 'https:';
  basePath: string;
}

/**
 * Minimal libp2p stream interface.
 * The actual libp2p types are heavy; we define just what we use
 * so the gateway can be tested and compiled without pulling in all of libp2p.
 */
export interface P2PStream {
  source?: AsyncIterable<Uint8Array>;
  sink?: (source: AsyncIterable<Uint8Array>) => Promise<void>;
  send?: (data: Uint8Array) => boolean;
  onDrain?: () => Promise<void>;
  status?: string;
  writeStatus?: string;
  readStatus?: string;
  remoteWriteStatus?: string;
  remoteReadStatus?: string;
  timeline?: Record<string, unknown>;
  writableNeedsDrain?: boolean;
  writeBufferLength?: number;
  readBufferLength?: number;
  inactivityTimeout?: number;
  maxReadBufferLength?: number;
  maxWriteBufferLength?: number;
  addEventListener?: (type: string, listener: (event?: unknown) => void, options?: unknown) => void;
  close: () => Promise<void> | void;
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
}

/** Minimal libp2p node interface */
export interface P2PNode {
  start(): Promise<void>;
  stop(): Promise<void>;
  publish?(topic: string, message: Uint8Array): Promise<void>;
  peerId: { toString(): string };
  handle(
    protocol: string,
    handler: (data: { stream: P2PStream; connection: unknown }) => void,
    options?: { runOnLimitedConnection?: boolean },
  ): void;
  getMultiaddrs(): Array<{ toString(): string }>;
  contentRouting: {
    provide(key: Uint8Array): Promise<void>;
  };
}

const STREAM_DEBUG = process.env.CLAWMARKET_STREAM_DEBUG === '1' || process.env.CLAWMARKET_STREAM_DEBUG === 'true';
const SOFT_REJECT_LOAD_THRESHOLD = 0.9;
const SEEN_REQUEST_TTL_MS = 60_000;
const CIRCUIT_BREAKER_REASON = 'circuit_breaker';
const UPSTREAM_QUOTA_REASON = 'upstream_quota';

export interface ProviderGatewayOptions {
  /** Optional verified transport. The legacy HTTP proxy is used when absent. */
  inferenceBackend?: ProviderInferenceBackend;
}

/**
 * ProviderGateway — the core seller-side sidecar.
 *
 * Manages the lifecycle of a provider node:
 * - P2P networking (protocol handler, DHT announcement)
 * - Payment verification and billing
 * - Request forwarding to the configured OpenAI-compatible backend
 * - Response encryption and streaming back to buyer
 * - Batched EscrowPool claims
 */
export class ProviderGateway {
  private readonly config: ProviderConfig;
  private readonly proxyTarget: ProxyTarget;
  private readonly keyPair: ReturnType<typeof generateKeyPair>;
  private readonly providerAddress: `0x${string}`;

  readonly billing: BillingManager;
  readonly protection: ProtectionManager;
  readonly claimBatcher: ClaimBatcher;
  readonly miningReporter: MiningReporter | null;
  readonly utilization: UtilizationTracker;
  quoteBroadcaster: QuoteBroadcaster | null;
  quotaWindowTracker: QuotaWindowTracker | null;

  private p2pNode: P2PNode | null = null;
  private readonly clientPolicy: ClientPolicyManager;
  private readonly circuitBreaker = new CircuitBreaker();
  private readonly coolingManager: CoolingManager | null;
  private circuitBreakerTimer: NodeJS.Timeout | null = null;
  private readonly seenRequestIds = new Map<string, number>();
  private readonly inboundMetrics = {
    ok: 0,
    reject: 0,
    error: 0,
  };
  private _running = false;

  /**
   * @param config - Provider configuration from shared types
   * @param p2pNodeFactory - Optional factory to create a libp2p node (for dependency injection / testing)
   */
  constructor(
    config: ProviderConfig,
    private readonly p2pNodeFactory?: () => Promise<P2PNode>,
    private readonly options: ProviderGatewayOptions = {},
  ) {
    this.config = config;
    if (PAYMENT_TOKEN.symbol === 'BEM' && (config.aimmAccountTiers?.length || config.aimmCliproxyManagementUrl)) throw new Error('USD upstream quota tracking requires an exchange-rate adapter before BEM use');
    config.maxRequestCostToken = requirePaymentLimit(config.maxRequestCostToken, config.maxRequestCostUsd, 'maxRequestCostToken');
    config.maxUnconfirmedCreditToken = requirePaymentLimit(config.maxUnconfirmedCreditToken, config.maxUnconfirmedCreditUsd, 'maxUnconfirmedCreditToken');
    if (PAYMENT_TOKEN.symbol === 'BEM' && (!config.dailyLimitToken || config.dailyLimitToken <= 0)) throw new Error('dailyLimitToken is required in BEM units');
    if (PAYMENT_TOKEN.symbol === 'BEM') {
      paymentBudget(config.dailyLimitToken!);
      if (config.models.some(model => model.dailyQuotaUsd != null || model.availableQuotaUsd != null)) throw new Error('USD quota fields require an exchange-rate adapter before BEM use');
    }

    // Parse proxy URL
    const url = new URL(config.proxyUrl);
    this.proxyTarget = {
      hostname: url.hostname,
      port: parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80),
      protocol: url.protocol as 'http:' | 'https:',
      basePath: normalizeProxyBasePath(url.pathname),
    };

    // Reuse a persisted E2EE identity when provided so announcements stay stable across restarts.
    this.keyPair = config.e2eePrivateKey
      ? createKeyPairFromPrivateKey(config.e2eePrivateKey)
      : generateKeyPair();
    this.providerAddress = new ethers.Wallet(config.privateKey).address as `0x${string}`;

    // Initialize sub-modules
    this.billing = new BillingManager(config.escrowPoolAddress, config.rpcUrl, config.chainId, 60_000, this.providerAddress);

    this.protection = new ProtectionManager({
      maxConcurrent: config.maxConcurrent ?? 5,
      dailyLimitUsd: config.dailyLimitToken ?? config.dailyLimitUsd,
    });
    this.utilization = new UtilizationTracker(this.protection.maxConcurrent);
    this.quoteBroadcaster = null;
    this.quotaWindowTracker = buildQuotaWindowTracker(config);
    this.coolingManager = config.aimmAccountTiers?.length ? new CoolingManager() : null;

    this.claimBatcher = new ClaimBatcher(
      config.privateKey,
      config.escrowPoolAddress,
      config.rpcUrl,
      this.billing,
      config.claimBatchMaxSize,
      config.claimFlushIntervalMs,
      config.claimFlushMinAmountBaseUnits ?? config.claimFlushMinAmountMicroUsdc,
      config.claimExpirySafetyMs,
    );

    // Mining reporter is only created if the MINING contract is deployed (non-zero)
    const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
    // Import CONTRACTS dynamically would add complexity; check config or use a known constant
    this.miningReporter = null; // Will be initialized in start() if mining contract is available
    this.clientPolicy = new ClientPolicyManager();
  }

  /** Apply a bounded runtime price rule to subsequent announcements and quotes. */
  updateModelPricing(model: string, p0: number, alpha: number, maximum: number): void {
    const pricing = this.config.models.find(item => item.model === model);
    if (!pricing) throw new Error('Model not offered');
    if (![p0, alpha, maximum].every(Number.isFinite) || p0 <= 0 || maximum < p0 || alpha < 0 || alpha > 5) throw new Error('Invalid pricing');
    const prices = lockedPrices(pricing, p0);
    Object.assign(pricing, { inputPer1m: Number(formatPaymentAmount(prices.inputPrice)), outputPer1m: Number(formatPaymentAmount(prices.outputPrice)), p0, alpha, quotePriceCeiling: maximum });
    this.quoteBroadcaster?.requestBroadcast();
  }

  /** Public key for E2EE, serialized as hex string */
  get publicKey(): string {
    return bytesToHex(this.keyPair.publicKey);
  }

  get metricsSnapshot(): {
    requestsInboundTotal: { ok: number; reject: number; error: number };
    quotesBroadcastTotal: number;
    utilizationConcurrent: number;
    utilizationWindow: number;
    coolingAccounts: number;
    circuitOpenAccounts: number;
  } {
    return {
      requestsInboundTotal: { ...this.inboundMetrics },
      quotesBroadcastTotal: this.quoteBroadcaster?.totalBroadcasts ?? 0,
      utilizationConcurrent: this.utilization.current,
      utilizationWindow: this.basePricingUtilization(),
      coolingAccounts: this.coolingManager?.activeCount() ?? (this.protection.forcedOfflineReason === UPSTREAM_QUOTA_REASON ? 1 : 0),
      circuitOpenAccounts: this.circuitBreaker.isOpen ? 1 : 0,
    };
  }

  /**
   * Start the provider gateway:
   * 1. Initialize P2P node
   * 2. Register protocol handler
   * 3. Announce to DHT
   * 4. Start claim flusher
   */
  async start(): Promise<void> {
    if (this._running) return;

    await assertPaymentDeployment(this.config.escrowPoolAddress, this.config.rpcUrl, this.config.chainId);
    console.log('[Gateway] Starting provider gateway...');
    this.clientPolicy.startWatching();

    // 1. Create and start P2P node
    if (this.p2pNodeFactory) {
      this.p2pNode = await this.p2pNodeFactory();
    } else {
      // Default: create a basic libp2p node
      // In production this would use createLibp2p() with appropriate transports
      throw new Error(
        'No p2pNodeFactory provided. Pass a factory function to create a libp2p node.'
      );
    }

    await this.p2pNode.start();
    console.log(`[Gateway] P2P node started: ${this.p2pNode.peerId.toString()}`);

    if (this.quotaWindowTracker) {
      await this.quotaWindowTracker.start(this.config.aimmQuotaPollIntervalMs ?? 10_000);
    }

    const publish = this.p2pNode.publish;
    if (typeof publish === 'function') {
      this.quoteBroadcaster = new QuoteBroadcaster({ publish: publish.bind(this.p2pNode) }, {
        makerId: this.p2pNode.peerId.toString(),
        makerAddress: this.providerAddress,
        privateKey: this.config.privateKey,
        signingPrivateKey: this.config.signingPrivateKey,
        signingDelegation: this.config.signingDelegation,
        models: this.config.models,
        maxConcurrent: this.protection.maxConcurrent,
        networkId: this.config.aimmQuoteNetworkId,
        getUtilization: () => this.currentPricingUtilization(),
      });
      this.utilization.on('u-jump', () => {
        this.quoteBroadcaster?.requestBroadcast();
      });
      this.quoteBroadcaster.start();
    }

    this.circuitBreakerTimer = setInterval(() => {
      this.tickCircuitBreaker();
    }, 5_000);

    // 2. Register protocol handler
    this.p2pNode.handle(
      PROTOCOL_ID,
      ({ stream }) => {
        return this._handleStream(stream).catch((err) => {
          console.error('[Gateway] Stream handler error:', err);
          try { stream.close(); } catch { /* ignore */ }
        });
      },
      { runOnLimitedConnection: true },
    );

    // 3. Announce to DHT
    await this._announceToNetwork();

    this.claimBatcher.start();

    this._running = true;
    console.log('[Gateway] Provider gateway is running');
    console.log(`[Gateway] Forwarding to local proxy: ${this.config.proxyUrl}`);
  }

  /**
   * Graceful shutdown.
   */
  async stop(): Promise<void> {
    // Startup can fail after the ledger, P2P node or quota watcher was opened.
    console.log('[Gateway] Shutting down...');
    this._running = false;

    await this.claimBatcher.stop();
    this.billing.close();
    this.quoteBroadcaster?.stop();
    this.quotaWindowTracker?.stop();
    if (this.circuitBreakerTimer) {
      clearInterval(this.circuitBreakerTimer);
      this.circuitBreakerTimer = null;
    }
    this.utilization.removeAllListeners('u-jump');
    this.protection.destroy();
    this.clientPolicy.stopWatching();

    if (this.p2pNode) {
      await this.p2pNode.stop();
      this.p2pNode = null;
    }

    console.log('[Gateway] Shutdown complete');
  }

  /**
   * Handle an incoming P2P stream: read the full request message,
   * then process it as an inference request.
   */
  private async _handleStream(stream: P2PStream): Promise<void> {
    try {
      attachStreamDebugListeners(stream, '[Gateway stream]');
      let buffer = new Uint8Array(0);
      let firstMsg: InferenceRequest | null = null;
      const readable = getReadableStream(stream);
      const iterator = readable[Symbol.asyncIterator]();
      const requestDeadline = Date.now() + 10_000;

      while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const { value, done } = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Initial request timed out')), Math.max(1, requestDeadline - Date.now()));
          }),
        ]).finally(() => { if (timer) clearTimeout(timer); });
        if (done) {
          break;
        }

        const chunk = value;
        const bytes = toUint8Array(chunk);
        if (buffer.length + bytes.length > 2_097_156) throw new Error('Request frame exceeds size limit');
        const combined = new Uint8Array(buffer.length + bytes.length);
        combined.set(buffer);
        combined.set(bytes, buffer.length);
        buffer = combined;

        let decoded = decodeMessage(buffer);
        while (decoded) {
          buffer = buffer.slice(decoded.bytesRead);
          if (decoded.message.type === 'request') {
            firstMsg = decoded.message as InferenceRequest;
            break;
          }
          decoded = decodeMessage(buffer);
        }

        if (firstMsg) {
          break;
        }
      }

      if (!firstMsg) {
        console.warn('[Gateway] Incoming P2P stream ended before a request message was decoded');
        await this._sendError(stream, 'empty_request', 'No message received', '');
        return;
      }

      const readConfirmation = async (): Promise<ProtocolMessage> => {
        while (true) {
          const decoded = decodeMessage(buffer);
          if (decoded) { buffer = buffer.slice(decoded.bytesRead); return decoded.message; }
          const next = await iterator.next();
          if (next.done) throw new Error('Buyer disconnected without delivery confirmation');
          const bytes = toUint8Array(next.value);
          if (buffer.length + bytes.length > 2_097_156) throw new Error('Confirmation frame exceeds size limit');
          const joined = new Uint8Array(buffer.length + bytes.length);
          joined.set(buffer); joined.set(bytes, buffer.length); buffer = joined;
        }
      };
      await this.handleInferenceRequest(stream, firstMsg, readConfirmation);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Gateway] Stream processing error: ${message} | ${describeStreamState(stream)}`);
      try {
        await finishStreamWrites(stream);
        await closeStreamWithLog(stream, '[Gateway] _handleStream catch close');
      } catch { /* ignore */ }
    } finally {
      await finishStreamWrites(stream).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[Gateway] Failed to finish P2P stream writer: ${message}`);
      });
      await closeStreamWithLog(stream, '[Gateway] completed stream').catch(() => {});
    }
  }

  /**
   * Core inference request handler.
   *
   * 1. Verify payment proof
   * 2. Decrypt payload (chat completion request)
   * 3. Forward to local proxy as HTTP POST (streaming SSE)
   * 4. Encrypt response chunks and stream back via P2P
   * 5. Track usage for billing
   */
  async handleInferenceRequest(
    stream: P2PStream,
    request: InferenceRequest,
    readConfirmation?: () => Promise<ProtocolMessage>,
  ): Promise<void> {
    const { requestId, buyerAddress, authorization, model } = request;
    const intent = authorization as SignedInferenceIntent;
    const trustedBuyers = this.config.trustedBuyerAddresses ?? (process.env.CLAWMARKET_TRUSTED_BUYERS ?? '').split(',').filter(Boolean);
    if (!trustedBuyers.some(address => address.toLowerCase() === buyerAddress?.toLowerCase()) && !approvedBuyer(buyerAddress, process.env.CLAWMARKET_TRUSTED_BUYERS_FILE, { sellerAddress: this.providerAddress, currency: PAYMENT_TOKEN.symbol, chainId: this.config.chainId, poolAddress: this.config.escrowPoolAddress })) {
      await this._sendError(stream, 'buyer_not_trusted', 'Delivery-confirmed settlement requires a vetted buyer', requestId);
      return;
    }
    if (!readConfirmation || intent.requestId !== requestId || !request.payload || intent.payloadHash !== hashInferencePayload(request.payload)) {
      await this._sendError(stream, 'payment_intent_required', 'A payload-bound delivery-confirmed intent is required', requestId);
      return;
    }
    const clientVersion = normalizeVersion(request.clientVersion ?? UNKNOWN_CLIENT_VERSION);
    console.log(`[Gateway] Request ${requestId} started from ${buyerAddress} for ${model}`);

    const policy = this.clientPolicy.get();
    const policyDecision = isClientVersionAllowed(clientVersion, policy);
    if (!policyDecision.allowed) {
      const payload = buildClientUpgradePayload(policy, policyDecision.reason);
      this.recordInboundMetric('reject');
      await this._sendError(
        stream,
        'client_upgrade_required',
        JSON.stringify(payload),
        requestId,
      );
      return;
    }

    // --- Protection check ---
    const staleDueToOverload = this.buildStaleQuoteReject(request.model, request.quote, 'provider overloaded');
    if (this.protection.shouldSoftReject(SOFT_REJECT_LOAD_THRESHOLD)) {
      if (staleDueToOverload) {
        this.recordInboundMetric('reject');
        await this._sendError(
          stream,
          'stale_quote',
          staleDueToOverload.reason,
          requestId,
          {
            statusCode: 409,
            retryAfterSeconds: Math.max(1, this.estimateRetryAfterSeconds()),
            providerHint: this.buildProviderHint(),
            currentQuote: staleDueToOverload.currentQuote,
          },
        );
        return;
      }
      const retryAfter = Math.max(1, this.estimateRetryAfterSeconds());
      this.recordInboundMetric('reject');
      await this._sendError(
        stream,
        'backpressure_soft_reject',
        `Provider overloaded, retry after ${retryAfter}s`,
        requestId,
        {
          statusCode: 429,
          retryAfterSeconds: retryAfter,
          providerHint: this.buildProviderHint(),
        },
      );
      return;
    }

    if (!this.protection.isAvailable()) {
      const retryAfter = this.protection.offlineRemainingSeconds;
      this.recordInboundMetric('reject');
      await this._sendError(
        stream,
        'provider_unavailable',
        `Provider temporarily unavailable${retryAfter > 0 ? `, retry after ${retryAfter}s` : ''}`,
        requestId,
        {
          statusCode: retryAfter > 0 ? 503 : undefined,
          retryAfterSeconds: retryAfter > 0 ? retryAfter : undefined,
          providerHint: this.buildProviderHint(),
        },
      );
      return;
    }

    try {
      await this.protection.acquire();
    } catch (err: unknown) {
      const staleDueToConcurrency = this.buildStaleQuoteReject(request.model, request.quote, 'concurrency limit reached');
      if (staleDueToConcurrency) {
        this.recordInboundMetric('reject');
        await this._sendError(stream, 'stale_quote', staleDueToConcurrency.reason, requestId, {
          statusCode: 409,
          retryAfterSeconds: this.estimateRetryAfterSeconds(),
          providerHint: this.buildProviderHint(),
          currentQuote: staleDueToConcurrency.currentQuote,
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.recordInboundMetric('reject');
      await this._sendError(stream, 'concurrency_limit', message, requestId, {
        statusCode: 429,
        retryAfterSeconds: this.estimateRetryAfterSeconds(),
        providerHint: this.buildProviderHint(),
      });
      return;
    }

    this.utilization.onRequestStart();
    let stopKeepalive: (() => Promise<void>) | undefined;
    let dailyBudget = 0;
    let forwarded = false;
    let actualSpend: number | undefined;
    try {
      if (this.isDuplicateRequest(requestId)) {
        this.recordInboundMetric('reject');
        await this._sendError(
          stream,
          'duplicate_request',
          'Duplicate request replay rejected',
          requestId,
          {
            statusCode: 409,
            retryAfterSeconds: 1,
            providerHint: this.buildProviderHint(),
          },
        );
        return;
      }

      const startMsg: ProtocolMessage = {
        type: 'stream_start',
        requestId,
        timestamp: Date.now(),
      };
      await writeStreamBytes(stream, encodeMessage(startMsg), `request ${requestId} stream_start`);
      stopKeepalive = startStreamKeepalive(stream, requestId);

      const staleQuote = this.validateQuoteFreshness(request.model, request.quote);
      if (staleQuote) {
        this.recordInboundMetric('reject');
        await this._sendError(
          stream,
          'stale_quote',
          staleQuote.reason,
          requestId,
          {
            statusCode: 409,
            retryAfterSeconds: 1,
            providerHint: this.buildProviderHint(),
            currentQuote: staleQuote.currentQuote,
          },
        );
        return;
      }

      // 2. Decrypt payload
      if (!request.payload) {
        this.recordInboundMetric('error');
        await this._sendError(stream, 'missing_payload', 'Encrypted payload is required', requestId, {
          providerHint: this.buildProviderHint(),
        });
        return;
      }

      const buyerPubKeyBytes = deserializePublicKey(request.buyerPublicKey);
      const decryptedPayload = await decrypt(
        request.payload,
        this.keyPair.secretKey,
        buyerPubKeyBytes
      );
      const chatRequest: ChatCompletionRequest = JSON.parse(decryptedPayload);

      validateChatRequest(chatRequest);
      if (chatRequest.model !== model || !Number.isSafeInteger(intent.maxInputTokens) || intent.maxInputTokens !== inputTokenBudget(chatRequest) ||
          intent.maxOutputTokens !== (chatRequest.max_tokens ?? 1024)) throw new Error('Intent token budget or model mismatch');
      const pricing = this._findPricing(model);
      if (!pricing) throw new Error('Unsupported model');
      if (request.quote && (request.quote.model !== model || !verifyQuote(request.quote, this.providerAddress) || isQuoteExpired(request.quote))) throw new Error('Invalid provider quote');
      const prices = lockedPrices(pricing, request.quote?.currentPrice);
      if (intent.inputPrice !== prices.inputPrice || intent.outputPrice !== prices.outputPrice) throw new Error('Intent price does not match provider quote');
      const expectedBudget = tokenCost(intent.maxInputTokens, intent.maxOutputTokens, prices.inputPrice, prices.outputPrice);
      if (intent.amount !== expectedBudget || intent.amount > paymentBudget(this.config.maxRequestCostToken!)) throw new Error('Request exceeds budget or seller credit limit');
      this.protection.reserveDailyBudget(Number(intent.amount) / Number(PAYMENT_SCALE));
      dailyBudget = Number(intent.amount) / Number(PAYMENT_SCALE);
      await this.billing.reserveIntent(intent, buyerAddress, this.providerAddress, paymentBudget(this.config.maxUnconfirmedCreditToken!));
      chatRequest.max_tokens = intent.maxOutputTokens;

      // Ensure streaming is enabled for proxy forwarding.
      chatRequest.stream = true;
      // Override model if needed (use the one from the request)
      if (model) {
        chatRequest.model = model;
      }

      this.rememberRequestId(requestId);

      // 3. Forward to local proxy and stream back.
      debugLog(`[Gateway] Request ${requestId} forwarding to proxy for model ${chatRequest.model}`);
      forwarded = true;
      const usage = this.options.inferenceBackend ? await this.forwardWithInferenceBackend(
        stream, chatRequest, buyerPubKeyBytes, modelProvenanceRequestBinding(chatRequest, intent, this.config.chainId),
      ) : await this._forwardAndStream(
        stream,
        requestId,
        chatRequest,
        buyerPubKeyBytes,
        request.quote,
        stopKeepalive,
      );
      console.log(`[Gateway] Request ${requestId} completed for ${chatRequest.model}`);

      const amount = settlementAmount(intent, usage ?? undefined);
      actualSpend = Number(amount) / Number(PAYMENT_SCALE);
      let confirmationTimer: ReturnType<typeof setTimeout> | undefined;
      const confirmation = await Promise.race([
        readConfirmation(),
        new Promise<never>((_, reject) => { confirmationTimer = setTimeout(() => reject(new Error('Delivery confirmation timed out')), 15_000); }),
      ]).finally(() => { if (confirmationTimer) clearTimeout(confirmationTimer); });
      if (confirmation.type !== 'authorization' || confirmation.requestId !== requestId) throw new Error('Invalid delivery confirmation');
      await this.billing.acceptSettlement(intent, (confirmation as AuthorizationMessage).authorization, amount);
      await writeStreamBytes(stream, encodeMessage({ type: 'settlement_ack', requestId, timestamp: Date.now() }), 'settlement acknowledgement');
      // The receipt is already durable; flushing is an optimization, not a delivery prerequisite.
      await this.claimBatcher.flush().catch(error => console.warn('[Gateway] Deferred claim flush:', error));

      this.protection.recordSuccess();
      this.recordInboundMetric('ok');
    } catch (err: unknown) {
      if (err instanceof UpstreamQuotaError) {
        this.applyUpstreamQuotaCooldown(err);
        this.quoteBroadcaster?.requestBroadcast();
        this.recordInboundMetric('reject');
        await this._sendError(stream, UPSTREAM_QUOTA_REASON, err.message, requestId, {
          statusCode: 503,
          retryAfterSeconds: err.retryAfterSeconds,
          providerHint: {
            ...this.buildProviderHint(),
            retryAfterSeconds: err.retryAfterSeconds,
          },
        });
        return;
      }
      this.protection.recordError();
      this.recordInboundMetric('error');
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Gateway] Request ${requestId} failed: ${message} | ${describeStreamState(stream)}`);
      await this._sendError(stream, 'internal_error', message, requestId, {
        providerHint: this.buildProviderHint(),
      });
    } finally {
      if (dailyBudget > 0) this.protection.finishDailyBudget(dailyBudget, forwarded ? (actualSpend ?? dailyBudget) : 0);
      await stopKeepalive?.().catch((error: unknown) => {
        console.warn(
          `[Gateway] Request ${requestId} failed to stop keepalive in finally: ${formatError(error)}`,
        );
      });
      this.utilization.onRequestEnd();
      this.protection.release();
    }
  }

  private async forwardWithInferenceBackend(stream: P2PStream, chatRequest: ChatCompletionRequest, buyerKey: Uint8Array, binding: ModelProvenanceRequestBinding): Promise<TokenUsage> {
    const digest = new ModelProvenanceTextDigest();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Inference backend timed out')); }, Math.max(1, Math.min(120_000, binding.expiresAt * 1000 - Date.now()))); });
    let iterator: AsyncIterator<import('@clawmarket/shared').ProviderInferenceEvent> | undefined;
    try {
      iterator = this.options.inferenceBackend!.stream({ request: structuredClone(chatRequest), binding: structuredClone(binding), signal: controller.signal })[Symbol.asyncIterator]();
      while (true) {
        const next = await Promise.race([iterator.next(), expired]);
        if (next.done) throw new Error('Inference backend closed without completion and usage');
        const event = next.value;
        if (event.type === 'chunk') {
          if (typeof event.content !== 'string') throw new Error('Invalid inference backend chunk');
          digest.update(event.content);
          const payload = await encrypt(JSON.stringify({ choices: [{ delta: { content: event.content } }] }), this.keyPair.secretKey, buyerKey);
          await writeStreamBytes(stream, encodeMessage({ type: 'stream_chunk', requestId: binding.requestId, payload, timestamp: Date.now() }), 'inference backend chunk');
        } else if (event.type === 'complete') {
          if (!event.usage || ![event.usage.prompt_tokens, event.usage.completion_tokens, event.usage.total_tokens].every(n => Number.isSafeInteger(n) && n >= 0) ||
            event.usage.total_tokens !== event.usage.prompt_tokens + event.usage.completion_tokens) throw new Error('Invalid inference backend usage');
          if (event.modelProvenanceProof != null) assertModelProvenanceBinding(event.modelProvenanceProof, { ...binding, responseHash: digest.digest(), usage: event.usage });
          const end: StreamEndMessage = { type: 'stream_end', requestId: binding.requestId, usage: event.usage,
            modelProvenanceProof: event.modelProvenanceProof, timestamp: Date.now() };
          await writeStreamBytes(stream, encodeMessage(end), 'inference backend completion');
          return event.usage;
        } else throw new Error('Invalid inference backend event');
      }
    } catch {
      // Adapter errors can contain upstream credentials. Keep this boundary opaque.
      throw new Error('Inference backend failed or returned invalid provenance');
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      // Cleanup must not hang on a misbehaving adapter. The abort signal owns its resources.
      void Promise.resolve().then(() => iterator?.return?.()).catch(() => {});
    }
  }

  /**
   * Forward a chat completion request to the local proxy via HTTP,
   * read the SSE streaming response, encrypt each chunk, and send
   * back through the P2P stream.
   */
  private _forwardAndStream(
    p2pStream: P2PStream,
    requestId: string,
    chatRequest: ChatCompletionRequest,
    buyerPubKeyBytes: Uint8Array,
    quoteUsed: QuoteMessage | undefined,
    stopKeepalive?: () => Promise<void>
  ): Promise<TokenUsage | null> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(chatRequest);
      const { hostname, port, protocol, basePath } = this.proxyTarget;
      const mod = protocol === 'https:' ? https : http;

      let usage: TokenUsage | null = null;
      let writeQueue = Promise.resolve();
      let settled = false;
      let keepaliveStopped = false;
      const stopKeepaliveOnce = (): void => {
        if (keepaliveStopped) {
          return;
        }
        keepaliveStopped = true;
        void stopKeepalive?.().catch((error: unknown) => {
          console.warn(
            `[Gateway] Request ${requestId} failed to stop keepalive: ${formatError(error)}`,
          );
        });
      };
      const resolveOnce = (value: TokenUsage | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        stopKeepaliveOnce();
        resolve(value);
      };
      const rejectOnce = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        stopKeepaliveOnce();
        reject(error);
      };
      const enqueueWrite = (bufferPromise: Promise<Uint8Array | null> | Uint8Array | null): void => {
        writeQueue = writeQueue.then(async () => {
          const buffer = bufferPromise instanceof Uint8Array || bufferPromise == null
            ? bufferPromise
            : await bufferPromise;
          if (buffer) {
            await writeStreamBytes(p2pStream, buffer, `request ${requestId} stream_chunk`);
          }
        });
        writeQueue.catch((error: unknown) => {
          rejectOnce(error);
        });
      };

      debugLog(`[Gateway] Request ${requestId} proxy target ${protocol}//${hostname}:${port}${basePath}/v1/chat/completions`);
      const httpReq = mod.request(
        {
          hostname,
          port,
          path: `${basePath}/v1/chat/completions`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            ...(this.config.proxyHeaders ?? {}),
          },
        },
        (httpRes) => {
          console.log(`[Gateway] Request ${requestId} proxy responded with HTTP ${httpRes.statusCode ?? 'unknown'}`);
          if (httpRes.statusCode && httpRes.statusCode >= 400) {
            let body = '';
            httpRes.on('data', (chunk: Buffer) => { body = (body + chunk.toString()).slice(0, 65_536); });
            httpRes.on('end', () => {
              const retryAfterSeconds = parseRetryAfterSeconds(httpRes.headers['retry-after']);
              const quotaAuthIndex = this.resolveQuotaAuthIndex(httpRes.headers);
              if (isUpstreamQuotaResponse(httpRes.statusCode ?? 0, body)) {
                reject(new UpstreamQuotaError(
                  extractUpstreamQuotaReason(body, httpRes.statusCode ?? 0),
                  retryAfterSeconds ?? 300,
                  quotaAuthIndex ?? undefined,
                ));
                return;
              }
              const payload = JSON.stringify({
                type: 'proxy_http_error',
                message: `Proxy returned HTTP ${httpRes.statusCode}: ${body.slice(0, 500)}`,
                statusCode: httpRes.statusCode,
                retryAfterSeconds,
                providerHint: this.buildProviderHint(),
              } satisfies ProviderErrorPayload);
              reject(new Error(payload));
            });
            return;
          }

          const quotaAuthIndex = this.resolveQuotaAuthIndex(httpRes.headers);
          if (quotaAuthIndex && this.quotaWindowTracker) {
            const snapshot = parseClaudeHeaders(toFetchHeaders(httpRes.headers), quotaAuthIndex);
            if (snapshot) {
              this.quotaWindowTracker.ingestHeader(snapshot);
            }
          }

          let sseBuffer = '';
          let sawDone = false;
          const decoder = new StringDecoder('utf8');
          const processLine = (line: string): void => {
            if (!line.startsWith('data:')) return;
            const data = line.slice(5).trim();
            if (data === '[DONE]') { sawDone = true; return; }
            if (!data) return;
            try {
              const event = JSON.parse(data);
              if (event.error) throw new Error('Upstream returned a streaming error');
              if (event.choices?.some((choice: any) => choice.finish_reason != null)) sawDone = true;
              if (event.usage) usage = { prompt_tokens: event.usage.prompt_tokens, completion_tokens: event.usage.completion_tokens, total_tokens: event.usage.total_tokens };
              enqueueWrite(encrypt(data, this.keyPair.secretKey, buyerPubKeyBytes).then(payload => encodeMessage({ type: 'stream_chunk', requestId, payload, timestamp: Date.now() })));
            } catch (error) { rejectOnce(error); }
          };
          httpRes.on('data', (chunk: Buffer) => {
            stopKeepaliveOnce();
            sseBuffer += decoder.write(chunk);
            if (sseBuffer.length > 2_097_152) { httpRes.destroy(new Error('Upstream SSE line exceeds size limit')); return; }
            const lines = sseBuffer.split('\n'); sseBuffer = lines.pop()!;
            for (const line of lines) processLine(line);
          });
          httpRes.on('end', async () => {
            stopKeepaliveOnce();
            sseBuffer += decoder.end();
            if (sseBuffer.trim()) processLine(sseBuffer.trim());
            if (settled) return;
            if (!sawDone || !usage) { rejectOnce(new Error('Upstream ended without complete delivery and usage')); return; }

            // Send stream_end with usage
            const endMsg: StreamEndMessage = {
              type: 'stream_end',
              requestId,
              usage: usage ?? undefined,
              upstreamProof: {
                requestId,
                model: chatRequest.model,
                timestamp: new Date().toISOString(),
                usage: usage ?? undefined,
                pricedAt: quoteUsed?.currentPrice,
                quoteUsed,
              },
              providerHint: this.buildProviderHint(),
              timestamp: Date.now(),
            };
            enqueueWrite(encodeMessage(endMsg));

            writeQueue.then(() => {
              console.log(`[Gateway] Request ${requestId} sent stream_end`);
              resolveOnce(usage);
            }).catch(rejectOnce);
          });

          httpRes.on('error', (err) => {
            console.error(`[Gateway] Request ${requestId} proxy response stream error: ${err.message}`);
            rejectOnce(err);
          });
        }
      );

      httpReq.setTimeout(120_000, () => httpReq.destroy(new Error('Upstream request timed out')));
      httpReq.on('error', (err) => {
        console.error(`[Gateway] Request ${requestId} proxy request error: ${err.message}`);
        rejectOnce(err);
      });

      httpReq.write(payload);
      httpReq.end();
      debugLog(`[Gateway] Request ${requestId} dispatched proxy request`);
    });
  }

  /**
   * Send an error message back through the P2P stream.
   */
  private async _sendError(
    stream: P2PStream,
    errorType: string,
    errorMessage: string,
    requestId: string,
    details?: {
      statusCode?: number;
      retryAfterSeconds?: number;
      providerHint?: ProviderRuntimeHint;
      currentQuote?: QuoteMessage;
    },
  ): Promise<void> {
    console.warn(`[Gateway] Sending ${errorType} for request ${requestId || '<unknown>'}: ${errorMessage}`);
    const errorPayload = JSON.stringify({
      type: errorType,
      message: errorMessage,
      statusCode: details?.statusCode,
      retryAfterSeconds: details?.retryAfterSeconds,
      providerHint: details?.providerHint ?? this.buildProviderHint(),
      currentQuote: details?.currentQuote,
    } satisfies ProviderErrorPayload);
    const msg: ProtocolMessage = {
      type: 'error',
      requestId,
      error: errorPayload,
      providerHint: details?.providerHint ?? this.buildProviderHint(),
      timestamp: Date.now(),
    };

    const encoded = encodeMessage(msg);
    try {
      await writeStreamBytes(stream, encoded, `request ${requestId || '<unknown>'} error:${errorType}`);
    } catch {
      // If we can't even send the error, leave close coordination to the outer handler.
    }

    await finishStreamWrites(stream).catch((error: unknown) => {
      console.warn(
        `[Gateway] request ${requestId || '<unknown>'} finish writes after ${errorType} failed: ${formatError(error)}`,
      );
    });
  }

  /**
   * Provider discovery is handled by ProviderRegistry at process startup.
   * The gateway only owns request handling and billing, so this is now a
   * lightweight marker instead of performing a second DHT announce path.
   */
  private async _announceToNetwork(): Promise<void> {
    if (!this.p2pNode) return;
    console.log('[Gateway] P2P request handler ready; provider discovery is managed by ProviderRegistry');
  }

  /**
   * Find pricing config for a given model name.
   */
  private _findPricing(model: string): ModelPricing | null {
    return this.config.models.find((m) => m.model === model) ?? null;
  }

  private buildProviderHint(observedLatencyMs?: number): ProviderRuntimeHint {
    const hint: ProviderRuntimeHint = {
      loadHint: this.protection.loadHint,
      inflight: this.protection.currentConcurrent,
      queueDepth: this.protection.queueDepth,
    };
    if (observedLatencyMs && Number.isFinite(observedLatencyMs) && observedLatencyMs > 0) {
      hint.observedLatencyMs = observedLatencyMs;
    }
    return hint;
  }

  private estimateRetryAfterSeconds(): number {
    const queueBased = this.protection.queueDepth * 2;
    return Math.max(1, this.protection.offlineRemainingSeconds, queueBased);
  }

  private validateQuoteFreshness(
    model: string,
    quoteInRequest?: QuoteMessage,
  ): RejectWithQuote | null {
    if (!quoteInRequest) {
      return null;
    }

    const quoteExpired = isQuoteExpired(quoteInRequest);
    const currentUtilization = this.currentPricingUtilization();
    const utilizationDrift = Math.abs(currentUtilization - quoteInRequest.utilization);

    if (!quoteExpired && utilizationDrift < 0.15) {
      return null;
    }

    const freshQuote = this.quoteBroadcaster?.previewQuote(model);
    if (!freshQuote) {
      return null;
    }

    return {
      code: 'STALE_QUOTE',
      reason: quoteExpired ? 'quote TTL expired' : `utilization drift ${utilizationDrift.toFixed(2)}`,
      currentQuote: freshQuote,
      retryable: true,
    };
  }

  private buildStaleQuoteReject(
    model: string,
    quoteInRequest: QuoteMessage | undefined,
    reason: string,
  ): RejectWithQuote | null {
    if (!quoteInRequest) {
      return null;
    }

    const currentQuote = this.quoteBroadcaster?.previewQuote(model);
    if (!currentQuote) {
      return null;
    }

    return {
      code: 'STALE_QUOTE',
      reason,
      currentQuote,
      retryable: true,
    };
  }

  private currentPricingUtilization(): number {
    this.updateCoolingProtection();
    if (this.circuitBreaker.isOpen || this.protection.forcedOfflineReason != null) {
      return 0.999;
    }
    return this.basePricingUtilization();
  }

  private resolveQuotaAuthIndex(headers: http.IncomingHttpHeaders): string | null {
    const explicit = headers['x-cliproxy-auth-index'];
    const headerValue = Array.isArray(explicit) ? explicit[0] : explicit;
    if (headerValue?.trim()) {
      return headerValue.trim();
    }

    if (this.config.aimmAccountTiers?.length === 1) {
      return this.config.aimmAccountTiers[0]?.authIndex ?? null;
    }

    return null;
  }

  private isDuplicateRequest(requestId: string, now = Date.now()): boolean {
    this.pruneSeenRequestIds(now);
    const expiresAt = this.seenRequestIds.get(requestId);
    return typeof expiresAt === 'number' && expiresAt > now;
  }

  private rememberRequestId(requestId: string, now = Date.now()): void {
    this.pruneSeenRequestIds(now);
    this.seenRequestIds.set(requestId, now + SEEN_REQUEST_TTL_MS);
  }

  private pruneSeenRequestIds(now = Date.now()): void {
    for (const [requestId, expiresAt] of this.seenRequestIds) {
      if (expiresAt <= now) {
        this.seenRequestIds.delete(requestId);
      }
    }
  }

  private basePricingUtilization(): number {
    return this.quotaWindowTracker?.aggregateUtilization ?? this.utilization.current;
  }

  private tickCircuitBreaker(now = Date.now()): void {
    const next = this.circuitBreaker.tick(this.basePricingUtilization(), now);
    if (next.opened) {
      this.protection.forceOffline(CIRCUIT_BREAKER_REASON);
      this.quoteBroadcaster?.requestBroadcast();
      console.warn('[Gateway] Circuit breaker opened after sustained high utilization');
      return;
    }

    if (next.closed) {
      this.protection.clearForcedOffline(CIRCUIT_BREAKER_REASON);
      this.quoteBroadcaster?.requestBroadcast();
      console.log('[Gateway] Circuit breaker closed after utilization recovered');
    }
  }

  private applyUpstreamQuotaCooldown(error: UpstreamQuotaError): void {
    if (error.authIndex && this.coolingManager && this.quotaWindowTracker) {
      this.coolingManager.tripAccount(error.authIndex, error.retryAfterSeconds, error.message);
      this.quotaWindowTracker.forceUtilization(error.authIndex, 0.999, error.retryAfterSeconds * 1000);
      this.updateCoolingProtection();
      return;
    }

    this.protection.forceOffline(UPSTREAM_QUOTA_REASON, error.retryAfterSeconds * 1000);
  }

  private updateCoolingProtection(now = Date.now()): void {
    const totalAccounts = this.config.aimmAccountTiers?.length ?? 0;
    if (!this.coolingManager || totalAccounts === 0) {
      return;
    }

    const active = this.coolingManager.activeCount(now);
    if (active >= totalAccounts) {
      this.protection.forceOffline(UPSTREAM_QUOTA_REASON, this.coolingManager.minRemainingSeconds(now) * 1000);
      return;
    }

    if (this.protection.forcedOfflineReason === UPSTREAM_QUOTA_REASON) {
      this.protection.clearForcedOffline(UPSTREAM_QUOTA_REASON);
    }
  }

  private recordInboundMetric(result: 'ok' | 'reject' | 'error'): void {
    this.inboundMetrics[result] += 1;
  }
}

function buildQuotaWindowTracker(config: ProviderConfig): QuotaWindowTracker | null {
  if (!config.aimmCliproxyManagementUrl || !config.aimmAccountTiers?.length) {
    return null;
  }

  const quotas: AccountQuota[] = [];
  for (const account of config.aimmAccountTiers) {
    if (!isSubscriptionTier(account.tier)) {
      console.warn(`[Gateway] Skipping unknown AIMM tier for ${account.authIndex}: ${account.tier}`);
      continue;
    }
    const preset = SUBSCRIPTION_PRESETS[account.tier];
    if (!preset || preset.upstream === 'any') {
      console.warn(`[Gateway] Skipping unsupported AIMM tier for ${account.authIndex}: ${account.tier}`);
      continue;
    }
    quotas.push({
      authIndex: account.authIndex,
      upstream: preset.upstream,
      credits: preset.credits,
      windowMs: preset.windowMs,
      weeklyCredits: 'weeklyCredits' in preset ? preset.weeklyCredits : undefined,
      weeklyWindowMs: 'weeklyWindowMs' in preset ? preset.weeklyWindowMs : undefined,
      modelWeights: { ...preset.modelWeights },
      defaultWeight: preset.defaultWeight,
    });
  }

  if (quotas.length === 0) {
    return null;
  }

  return new QuotaWindowTracker(new CliproxyUsageClient(config.aimmCliproxyManagementUrl), quotas);
}

function toFetchHeaders(headers: http.IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(key, item);
      }
      continue;
    }
    if (value != null) {
      result.set(key, String(value));
    }
  }
  return result;
}

class UpstreamQuotaError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
    readonly authIndex?: string,
  ) {
    super(message);
    this.name = 'UpstreamQuotaError';
  }
}

function isUpstreamQuotaResponse(statusCode: number, body: string): boolean {
  if (statusCode === 429) {
    return true;
  }

  const normalized = body.toLowerCase();
  return normalized.includes('usage_limit_reached') ||
    normalized.includes('model_cooldown') ||
    normalized.includes('quota') ||
    normalized.includes('rate limit');
}

function extractUpstreamQuotaReason(body: string, statusCode: number): string {
  try {
    const parsed = JSON.parse(body) as {
      message?: string;
      error?: { message?: string; code?: string; type?: string };
    };
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message;
    }
    if (parsed.error?.message?.trim()) {
      return parsed.error.message;
    }
    if (parsed.error?.code?.trim()) {
      return parsed.error.code;
    }
    if (parsed.error?.type?.trim()) {
      return parsed.error.type;
    }
  } catch {
    // Fall back to a short text preview below.
  }

  const preview = body.trim().slice(0, 200);
  return preview ? `Proxy returned HTTP ${statusCode}: ${preview}` : `Proxy returned HTTP ${statusCode}`;
}

function isSubscriptionTier(value: string): value is SubscriptionTier {
  return Object.prototype.hasOwnProperty.call(SUBSCRIPTION_PRESETS, value);
}

function buildClientUpgradePayload(
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

function parseRetryAfterSeconds(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) {
    return undefined;
  }

  const numeric = Number.parseInt(raw, 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function startStreamKeepalive(stream: P2PStream, requestId: string, intervalMs = 250): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = Promise.resolve();

  const tick = (): void => {
    timer = setTimeout(() => {
      if (stopped) {
        return;
      }

      const heartbeat: ProtocolMessage = {
        type: 'stream_start',
        requestId,
        timestamp: Date.now(),
      };

      inFlight = writeStreamBytes(stream, encodeMessage(heartbeat), `request ${requestId} keepalive`)
        .catch((error: unknown) => {
          if (!stopped) {
            debugWarn(
              `[Gateway] Request ${requestId} keepalive stopped after write failure: ${formatError(error)}`,
            );
          }
          stopped = true;
        })
        .finally(() => {
          if (!stopped) {
            tick();
          }
        });
    }, intervalMs);
  };

  tick();

  return async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (timer != null) {
      clearTimeout(timer);
    }
    await inFlight.catch(() => {});
  };
}

async function closeStreamWithLog(stream: P2PStream, context: string): Promise<void> {
  debugWarn(`${context} at ${new Date().toISOString()} | ${describeStreamState(stream)}`);
  await stream.close();
}

function toUint8Array(chunk: Uint8Array | { subarray?: () => Uint8Array }): Uint8Array {
  if (chunk instanceof Uint8Array) {
    return chunk;
  }

  if (typeof chunk.subarray === 'function') {
    return chunk.subarray();
  }

  throw new Error('Unknown stream chunk type');
}

function getReadableStream(stream: P2PStream): AsyncIterable<Uint8Array> {
  if (typeof stream[Symbol.asyncIterator] === 'function') {
    return stream as AsyncIterable<Uint8Array>;
  }

  if (stream.source != null) {
    return stream.source;
  }

  throw new Error('P2P stream is not readable');
}

interface QueuedWrite {
  data: Uint8Array;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const sinkStreamWriters = new WeakMap<P2PStream, SinkStreamWriter>();

class SinkStreamWriter {
  private readonly sinkPromise: Promise<void>;
  private queue: QueuedWrite[] = [];
  private waiter: (() => void) | null = null;
  private ended = false;
  private failed: unknown = null;

  constructor(private readonly stream: P2PStream) {
    if (typeof stream.sink !== 'function') {
      throw new Error('P2P stream is not writable');
    }

    this.sinkPromise = stream.sink(this.iterate()).catch((error: unknown) => {
      this.failed = error;
      this.rejectQueued(error);
    });
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.failed) {
      throw this.failed;
    }
    if (this.ended) {
      throw new Error('P2P stream writer is already ended');
    }

    await new Promise<void>((resolve, reject) => {
      this.queue.push({ data, resolve, reject });
      this.wake();
    });

    if (this.failed) {
      throw this.failed;
    }
  }

  async end(): Promise<void> {
    if (!this.ended) {
      this.ended = true;
      this.wake();
    }
    await this.sinkPromise;
    if (this.failed) {
      throw this.failed;
    }
  }

  private async *iterate(): AsyncGenerator<Uint8Array> {
    while (true) {
      if (this.queue.length === 0) {
        if (this.ended) {
          return;
        }
        await this.waitForWrite();
        continue;
      }

      const item = this.queue.shift()!;
      try {
        yield item.data;
        item.resolve();
      } catch (error: unknown) {
        item.reject(error);
        throw error;
      }
    }
  }

  private waitForWrite(): Promise<void> {
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  private rejectQueued(error: unknown): void {
    for (const item of this.queue.splice(0)) {
      item.reject(error);
    }
    this.wake();
  }
}

async function flushMessages(stream: P2PStream, buffers: Uint8Array[]): Promise<void> {
  for (const buffer of buffers) {
    await writeStreamBytes(stream, buffer);
  }
}

async function writeStreamBytes(stream: P2PStream, data: Uint8Array, context = 'p2p write'): Promise<void> {
  if (typeof stream.send === 'function') {
    try {
      const ok = stream.send(data);
      if (!ok && typeof stream.onDrain === 'function') {
        debugWarn(`[Gateway] ${context} waiting on drain | ${describeStreamState(stream)}`);
        await stream.onDrain();
      }
      return;
    } catch (error: unknown) {
      throw new Error(`${context} failed: ${formatError(error)} | ${describeStreamState(stream)}`);
    }
  }

  if (typeof stream.sink === 'function') {
    try {
      await getSinkStreamWriter(stream).write(data);
      return;
    } catch (error: unknown) {
      throw new Error(`${context} failed: ${formatError(error)} | ${describeStreamState(stream)}`);
    }
  }

  throw new Error('P2P stream is not writable');
}

function getSinkStreamWriter(stream: P2PStream): SinkStreamWriter {
  let writer = sinkStreamWriters.get(stream);
  if (!writer) {
    writer = new SinkStreamWriter(stream);
    sinkStreamWriters.set(stream, writer);
  }
  return writer;
}

async function finishStreamWrites(stream: P2PStream): Promise<void> {
  const writer = sinkStreamWriters.get(stream);
  if (!writer) {
    return;
  }
  sinkStreamWriters.delete(stream);
  await writer.end();
}

const debuggedStreams = new WeakSet<P2PStream>();

function attachStreamDebugListeners(stream: P2PStream, label: string): void {
  if (!STREAM_DEBUG || debuggedStreams.has(stream) || typeof stream.addEventListener !== 'function') {
    return;
  }

  debuggedStreams.add(stream);
  stream.addEventListener('remoteCloseWrite', () => {
    debugWarn(`${label} remoteCloseWrite | ${describeStreamState(stream)}`);
  });
  stream.addEventListener('drain', () => {
    debugLog(`${label} drain | ${describeStreamState(stream)}`);
  });
  stream.addEventListener('close', (event?: unknown) => {
    debugWarn(`${label} close | ${describeCloseEvent(event)} | ${describeStreamState(stream)}`);
  });
}

function debugLog(message: string): void {
  if (STREAM_DEBUG) {
    console.log(message);
  }
}

function debugWarn(message: string): void {
  if (STREAM_DEBUG) {
    console.warn(message);
  }
}

function describeStreamState(stream: P2PStream): string {
  return [
    `status=${stream.status ?? 'n/a'}`,
    `writeStatus=${stream.writeStatus ?? 'n/a'}`,
    `readStatus=${stream.readStatus ?? 'n/a'}`,
    `remoteWriteStatus=${stream.remoteWriteStatus ?? 'n/a'}`,
    `remoteReadStatus=${stream.remoteReadStatus ?? 'n/a'}`,
    `writeBuffer=${stream.writeBufferLength ?? 'n/a'}`,
    `readBuffer=${stream.readBufferLength ?? 'n/a'}`,
    `needsDrain=${stream.writableNeedsDrain ?? 'n/a'}`,
    `inactivityTimeout=${stream.inactivityTimeout ?? 'n/a'}`,
    `maxReadBuffer=${stream.maxReadBufferLength ?? 'n/a'}`,
    `maxWriteBuffer=${stream.maxWriteBufferLength ?? 'n/a'}`,
    `timeline=${formatTimeline(stream.timeline)}`,
  ].join(' ');
}

function formatTimeline(timeline: Record<string, unknown> | undefined): string {
  if (timeline == null) {
    return 'n/a';
  }

  try {
    return JSON.stringify(timeline);
  } catch {
    return '[unserializable]';
  }
}

function describeCloseEvent(event: unknown): string {
  if (event == null || typeof event !== 'object') {
    return 'event=none';
  }

  const candidate = event as {
    error?: unknown;
    detail?: { error?: unknown; local?: unknown };
    local?: unknown;
    type?: unknown;
  };
  const error = candidate.error ?? candidate.detail?.error;
  const local = candidate.local ?? candidate.detail?.local;
  const type = candidate.type;
  return `type=${String(type ?? 'unknown')} local=${String(local ?? 'n/a')} error=${formatError(error)}`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function normalizeProxyBasePath(pathname: string): string {
  if (!pathname || pathname === '/') {
    return '';
  }

  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function createKeyPairFromPrivateKey(serializedPrivateKey: string): ReturnType<typeof generateKeyPair> {
  const privateKey = hexToBytes(serializedPrivateKey);
  const publicKey = getPublicKey(privateKey);
  return {
    privateKey,
    publicKey,
    secretKey: privateKey,
  };
}

/**
 * Tapeout API Market (TAM) — Shared Type Definitions
 * EscrowPool-only payment flow.
 */
import type { ModelProvenancePolicy, ModelProvenanceProof, ModelProvenanceVerification } from '../model-provenance.js';

// ============ Provider (Seller) Types ============

export interface ProviderAnnouncement {
  paymentToken?: import('../payment-token.js').PaymentToken;
  settlementPool?: string;
  peerId: string;
  walletAddress: `0x${string}`;
  publicKey: string;
  multiaddrs?: string[];
  models: ModelPricing[];
  region: string;
  maxConcurrent: number;
  stakeAmount: bigint;
  reputation: ReputationInfo;
  timestamp: number;
  signature: string;
}

export interface ModelPricing {
  /** Optional owner-imposed ceiling for future automatic quotes. */
  quotePriceCeiling?: number;
  model: string;
  inputPer1m: number;
  outputPer1m: number;
  p0?: number;
  alpha?: number;
  dailyQuotaUsd?: number;
  availableQuotaUsd?: number;
}

export interface QuoteMessage {
  makerId: string;
  makerAddress: `0x${string}`;
  signerAddress?: `0x${string}`;
  signingDelegation?: QuoteSignerDelegation;
  nonce: string;
  model: string;
  p0: number;
  alpha: number;
  utilization: number;
  maxConcurrent: number;
  currentPrice: number;
  recentLatencyMs: number;
  successRate: number;
  timestamp: number;
  ttlMs: number;
  schemaVersion: 1;
  signature: `0x${string}`;
}

export interface QuoteSignerDelegation {
  walletAddress: `0x${string}`;
  signerAddress: `0x${string}`;
  issuedAt: number;
  expiresAt: number;
  signature: `0x${string}`;
}

export interface ReputationInfo {
  score: number;
  totalTransactions: number;
  successRate: number;
  avgLatencyMs: number;
}

export interface ProviderRuntimeHint {
  loadHint?: number;
  inflight?: number;
  queueDepth?: number;
  retryAfterSeconds?: number;
  observedLatencyMs?: number;
}

export interface ProviderErrorPayload {
  type: string;
  message: string;
  statusCode?: number;
  retryAfterSeconds?: number;
  providerHint?: ProviderRuntimeHint;
  currentQuote?: QuoteMessage;
}

// ============ P2P Protocol Messages ============

export type ProtocolMessageType =
  | 'request'
  | 'response'
  | 'stream_start'
  | 'stream_chunk'
  | 'stream_end'
  | 'authorization'
  | 'authorization_required'
  | 'settlement_ack'
  | 'error'
  | 'ping'
  | 'pong';

export interface ProtocolMessage {
  type: ProtocolMessageType;
  requestId: string;
  payload?: string;
  error?: string;
  providerHint?: ProviderRuntimeHint;
  timestamp: number;
}

export interface InferenceRequest extends ProtocolMessage {
  type: 'request';
  buyerPublicKey: string;
  buyerAddress: `0x${string}`;
  model: string;
  authorization: SignedAuthorization;
  quote?: QuoteMessage;
  clientVersion?: string;
  protocolVersion?: string;
}

export interface InferenceResponse extends ProtocolMessage {
  type: 'response';
  usage?: TokenUsage;
  upstreamProof?: UpstreamProof;
  modelProvenanceProof?: ModelProvenanceProof;
}

export interface RejectWithQuote {
  code: 'STALE_QUOTE';
  reason: string;
  currentQuote: QuoteMessage;
  retryable: true;
}

export interface StreamChunkMessage extends ProtocolMessage {
  type: 'stream_chunk';
}

export interface StreamEndMessage extends ProtocolMessage {
  type: 'stream_end';
  usage?: TokenUsage;
  upstreamProof?: UpstreamProof;
  modelProvenanceProof?: ModelProvenanceProof;
}

export interface AuthorizationMessage extends ProtocolMessage {
  type: 'authorization';
  authorization: SignedAuthorization;
}

export interface AuthorizationRequiredMessage extends ProtocolMessage {
  type: 'authorization_required';
  requiredAmount: bigint;
  requiredNonce: bigint;
  expiresAt: number;
}

// ============ API Types (OpenAI Compatible) ============

export interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  user?: string;
  session_id?: string;
  max_price_per_1m?: number;
}

export interface ChatCompletionResponse {
  /** Buyer-local verification result; upstreamProof remains an unverified seller declaration. */
  tamProvenance?: ModelProvenanceVerification;
  modelProvenanceProof?: ModelProvenanceProof;
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: TokenUsage;
  upstreamProof?: UpstreamProof;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// ============ Payment Types (EIP-712) ============

export const AUTHORIZATION_NONCE_MODES = {
  sequential: 'sequential',
  bitmap: 'bitmap',
} as const;

export type AuthorizationNonceMode =
  typeof AUTHORIZATION_NONCE_MODES[keyof typeof AUTHORIZATION_NONCE_MODES];

export function normalizeAuthorizationNonceMode(
  nonceMode?: AuthorizationNonceMode,
): AuthorizationNonceMode {
  return nonceMode === AUTHORIZATION_NONCE_MODES.bitmap
    ? AUTHORIZATION_NONCE_MODES.bitmap
    : AUTHORIZATION_NONCE_MODES.sequential;
}

export function authorizationNonceModeValue(nonceMode?: AuthorizationNonceMode): 0 | 1 {
  return normalizeAuthorizationNonceMode(nonceMode) === AUTHORIZATION_NONCE_MODES.bitmap ? 1 : 0;
}

export interface Authorization {
  buyer: `0x${string}`;
  seller: `0x${string}`;
  amount: bigint;
  nonce: bigint;
  expiresAt: number;
  poolId: `0x${string}`;
  nonceMode?: AuthorizationNonceMode;
}

export interface SignedAuthorization extends Authorization {
  signature: `0x${string}`;
}

/** A budget commitment, deliberately NOT a spendable EscrowPool authorization. */
export interface SignedInferenceIntent extends SignedAuthorization {
  requestId: string;
  payloadHash: `0x${string}`;
  inputPrice: bigint; // settlement-token base units per million usage tokens, fixed for this request
  outputPrice: bigint;
  maxInputTokens: number;
  maxOutputTokens: number;
}

export interface HostedAuthorizationQuote {
  buyer: `0x${string}`;
  seller: `0x${string}`;
  amount: string;
  nonce: string;
  expiresAt: number;
  poolId: `0x${string}`;
  nonceMode: AuthorizationNonceMode;
  requestId: string;
  payloadHash: `0x${string}`;
  inputPrice: string;
  outputPrice: string;
  maxInputTokens: number;
  maxOutputTokens: number;
}

export interface HostedGatewayPrepareRequest {
  buyer: `0x${string}`;
  request: ChatCompletionRequest;
}

export interface HostedGatewayPrepareResponse {
  paymentToken?: import('../payment-token.js').PaymentToken;
  estimatedCostBaseUnits?: string;
  estimatedCostToken?: string;
  preparedRequestId: string;
  requestId: string;
  executeUrl: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostMicroUsdc: string;
  estimatedCostUsd: string;
  authorization: HostedAuthorizationQuote;
  typedData: {
    domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: `0x${string}`;
    };
    primaryType: 'InferenceIntent';
    types: Record<string, Array<{ name: string; type: string }>>;
    message: Record<string, unknown>;
  };
  provider: {
    peerId: string;
    walletAddress: `0x${string}`;
    model: string;
    pricing: ModelPricing;
    score: number;
  };
  alternatives: Array<{
    peerId: string;
    walletAddress: `0x${string}`;
    pricing: ModelPricing;
    score: number;
  }>;
}

export interface HostedGatewayExecuteToken {
  preparedRequestId: string;
  authorization: HostedAuthorizationQuote & { signature: `0x${string}` };
}

export interface HostedGatewayPermitDepositRequest {
  buyer: `0x${string}`;
  amount: string;
  deadline: number;
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
}

export interface HostedGatewayDepositResponse {
  txHash: `0x${string}`;
}

export interface PoolBalance {
  buyer: `0x${string}`;
  totalDeposited: bigint;
  availableBalance: bigint;
  reservedBalance: bigint;
  pendingWithdrawAt: number;
}

export interface PendingWithdraw {
  amount: bigint;
  unlockAt: number;
}

// ============ Upstream Proof ============

/** Seller-reported metadata only. This interface contains no cryptographic provenance evidence. */
export interface UpstreamProof {
  requestId?: string;
  model?: string;
  timestamp?: string;
  usage?: TokenUsage;
  pricedAt?: number;
  quoteUsed?: QuoteMessage;
}

// ============ Quality Attestation ============

export interface QualityAttestation {
  providerId: string;
  requestId: string;
  ttftMs: number;
  totalLatencyMs: number;
  tokensPerSecond: number;
  success: boolean;
  timestamp: number;
  buyerSignature: `0x${string}`;
}

// ============ Mining Types ============

export interface MiningRewardEvent {
  provider: `0x${string}`;
  settledUsdc: bigint;
  tokenReward: bigint;
  qualityMultiplier: number;
  phase: number;
}

export interface MilestoneConfig {
  milestone: number;
  unlockPercent: number;
  twapTarget: bigint;
  poolDepthTarget: bigint;
  cumulativeSettlementTarget: bigint;
  durationDays: number;
}

// ============ Config Types ============

export interface ProviderConfig {
  dailyLimitToken?: number;
  maxRequestCostToken?: number;
  maxUnconfirmedCreditToken?: number;
  claimFlushMinAmountBaseUnits?: bigint;
  privateKey: `0x${string}`;
  signingPrivateKey?: `0x${string}`;
  signingDelegation?: QuoteSignerDelegation;
  e2eePrivateKey?: `0x${string}`;
  proxyUrl: string;
  proxyHeaders?: Record<string, string>;
  models: ModelPricing[];
  maxConcurrent?: number;
  aimmQuoteNetworkId?: string;
  aimmCliproxyManagementUrl?: string;
  aimmQuotaPollIntervalMs?: number;
  aimmAccountTiers?: Array<{
    authIndex: string;
    tier: import('../subscription-presets.js').SubscriptionTier;
  }>;
  dailyLimitUsd: number;
  /** Delivery confirmation is bilateral: only vetted buyers until disputes exist. */
  trustedBuyerAddresses?: string[];
  maxRequestCostUsd?: number;
  maxUnconfirmedCreditUsd?: number;
  escrowPoolAddress: `0x${string}`;
  poolId?: `0x${string}`;
  claimBatchMaxSize?: number;
  claimFlushIntervalMs?: number;
  claimFlushMinAmountMicroUsdc?: bigint;
  claimExpirySafetyMs?: number;
  rpcUrl: string;
  chainId: number;
  bootstrapPeers: string[];
}

export interface ConsumerConfig {
  modelProvenance?: ModelProvenancePolicy;
  maxRequestCostToken?: number;
  inputOverheadTokens?: number;
  privateKey?: `0x${string}`;
  port: number;
  apiToken?: string;
  maxRequestCostUsd?: number;
  maxPriceInputPer1m: number;
  maxPriceOutputPer1m: number;
  routingStrategy: 'lowest_price' | 'lowest_latency' | 'highest_reputation' | 'balanced';
  escrowPoolAddress: `0x${string}`;
  poolId?: `0x${string}`;
  authorizationTtlSeconds?: number;
  defaultPoolDepositUsd?: number;
  discoverableModels?: string[];
  rpcUrl: string;
  chainId: number;
  bootstrapPeers: string[];
}

export type SchedulerMode = 'legacy' | 'new';

export interface SchedulerConfig {
  mode: SchedulerMode;
  killSwitch: boolean;
  rolloutPct: number;
  enableHardFilter: boolean;
  enableSessionSticky: boolean;
  enableTopNPreselect: boolean;
  enableP2C: boolean;
  minSuccessRate: number;
  minReputationScore: number;
  minUptimeRate: number;
  newSellerExplorationRate: number;
  stickyMaxSize: number;
  stickyTableCapacity?: number;
  stickyTTLMs: number;
  stickyOverflowRatio: number;
  stickyFailureIgnoreWindowMs: number;
  topN: number;
  priceWeightAlpha: number;
  scoreTieThreshold: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logRingBufferSize: number;
}

export interface ClientVersionPolicy {
  minClientVersion: string;
  recommendedVersion: string;
  upgradeUrl: string;
  bannedVersions?: string[];
  upgradeMessage?: string;
}

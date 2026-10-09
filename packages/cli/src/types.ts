import type { PaymentToken } from '@clawmarket/shared';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface BuyerWalletSummary {
  paymentToken?: PaymentToken;
  object: string;
  address: string;
  usdcBalance: string;
  nativeBalance: string;
  nativeBalanceWei: string;
  escrowPool: string;
  escrowAvailable: string;
  escrowAvailableRaw: string;
  tokenAddress: string;
  credits?: {
    unit: string;
    available: string;
    availableRaw: string;
  };
  pendingWithdraw?: {
    amount: string;
    amountRaw: string;
    unlocksAt: number;
  } | null;
}

export type SellerReachabilityStatus = 'public_direct' | 'relay' | 'not_reachable';

export interface SellerReachabilityPayload {
  status: SellerReachabilityStatus;
  label: string;
  summary: string;
  publicDirect: boolean;
  relay: boolean;
  announced: boolean;
  publicDirectMultiaddrs: string[];
  relayMultiaddrs: string[];
  privateMultiaddrs: string[];
  announcedMultiaddrs: string[];
  checkedAt: number;
}

export interface SellerStatusPayload {
  paymentToken?: PaymentToken;
  status: string;
  seller: {
    walletAddress: string;
    peerId: string;
    publicKey: string;
  };
  backend: {
    mode: string;
    url: string;
    models: Array<{
      model: string;
      inputPer1m: number;
      outputPer1m: number;
      p0?: number;
      alpha?: number;
    }>;
  };
  escrow: {
    poolAddress: string;
    rpcUrl: string;
    chainId: number;
  };
  claims: {
    queuedCount: number;
    queuedAmountMicroUsdc: string;
    queuedAmountUsdc: string;
    lastFlushTxHash?: string | null;
    lastClaimTxHash?: string | null;
    lastClaimedAt?: number | null;
    lastClaimedAmountMicroUsdc?: string;
    lastClaimedAmountUsdc?: string;
    settledCount?: number;
    settledAmountMicroUsdc?: string;
    settledAmountUsdc?: string;
    autoFlushIntervalMs?: number;
    autoFlushMinAmountMicroUsdc?: string;
    autoFlushMinAmountUsdc?: string;
    claimExpirySafetyMs?: number;
    preview: Array<{
      buyer: string;
      seller: string;
      nonce: string;
      expiresAt: number;
      amountMicroUsdc: string;
      amountUsdc: string;
    }>;
  };
  wallet?: {
    usdcBalance: string;
    nativeBalance: string;
    nativeBalanceWei: string;
  };
  protection: {
    available: boolean;
    offline: boolean;
    offlineRemainingSeconds: number;
    currentConcurrent: number;
    maxConcurrent: number;
    dailySpendUsd: number;
    dailyLimitUsd: number;
  };
  clock?: {
    skewMs: number | null;
  };
  metrics?: {
    requestsInboundTotal: {
      ok: number;
      reject: number;
      error: number;
    };
    quotesBroadcastTotal: number;
    utilizationConcurrent: number;
    utilizationWindow: number;
    coolingAccounts: number;
    circuitOpenAccounts: number;
  };
  reachability?: SellerReachabilityPayload;
  mining: {
    enabled: boolean;
    status: string;
    rewardsAddress: string | null;
    reason?: string;
  };
}

export interface PurchaseCreditsResponse {
  object: string;
  amountUsd: number;
  escrowPool: string;
  approvalTx: string | null;
  depositTx: string;
}

export interface WithdrawResponse {
  object: string;
  amountUsd?: number;
  escrowPool?: string;
  tx: string;
}

export interface FlushClaimsResponse {
  flushed: boolean;
  txHash: string | null;
  claims: {
    queuedCount: number;
    queuedAmountMicroUsdc: string;
    queuedAmountUsdc: string;
  };
}

export interface ChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices?: Array<{
    index: number;
    finish_reason: string | null;
    message?: {
      role: string;
      content: string | null;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  upstreamProof?: unknown;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

export interface ChatOptions {
  url: string;
  model: string;
  promptText?: string;
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  signal?: AbortSignal;
  maxTokens?: number;
}

export interface BuyerNetworkStatus {
  paymentToken?: PaymentToken;
  settlementPool?: string;
  object: string;
  updatedAt: number;
  routingStrategy: string;
  maxPriceInputPer1m: number;
  maxPriceOutputPer1m: number;
  source?: 'buyer' | 'seed';
  bestProvider: NetworkProviderSummary | null;
  models: Array<{
    model: string;
    providerCount: number;
    bestProvider: NetworkProviderSummary | null;
    providers: NetworkProviderSummary[];
    error?: string;
  }>;
}

export interface NetworkProviderSummary {
  peerId: string;
  walletAddress: string;
  region?: string;
  score?: number;
  model: string;
  inputPer1m: number;
  outputPer1m: number;
  p0?: number;
  alpha?: number;
  maxConcurrent?: number;
  updatedAt?: number;
  multiaddrs?: string[];
  source?: 'buyer' | 'seed';
}

export interface BuyerWatchState {
  online: boolean;
  address: string;
  creditsMicro: bigint;
}

export interface SellerWatchState {
  online: boolean;
  queuedCount: number;
  queuedAmountMicro: bigint;
  protectionOffline: boolean;
}

export interface ServiceStatus {
  online: boolean;
  message: string;
}

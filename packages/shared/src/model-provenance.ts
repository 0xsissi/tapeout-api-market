import type { ChatCompletionRequest, TokenUsage } from './types/index.js';

/** Optional extension. A seller's proof is untrusted until a buyer-local verifier accepts it. */
export interface ModelProvenanceRequestBinding {
  version: 1;
  requestId: string;
  payloadHash: string;
  /** SHA-256 of the unsigned inference intent, including prices and token budgets. */
  intentHash: string;
  requestHash: string;
  requestedModel: string;
  buyer: string;
  seller: string;
  chainId: number;
  poolId: string;
  nonce: string;
  expiresAt: number;
}

export interface ModelProvenanceBinding extends ModelProvenanceRequestBinding {
  /** SHA-256 of the exact UTF-8 assistant text delivered to the buyer, in chunk order. */
  responseHash: string;
  usage: TokenUsage;
}

export type ProvenanceJson = null | boolean | number | string | ProvenanceJson[] | { [key: string]: ProvenanceJson };
export interface ModelProvenanceProof {
  version: 1;
  scheme: string;
  binding: ModelProvenanceBinding;
  /** Adapter-specific, redacted proof material. Never include credentials here. */
  evidence: ProvenanceJson;
}

export interface ModelProvenancePolicy {
  /** off preserves the existing trust model; required refuses payment without verification. */
  mode: 'off' | 'optional' | 'required';
  allowedOrigins?: string[];
  allowedSchemes?: string[];
  /** Explicit buyer-owned mapping for public aliases and official versioned model IDs. */
  modelAliases?: Record<string, string[]>;
  verificationTimeoutMs?: number;
}

export type ModelProvenanceVerification =
  | { status: 'unverified'; reason: 'disabled' | 'proof_missing' | 'verifier_unavailable' }
  | { status: 'verified'; scheme: string; origin: string; model: string };

/** Implementations must authenticate HTTPS evidence, trust roots and the complete expected binding. */
export interface ModelProvenanceVerifier {
  readonly scheme: string;
  verify(input: {
    proof: ModelProvenanceProof;
    expected: ModelProvenanceBinding;
    signal: AbortSignal;
  }): Promise<{ origin: string; model: string } | null>;
}

export type ProviderInferenceEvent =
  | { type: 'chunk'; content: string }
  | { type: 'complete'; usage: TokenUsage; modelProvenanceProof?: ModelProvenanceProof };

/** Owns the actual upstream transport, so a future zkTLS adapter can witness the official request. */
export interface ProviderInferenceBackend {
  stream(input: {
    request: ChatCompletionRequest;
    binding: ModelProvenanceRequestBinding;
    signal: AbortSignal;
  }): AsyncIterable<ProviderInferenceEvent>;
}

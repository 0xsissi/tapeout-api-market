import { sha256 } from '@noble/hashes/sha256.js';
import type { ChatCompletionRequest, SignedInferenceIntent, ModelProvenanceBinding, ModelProvenanceRequestBinding, ModelProvenanceProof, ModelProvenancePolicy, ModelProvenanceVerifier, ModelProvenanceVerification } from '@clawmarket/shared';

export class ModelProvenanceError extends Error {
  constructor(readonly code: string) { super('Model provenance verification failed: ' + code); this.name = 'ModelProvenanceError'; }
}

const encode = new TextEncoder();
const hex = (bytes: Uint8Array) => '0x' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
export function modelProvenanceRequestHash(request: ChatCompletionRequest): string {
  return hex(sha256(encode.encode(JSON.stringify(canonical({ ...request, stream: true, max_tokens: request.max_tokens ?? 1024 })))));
}

/** Incremental digest independent of chunk boundaries, including split UTF-16 surrogate pairs. */
export class ModelProvenanceTextDigest {
  private readonly hash = sha256.create();
  private pending = '';
  update(text: string): void {
    const value = this.pending + text;
    const code = value.charCodeAt(value.length - 1);
    this.pending = code >= 0xd800 && code <= 0xdbff ? value.slice(-1) : '';
    this.hash.update(encode.encode(this.pending ? value.slice(0, -1) : value));
  }
  digest(): string { return hex(this.hash.clone().update(encode.encode(this.pending)).digest()); }
}

export function modelProvenanceRequestBinding(request: ChatCompletionRequest, intent: SignedInferenceIntent, chainId: number): ModelProvenanceRequestBinding {
  const { signature: _, ...unsigned } = intent;
  const intentHash = hex(sha256(encode.encode(JSON.stringify(canonical({ ...unsigned, amount: intent.amount.toString(), nonce: intent.nonce.toString(),
    inputPrice: intent.inputPrice.toString(), outputPrice: intent.outputPrice.toString() })))));
  return { version: 1, requestId: intent.requestId, payloadHash: intent.payloadHash, intentHash, requestHash: modelProvenanceRequestHash(request),
    requestedModel: request.model, buyer: intent.buyer.toLowerCase(), seller: intent.seller.toLowerCase(), chainId,
    poolId: intent.poolId.toLowerCase(), nonce: intent.nonce.toString(), expiresAt: intent.expiresAt };
}

export const MAX_MODEL_PROVENANCE_PROOF_BYTES = 256 * 1024;
export function assertModelProvenanceBinding(value: unknown, expected: ModelProvenanceBinding): asserts value is ModelProvenanceProof {
  try {
    const proof = value as ModelProvenanceProof;
    if (!proof || proof.version !== 1 || typeof proof.scheme !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,80}$/.test(proof.scheme) || !('evidence' in proof) || proof.evidence === undefined ||
      encode.encode(JSON.stringify(proof)).length > MAX_MODEL_PROVENANCE_PROOF_BYTES) throw new Error();
    if (JSON.stringify(canonical(proof.binding)) !== JSON.stringify(canonical(expected))) throw new ModelProvenanceError('binding_mismatch');
  } catch (error) {
    if (error instanceof ModelProvenanceError) throw error;
    throw new ModelProvenanceError('invalid_proof');
  }
}

function origin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { throw new ModelProvenanceError('invalid_origin'); }
}

export function validateModelProvenancePolicy(policy: ModelProvenancePolicy): void {
  if (!policy || !['off', 'optional', 'required'].includes(policy.mode)) throw new ModelProvenanceError('invalid_policy');
  if (policy.verificationTimeoutMs != null && (!Number.isSafeInteger(policy.verificationTimeoutMs) || policy.verificationTimeoutMs < 1 || policy.verificationTimeoutMs > 120_000)) throw new ModelProvenanceError('invalid_policy');
  if (policy.allowedOrigins != null) { if (!Array.isArray(policy.allowedOrigins)) throw new ModelProvenanceError('invalid_policy'); policy.allowedOrigins.forEach(origin); }
  if (policy.allowedSchemes != null && (!Array.isArray(policy.allowedSchemes) || policy.allowedSchemes.some(value => typeof value !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,80}$/.test(value)))) throw new ModelProvenanceError('invalid_policy');
  if (policy.modelAliases != null && (typeof policy.modelAliases !== 'object' || Array.isArray(policy.modelAliases) ||
    Object.entries(policy.modelAliases).some(([model, aliases]) => !model || model.length > 200 || !Array.isArray(aliases) || !aliases.length ||
      aliases.some(alias => typeof alias !== 'string' || !alias || alias.length > 200)))) throw new ModelProvenanceError('invalid_policy');
}

export function assertModelProvenanceReady(policy: ModelProvenancePolicy, verifier?: ModelProvenanceVerifier): void {
  validateModelProvenancePolicy(policy);
  if (policy.mode === 'required' && !verifier) throw new ModelProvenanceError('verifier_unavailable');
  if (policy.mode !== 'off' && verifier && !policy.allowedOrigins?.length) throw new ModelProvenanceError('origins_required');
}

/** No built-in verifier is provided. Seller-provided booleans/statuses are never trusted. */
export async function verifyModelProvenance(value: unknown, expected: ModelProvenanceBinding, policy: ModelProvenancePolicy = { mode: 'off' }, verifier?: ModelProvenanceVerifier): Promise<ModelProvenanceVerification> {
  assertModelProvenanceReady(policy, verifier);
  policy = structuredClone(policy);
  expected = structuredClone(expected);
  if (policy.mode === 'off') return { status: 'unverified', reason: 'disabled' };
  if (value == null) {
    if (policy.mode === 'required') throw new ModelProvenanceError('proof_missing');
    return { status: 'unverified', reason: 'proof_missing' };
  }
  assertModelProvenanceBinding(value, expected);
  value = JSON.parse(JSON.stringify(value)) as ModelProvenanceProof;
  if (!verifier) return { status: 'unverified', reason: 'verifier_unavailable' };
  const proof = value as ModelProvenanceProof;
  if (proof.scheme !== verifier.scheme || policy.allowedSchemes && !policy.allowedSchemes.includes(proof.scheme)) throw new ModelProvenanceError('unsupported_scheme');
  if (expected.expiresAt * 1000 <= Date.now()) throw new ModelProvenanceError('proof_expired');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      // Give adapters snapshots so they cannot mutate the transport object before payment.
      Promise.resolve().then(() => verifier.verify({ proof: structuredClone(proof), expected: structuredClone(expected), signal: controller.signal }))
        .catch(() => { throw new ModelProvenanceError('invalid_proof'); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ModelProvenanceError('verification_timeout')); }, policy.verificationTimeoutMs ?? 10_000); }),
    ]);
    if (!result || typeof result.model !== 'string') throw new ModelProvenanceError('invalid_proof');
    const verifiedOrigin = origin(result.origin);
    if (!policy.allowedOrigins!.map(origin).includes(verifiedOrigin)) throw new ModelProvenanceError('origin_not_allowed');
    const aliases = policy.modelAliases?.[expected.requestedModel];
    if (!(Array.isArray(aliases) ? aliases : [expected.requestedModel]).includes(result.model)) throw new ModelProvenanceError('model_mismatch');
    if (expected.expiresAt * 1000 <= Date.now()) throw new ModelProvenanceError('proof_expired');
    return { status: 'verified', scheme: proof.scheme, origin: verifiedOrigin, model: result.model };
  } catch (error) {
    if (error instanceof ModelProvenanceError) throw error;
    // Do not leak raw adapter errors, transcripts, tokens or response content.
    throw new ModelProvenanceError('invalid_proof');
  } finally { if (timer) clearTimeout(timer); controller.abort(); }
}

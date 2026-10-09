import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha256.js';
import type { ModelProvenanceBinding, ModelProvenanceVerifier } from '@clawmarket/shared';
import { assertModelProvenanceBinding, assertModelProvenanceReady, MAX_MODEL_PROVENANCE_PROOF_BYTES, modelProvenanceRequestBinding, modelProvenanceRequestHash, ModelProvenanceTextDigest, verifyModelProvenance } from './model-provenance.js';

const request = { model: 'test-model', messages: [{ role: 'user' as const, content: 'hello' }] };
const intent = { requestId: 'request-1', payloadHash: '0xpayload', buyer: '0xBUYER', seller: '0xSELLER', poolId: '0xPOOL', nonce: 1n,
  expiresAt: 4_000_000_000, signature: '0x' as const, amount: 100n, inputPrice: 1n, outputPrice: 2n, maxInputTokens: 1024, maxOutputTokens: 1024, nonceMode: 'bitmap' as const };
const binding: ModelProvenanceBinding = { ...modelProvenanceRequestBinding(request, intent as any, 97), responseHash: '0xanswer', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } };
const proof = () => ({ version: 1 as const, scheme: 'test-only', binding: structuredClone(binding), evidence: { fixture: true } });
const policy = { mode: 'required' as const, allowedOrigins: ['https://official.example'], allowedSchemes: ['test-only'] };
const verifier = (verify = vi.fn(async () => ({ origin: 'https://official.example', model: 'test-model' }))): ModelProvenanceVerifier => ({ scheme: 'test-only', verify });

describe('model provenance adapter boundary (synthetic evidence only)', () => {
  it('preserves the default trust model without inventing verified status', async () => {
    expect(await verifyModelProvenance({ verified: true }, binding)).toEqual({ status: 'unverified', reason: 'disabled' });
    expect(await verifyModelProvenance(undefined, binding, { mode: 'optional' })).toEqual({ status: 'unverified', reason: 'proof_missing' });
    expect(() => assertModelProvenanceReady(policy)).toThrow('verifier_unavailable');
    await expect(verifyModelProvenance(undefined, binding, policy, verifier())).rejects.toThrow('proof_missing');
  });

  it.each(['requestId', 'payloadHash', 'intentHash', 'requestHash', 'requestedModel', 'buyer', 'seller', 'chainId', 'poolId', 'nonce', 'expiresAt', 'responseHash', 'usage'] as const)('rejects replay or tampering of %s before calling the verifier', async key => {
    const value = proof();
    (value.binding as any)[key] = key === 'usage' ? { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } : key === 'chainId' || key === 'expiresAt' ? 1 : 'changed';
    const adapter = verifier();
    await expect(verifyModelProvenance(value, binding, policy, adapter)).rejects.toThrow('binding_mismatch');
    expect(adapter.verify).not.toHaveBeenCalled();
  });

  it('accepts only an adapter result matching the buyer origin and model policy', async () => {
    expect(await verifyModelProvenance(proof(), binding, policy, verifier())).toEqual({ status: 'verified', scheme: 'test-only', origin: 'https://official.example', model: 'test-model' });
    await expect(verifyModelProvenance(proof(), binding, policy, verifier(vi.fn(async () => ({ origin: 'https://imitation.example', model: 'test-model' }))))).rejects.toThrow('origin_not_allowed');
    await expect(verifyModelProvenance(proof(), binding, policy, verifier(vi.fn(async () => ({ origin: 'https://official.example', model: 'cheap-model' }))))).rejects.toThrow('model_mismatch');
    expect((await verifyModelProvenance(proof(), binding, { ...policy, modelAliases: { 'test-model': ['test-model-2026'] } },
      verifier(vi.fn(async () => ({ origin: 'https://official.example', model: 'test-model-2026' }))))).status).toBe('verified');
  });

  it('rejects invalid evidence, schemes, origins, expiry and excessive proof sizes', async () => {
    await expect(verifyModelProvenance(proof(), binding, policy, verifier(vi.fn(async () => null) as any))).rejects.toThrow('invalid_proof');
    await expect(verifyModelProvenance({ ...proof(), scheme: 'unknown' }, binding, policy, verifier())).rejects.toThrow('unsupported_scheme');
    expect(() => assertModelProvenanceReady({ ...policy, allowedOrigins: ['http://official.example'] }, verifier())).toThrow('invalid_origin');
    expect(() => assertModelProvenanceReady({ ...policy, allowedOrigins: [] }, verifier())).toThrow('origins_required');
    expect(() => assertModelProvenanceBinding({ ...proof(), evidence: 'x'.repeat(MAX_MODEL_PROVENANCE_PROOF_BYTES) }, binding)).toThrow('invalid_proof');
    const expired = { ...binding, expiresAt: 1 };
    await expect(verifyModelProvenance({ ...proof(), binding: expired }, expired, policy, verifier())).rejects.toThrow('proof_expired');
  });

  it('bounds verifier latency, aborts the adapter, and never exposes raw errors', async () => {
    let signal: AbortSignal | undefined;
    const hung: ModelProvenanceVerifier = { scheme: 'test-only', verify: input => { signal = input.signal; return new Promise(() => {}); } };
    await expect(verifyModelProvenance(proof(), binding, { ...policy, verificationTimeoutMs: 10 }, hung)).rejects.toThrow('verification_timeout');
    expect(signal?.aborted).toBe(true);
    const broken = verifier(vi.fn(async () => { throw new Error('PRIVATE upstream credential'); }));
    await expect(verifyModelProvenance(proof(), binding, policy, broken)).rejects.toThrow(/^Model provenance verification failed: invalid_proof$/);
  });

  it('does not allow adapter mutation to weaken the expected model or origin', async () => {
    const localPolicy = structuredClone(policy), expected = structuredClone(binding);
    const mutating: ModelProvenanceVerifier = { scheme: 'test-only', verify: async input => {
      input.expected.requestedModel = 'cheap-model'; input.proof.scheme = 'fabricated';
      localPolicy.allowedOrigins.push('https://imitation.example'); expected.requestedModel = 'cheap-model';
      return { origin: 'https://imitation.example', model: 'cheap-model' };
    } };
    await expect(verifyModelProvenance(proof(), expected, localPolicy, mutating)).rejects.toThrow('origin_not_allowed');
  });

  it('hashes exact text regardless of emoji chunk boundaries and normalizes transport defaults', () => {
    const text = 'hello 世界 😀';
    const digest = new ModelProvenanceTextDigest(); for (const char of text.split('')) digest.update(char);
    expect(digest.digest()).toBe('0x' + Buffer.from(sha256(new TextEncoder().encode(text))).toString('hex'));
    expect(modelProvenanceRequestHash(request)).toBe(modelProvenanceRequestHash({ messages: request.messages, max_tokens: 1024, stream: true, model: request.model }));
    expect(modelProvenanceRequestBinding(request, intent as any, 97).intentHash).not.toBe(modelProvenanceRequestBinding(request, { ...intent, outputPrice: 3n } as any, 97).intentHash);
  });
});

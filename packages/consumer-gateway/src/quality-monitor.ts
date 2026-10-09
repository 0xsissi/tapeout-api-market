/**
 * Quality Monitor — Track provider quality metrics for attestations.
 * Maintains a rolling window of request metrics per provider and
 * generates signed QualityAttestation objects for on-chain submission.
 */

import { type Hex } from 'viem';
import { signTypedData } from 'viem/accounts';
import { privateKeyToAccount } from 'viem/accounts';
import type { QualityAttestation } from '@clawmarket/shared';

/** Internal record for a single in-flight or completed request. */
interface RequestRecord {
  providerId: string;
  requestId: string;
  startTime: number;
  firstTokenTime?: number;
  endTime?: number;
  success?: boolean;
  tokenCount?: number;
}

/** Aggregated stats for a single provider. */
export interface ProviderStats {
  providerId: string;
  avgTtftMs: number;
  avgTotalLatencyMs: number;
  successRate: number;
  avgTokensPerSecond: number;
  totalRequests: number;
}

const MAX_WINDOW = 100;

const ATTESTATION_TYPES = {
  QualityAttestation: [
    { name: 'providerId', type: 'string' },
    { name: 'requestId', type: 'string' },
    { name: 'ttftMs', type: 'uint256' },
    { name: 'totalLatencyMs', type: 'uint256' },
    { name: 'tokensPerSecond', type: 'uint256' },
    { name: 'success', type: 'bool' },
    { name: 'timestamp', type: 'uint256' },
  ],
} as const;

/**
 * Tracks provider quality metrics using a rolling window and
 * generates signed EIP-712 attestations for the quality oracle.
 */
export class QualityMonitor {
  /** Rolling window of request records per provider. */
  private records: Map<string, RequestRecord[]> = new Map();
  /** Lookup from requestId to its record for fast mid-flight updates. */
  private activeRequests: Map<string, RequestRecord> = new Map();

  /**
   * Record the start of a new inference request.
   * @param providerId - The provider's peer ID.
   * @param requestId  - Unique request identifier.
   */
  startRequest(providerId: string, requestId: string): void {
    const record: RequestRecord = {
      providerId,
      requestId,
      startTime: Date.now(),
    };
    this.activeRequests.set(requestId, record);
    console.log(`[ConsumerGateway] QualityMonitor: started tracking ${requestId}`);
  }

  /**
   * Record the time-to-first-token for an in-flight request.
   * @param requestId - The request to update.
   */
  recordFirstToken(requestId: string): void {
    const record = this.activeRequests.get(requestId);
    if (!record) {
      console.warn(`[ConsumerGateway] QualityMonitor: unknown request ${requestId} for firstToken`);
      return;
    }
    record.firstTokenTime = Date.now();
  }

  /**
   * Mark a request as complete and archive the record.
   * @param requestId  - The request to finalize.
   * @param success    - Whether the request completed successfully.
   * @param tokenCount - Optional total tokens generated.
   */
  endRequest(requestId: string, success: boolean, tokenCount?: number): void {
    const record = this.activeRequests.get(requestId);
    if (!record) {
      console.warn(`[ConsumerGateway] QualityMonitor: unknown request ${requestId} for endRequest`);
      return;
    }

    record.endTime = Date.now();
    record.success = success;
    record.tokenCount = tokenCount;
    this.activeRequests.delete(requestId);

    // Push into the provider's rolling window
    const providerId = record.providerId;
    let window = this.records.get(providerId);
    if (!window) {
      window = [];
      this.records.set(providerId, window);
    }
    window.push(record);
    if (window.length > MAX_WINDOW) {
      window.shift();
    }

    console.log(
      `[ConsumerGateway] QualityMonitor: completed ${requestId} success=${success} tokens=${tokenCount ?? 'n/a'}`,
    );
  }

  cancelRequest(requestId: string): void {
    this.activeRequests.delete(requestId);
  }

  /**
   * Compute aggregated stats for a given provider.
   * @param providerId - The provider's peer ID.
   * @returns Aggregated quality statistics or null if no data.
   */
  getProviderStats(providerId: string): ProviderStats | null {
    const window = this.records.get(providerId);
    if (!window || window.length === 0) return null;

    let ttftSum = 0;
    let ttftCount = 0;
    let latencySum = 0;
    let latencyCount = 0;
    let successCount = 0;
    let tpsSum = 0;
    let tpsCount = 0;

    for (const r of window) {
      if (r.firstTokenTime !== undefined) {
        ttftSum += r.firstTokenTime - r.startTime;
        ttftCount++;
      }
      if (r.endTime !== undefined) {
        const latency = r.endTime - r.startTime;
        latencySum += latency;
        latencyCount++;

        if (r.tokenCount !== undefined && r.tokenCount > 0 && latency > 0) {
          tpsSum += (r.tokenCount / latency) * 1000;
          tpsCount++;
        }
      }
      if (r.success) successCount++;
    }

    return {
      providerId,
      avgTtftMs: ttftCount > 0 ? ttftSum / ttftCount : 0,
      avgTotalLatencyMs: latencyCount > 0 ? latencySum / latencyCount : 0,
      successRate: window.length > 0 ? successCount / window.length : 0,
      avgTokensPerSecond: tpsCount > 0 ? tpsSum / tpsCount : 0,
      totalRequests: window.length,
    };
  }

  /**
   * Generate a signed EIP-712 QualityAttestation for a completed request.
   * @param providerId      - The provider's peer ID.
   * @param requestId       - The request to attest.
   * @param signerPrivateKey - The buyer's private key used to sign the attestation.
   * @returns A signed QualityAttestation or null if the request is not found.
   */
  async generateAttestation(
    providerId: string,
    requestId: string,
    signerPrivateKey: `0x${string}`,
  ): Promise<QualityAttestation | null> {
    const window = this.records.get(providerId);
    if (!window) return null;

    const record = window.find((r) => r.requestId === requestId);
    if (!record || record.endTime === undefined) return null;

    const ttftMs = record.firstTokenTime !== undefined
      ? record.firstTokenTime - record.startTime
      : 0;
    const totalLatencyMs = record.endTime - record.startTime;
    const tokensPerSecond =
      record.tokenCount !== undefined && record.tokenCount > 0 && totalLatencyMs > 0
        ? Math.round((record.tokenCount / totalLatencyMs) * 1000)
        : 0;
    const timestamp = Date.now();

    const account = privateKeyToAccount(signerPrivateKey);

    const signature = await signTypedData({
      privateKey: signerPrivateKey,
      domain: {
        name: 'ClawMarket',
        version: '1',
      },
      types: ATTESTATION_TYPES,
      primaryType: 'QualityAttestation',
      message: {
        providerId,
        requestId,
        ttftMs: BigInt(Math.round(ttftMs)),
        totalLatencyMs: BigInt(Math.round(totalLatencyMs)),
        tokensPerSecond: BigInt(tokensPerSecond),
        success: record.success ?? false,
        timestamp: BigInt(timestamp),
      },
    });

    const attestation: QualityAttestation = {
      providerId,
      requestId,
      ttftMs: Math.round(ttftMs),
      totalLatencyMs: Math.round(totalLatencyMs),
      tokensPerSecond,
      success: record.success ?? false,
      timestamp,
      buyerSignature: signature,
    };

    console.log(`[ConsumerGateway] QualityMonitor: generated attestation for ${requestId}`);
    return attestation;
  }
}

import { PAYMENT_SCALE, PAYMENT_TOKEN } from '@clawmarket/shared';
/**
 * ClaimBatcher — periodically flush queued EscrowPool authorizations on-chain.
 */

import { ethers } from 'ethers';
import type { AuthorizationNonceMode, SignedAuthorization } from '@clawmarket/shared';

import type { BillingManager } from './billing.js';
import {
  isMissingMethodCall,
  type EscrowPoolClaimMode,
} from './escrow-pool-compat.js';

const EXTENDED_ESCROW_POOL_ABI = [
  'function claim((address buyer,address seller,uint256 amount,uint256 nonce,uint256 expiresAt,bytes32 poolId,uint8 nonceMode)[] auths, bytes[] sigs) external',
  'event Claimed(address indexed buyer, address indexed seller, uint256 amount, uint256 nonce)',
  'event ClaimSkipped(address indexed buyer, address indexed seller, uint256 amount, uint256 nonce, uint8 reason)',
  'event WithdrawRequested(address indexed buyer, uint256 amount, uint256 unlockAt)',
] as const;

const LEGACY_ESCROW_POOL_ABI = [
  'function claim((address buyer,address seller,uint256 amount,uint256 nonce,uint256 expiresAt,bytes32 poolId)[] auths, bytes[] sigs) external',
] as const;

const INSUFFICIENT_BALANCE_REASON = 5n;
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DEFAULT_MIN_FLUSH_AMOUNT_MICRO_USDC = PAYMENT_SCALE;
const DEFAULT_EXPIRY_SAFETY_MS = 180_000;
const CLAIM_BASE_GAS_LIMIT = 500_000n;
const CLAIM_GAS_PER_AUTH = 250_000n;
const CLAIM_MAX_GAS_LIMIT = 8_000_000n;

function authorizationNonceModeValue(nonceMode?: AuthorizationNonceMode): 0 | 1 {
  return nonceMode === 'bitmap' ? 1 : 0;
}

export class ClaimBatcher {
  private readonly wallet: ethers.Wallet;
  private readonly contract: ethers.Contract;
  private readonly legacyContract: ethers.Contract;
  private readonly iface = new ethers.Interface(EXTENDED_ESCROW_POOL_ABI);
  private readonly billing: BillingManager;
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;
  private readonly minFlushAmountMicroUsdc: bigint;
  private readonly expirySafetyMs: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushInFlight: Promise<string | null> | null = null;
  private withdrawPollInFlight: Promise<void> | null = null;
  private lastProcessedWithdrawBlock: number | null = null;
  private claimMode: EscrowPoolClaimMode = 'unknown';
  private stopping = false;

  constructor(
    privateKey: `0x${string}`,
    private readonly escrowPoolAddress: `0x${string}`,
    rpcUrl: string,
    billing: BillingManager,
    maxBatchSize: number = DEFAULT_MAX_BATCH_SIZE,
    flushIntervalMs: number = DEFAULT_FLUSH_INTERVAL_MS,
    minFlushAmountMicroUsdc: bigint = DEFAULT_MIN_FLUSH_AMOUNT_MICRO_USDC,
    expirySafetyMs: number = DEFAULT_EXPIRY_SAFETY_MS,
  ) {
    // Public BSC RPC rejects batched eth_getLogs; isolate it from receipt polling.
    const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1 });
    this.wallet = new ethers.Wallet(privateKey, provider);
    this.contract = new ethers.Contract(escrowPoolAddress, EXTENDED_ESCROW_POOL_ABI, this.wallet);
    this.legacyContract = new ethers.Contract(escrowPoolAddress, LEGACY_ESCROW_POOL_ABI, this.wallet);
    this.billing = billing;
    this.maxBatchSize = maxBatchSize;
    this.flushIntervalMs = flushIntervalMs;
    this.minFlushAmountMicroUsdc = minFlushAmountMicroUsdc;
    this.expirySafetyMs = expirySafetyMs;
  }

  start(): void {
    this.stopping = false;
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setInterval(() => {
      const queuedCount = this.billing.getQueuedAuthorizationCount();
      if (queuedCount > 0) {
        console.log(
          `[ClaimBatcher] Auto flush check queued=${queuedCount} amount=${Number(this.billing.getQueuedAuthorizationAmount()) / Number(PAYMENT_SCALE)} min=${Number(this.minFlushAmountMicroUsdc) / Number(PAYMENT_SCALE)} intervalMs=${this.flushIntervalMs}`,
        );
      }
      this.pollWithdrawRequests()
        .catch((err) => {
          console.error('[ClaimBatcher] WithdrawRequested polling failed:', err);
        })
        .then(() => this.flush())
        .catch((err) => {
          console.error('[ClaimBatcher] Periodic flush failed:', err);
        });
    }, this.flushIntervalMs);

    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await Promise.allSettled([this.flushInFlight, this.withdrawPollInFlight].filter(Boolean));
    this.withdrawPollInFlight = null;
    this.lastProcessedWithdrawBlock = null;
  }

  getFlushIntervalMs(): number {
    return this.flushIntervalMs;
  }

  getMinFlushAmountMicroUsdc(): bigint {
    return this.minFlushAmountMicroUsdc;
  }

  getExpirySafetyMs(): number {
    return this.expirySafetyMs;
  }

  async queueAuthorization(authorization: SignedAuthorization): Promise<void> {
    this.billing.queueAuthorization(authorization);
    if (this.billing.getQueuedAuthorizationCount() >= this.maxBatchSize) {
      await this.flush({ force: true });
    }
  }

  async flush(options: { force?: boolean } = {}): Promise<string | null> {
    if (this.stopping) return null;
    if (this.flushInFlight) {
      return this.flushInFlight;
    }

    const queued = this.billing.getQueuedAuthorizations(this.maxBatchSize);
    if (queued.length === 0) {
      return null;
    }

    if (!options.force && !this.shouldFlush(queued)) {
      return null;
    }

    this.flushInFlight = this.flushQueued(queued);
    try {
      return await this.flushInFlight;
    } finally {
      this.flushInFlight = null;
    }
  }

  private async pollWithdrawRequests(): Promise<void> {
    if (this.withdrawPollInFlight) {
      return this.withdrawPollInFlight;
    }

    this.withdrawPollInFlight = this.pollWithdrawRequestsInternal();
    try {
      await this.withdrawPollInFlight;
    } finally {
      this.withdrawPollInFlight = null;
    }
  }

  private async pollWithdrawRequestsInternal(): Promise<void> {
    const provider = this.wallet.provider;
    if (!provider) {
      return;
    }

    const latestBlock = await provider.getBlockNumber();
    if (this.lastProcessedWithdrawBlock == null) {
      this.lastProcessedWithdrawBlock = latestBlock;
      return;
    }
    if (latestBlock <= this.lastProcessedWithdrawBlock) {
      return;
    }

    const fromBlock = this.lastProcessedWithdrawBlock + 1;
    let forceFlushNeeded = false;
    const logs = await this.contract.queryFilter('WithdrawRequested', fromBlock, latestBlock);
    this.lastProcessedWithdrawBlock = latestBlock;
    for (const log of logs) {
      const buyer = (log as { args?: { buyer?: `0x${string}` } }).args?.buyer;
      const amount = BigInt((log as { args?: { amount?: bigint } }).args?.amount ?? 0n);
      const unlockAt = BigInt((log as { args?: { unlockAt?: bigint } }).args?.unlockAt ?? 0n);
      if (!buyer || !this.billing.hasOutstandingAuthorizationsFromBuyer(buyer)) {
        continue;
      }
      console.warn(
        `[ClaimBatcher] Buyer ${buyer} requested withdraw ${Number(amount) / Number(PAYMENT_SCALE)} ${PAYMENT_TOKEN.symbol} unlocking at ${unlockAt.toString()}; force-flushing queued authorizations`,
      );
      forceFlushNeeded = true;
    }

    if (forceFlushNeeded) {
      await this.flush({ force: true });
    }
  }

  private shouldFlush(batch: SignedAuthorization[]): boolean {
    if (batch.length >= this.maxBatchSize) {
      return true;
    }

    const queuedAmount = batch.reduce((total, item) => total + item.amount, 0n);
    if (queuedAmount >= this.minFlushAmountMicroUsdc) {
      return true;
    }

    const nowMs = Date.now();
    const expirySafetySeconds = Math.ceil(this.expirySafetyMs / 1000);
    return batch.some((item) => (item.expiresAt * 1000) <= nowMs + this.expirySafetyMs || item.expiresAt <= Math.floor(nowMs / 1000) + expirySafetySeconds);
  }

  private async flushQueued(batch: SignedAuthorization[]): Promise<string | null> {
    const auths = batch.map((item) => ({
      buyer: item.buyer,
      seller: item.seller,
      amount: item.amount,
      nonce: item.nonce,
      expiresAt: item.expiresAt,
      poolId: item.poolId,
      nonceMode: authorizationNonceModeValue(item.nonceMode),
    }));
    const legacyAuths = batch.map((item) => ({
      buyer: item.buyer,
      seller: item.seller,
      amount: item.amount,
      nonce: item.nonce,
      expiresAt: item.expiresAt,
      poolId: item.poolId,
    }));
    const sigs = batch.map((item) => item.signature);

    try {
      const tx = await this.submitClaim(auths, legacyAuths, sigs, batch);
      console.log(
        `[ClaimBatcher] Submitted claim batch size=${batch.length} amount=${Number(this.sumAmounts(batch)) / Number(PAYMENT_SCALE)} ${PAYMENT_TOKEN.symbol} tx=${tx.hash}`,
      );
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error('Claim receipt did not confirm a successful transaction');
      const { claimed, removable } = this.parseReceipt(batch, receipt.logs);
      this.billing.dropQueuedAuthorizations([...removable]);
      const claimedBatch = batch.filter((item) => claimed.has(this.getAuthorizationKey(item)));

      if (claimedBatch.length > 0) {
        this.billing.recordClaimSettlement(claimedBatch, tx.hash as `0x${string}`);
      }

      return claimedBatch.length > 0 ? tx.hash as string : null;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ClaimBatcher] Claim batch failed: ${message}`);
      return null;
    }
  }

  private async submitClaim(
    auths: Array<{
      buyer: `0x${string}`;
      seller: `0x${string}`;
      amount: bigint;
      nonce: bigint;
      expiresAt: number;
      poolId: `0x${string}`;
      nonceMode: number;
    }>,
    legacyAuths: Array<{
      buyer: `0x${string}`;
      seller: `0x${string}`;
      amount: bigint;
      nonce: bigint;
      expiresAt: number;
      poolId: `0x${string}`;
    }>,
    sigs: `0x${string}`[],
    batch: SignedAuthorization[],
  ): Promise<ethers.ContractTransactionResponse> {
    if (this.claimMode === 'legacy') {
      return await this.submitWithContract(this.legacyContract as unknown as ClaimCapableContract, legacyAuths, sigs, batch.length, 'legacy');
    }

    try {
      const tx = await this.submitWithContract(this.contract as unknown as ClaimCapableContract, auths, sigs, batch.length, 'extended');
      if (this.claimMode === 'unknown') {
        this.claimMode = 'extended';
      }
      return tx;
    } catch (err) {
      if (!this.shouldFallbackToLegacyClaim(err, batch)) {
        throw err;
      }

      console.warn('[ClaimBatcher] Falling back to legacy EscrowPool.claim ABI for sequential authorizations');
      const tx = await this.submitWithContract(this.legacyContract as unknown as ClaimCapableContract, legacyAuths, sigs, batch.length, 'legacy');
      this.claimMode = 'legacy';
      return tx;
    }
  }

  private async submitWithContract<TAuth extends object>(
    contract: ClaimCapableContract,
    auths: TAuth[],
    sigs: `0x${string}`[],
    batchSize: number,
    mode: 'extended' | 'legacy',
  ): Promise<ethers.ContractTransactionResponse> {
    try {
      return await contract.claim(auths, sigs);
    } catch (err) {
      if (!shouldRetryWithManualGasLimit(err)) {
        throw err;
      }

      await contract.claim.staticCall(auths, sigs);
      const gasLimit = this.computeManualGasLimit(batchSize);
      console.warn(
        `[ClaimBatcher] Retrying ${mode} claim batch with manual gas limit ${gasLimit.toString()} after estimateGas failure`,
      );
      return await contract.claim(auths, sigs, { gasLimit });
    }
  }

  private computeManualGasLimit(batchSize: number): bigint {
    const estimated = CLAIM_BASE_GAS_LIMIT + (BigInt(Math.max(batchSize, 1)) * CLAIM_GAS_PER_AUTH);
    return estimated > CLAIM_MAX_GAS_LIMIT ? CLAIM_MAX_GAS_LIMIT : estimated;
  }

  private shouldFallbackToLegacyClaim(error: unknown, batch: SignedAuthorization[]): boolean {
    if (!isMissingMethodCall(error)) {
      return false;
    }

    return batch.every((item) => authorizationNonceModeValue(item.nonceMode) === 0);
  }

  private parseReceipt(batch: SignedAuthorization[], logs: readonly ethers.Log[]): { claimed: Set<string>; removable: Set<string> } {
    const attempts = new Map(batch.map((item) => [this.getAuthorizationKey(item), item]));
    const claimed = new Set<string>();
    const removable = new Set<string>();

    for (const log of logs) {
      try {
        if (log.address.toLowerCase() !== this.escrowPoolAddress.toLowerCase()) continue;
        const parsed = this.iface.parseLog(log);
        if (!parsed) continue;

        if (parsed.name === 'Claimed') {
          const key = this.getAuthorizationKey({
            buyer: parsed.args.buyer,
            seller: parsed.args.seller,
            nonce: parsed.args.nonce,
          });
          if (attempts.get(key)?.amount === BigInt(parsed.args.amount)) {
            claimed.add(key);
            removable.add(key);
          }
          continue;
        }

        if (parsed.name === 'ClaimSkipped') {
          const key = this.getAuthorizationKey({
            buyer: parsed.args.buyer,
            seller: parsed.args.seller,
            nonce: parsed.args.nonce,
          });
          const reason = BigInt(parsed.args.reason);
          if (attempts.get(key)?.amount === BigInt(parsed.args.amount) && reason !== INSUFFICIENT_BALANCE_REASON) {
            removable.add(key);
          }
        }
      } catch {
        // Ignore unrelated logs.
      }
    }

    return { claimed, removable };
  }

  private getAuthorizationKey(input: {
    buyer: `0x${string}`;
    seller: `0x${string}`;
    nonce: bigint;
  }): string {
    return [
      input.buyer.toLowerCase(),
      input.seller.toLowerCase(),
      input.nonce.toString(),
    ].join(':');
  }

  private sumAmounts(batch: SignedAuthorization[]): bigint {
    return batch.reduce((total, item) => total + item.amount, 0n);
  }
}

interface ClaimCapableContract {
  claim: {
    (auths: unknown[], sigs: `0x${string}`[]): Promise<ethers.ContractTransactionResponse>;
    (auths: unknown[], sigs: `0x${string}`[], overrides: { gasLimit: bigint }): Promise<ethers.ContractTransactionResponse>;
    staticCall(auths: unknown[], sigs: `0x${string}`[]): Promise<unknown>;
  };
}

function shouldRetryWithManualGasLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('intrinsic gas too high') ||
    message.includes('action="estimategas"') ||
    message.includes("action='estimategas'") ||
    message.includes('estimategas')
  );
}

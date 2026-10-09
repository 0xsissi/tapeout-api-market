import { PAYMENT_SCALE } from '@clawmarket/shared';
import { normalizeModelPricing } from '@clawmarket/shared';
import { acquireLedgerLock } from './ledger-lock.js';
/**
 * BillingManager — EscrowPool authorization verification and claim queue state.
 */

import {
  getDefaultAuthorizationDomain,
  verifyAuthorizationSignature,
  verifyInferenceIntent,
} from '@clawmarket/crypto';
import type {
  AuthorizationNonceMode,
  ModelPricing,
  SignedAuthorization,
  SignedInferenceIntent,
} from '@clawmarket/shared';
import {
  MIN_COST_PER_REQUEST,
  cucPrice,
  hasAimmPricing,
  resolveModelAlpha,
  resolveModelBasePrice,
} from '@clawmarket/shared';
import { ethers } from 'ethers';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

import { atomicWriteJson, readJsonSafely } from './durable-store.js';

import { isMissingMethodCall, supportsBitmapNonceQueries } from './escrow-pool-compat.js';

const BITMAP_NONCE_MODE = 'bitmap' as const;
const SEQUENTIAL_NONCE_MODE = 'sequential' as const;

function normalizeAuthorizationNonceMode(
  nonceMode?: AuthorizationNonceMode,
): AuthorizationNonceMode {
  return nonceMode === BITMAP_NONCE_MODE ? BITMAP_NONCE_MODE : SEQUENTIAL_NONCE_MODE;
}



interface CachedValue<T> {
  data: T;
  ts: number;
}

interface PersistedAuthorization {
  buyer: `0x${string}`;
  seller: `0x${string}`;
  amount: string;
  nonce: string;
  expiresAt: number;
  poolId: `0x${string}`;
  nonceMode?: AuthorizationNonceMode;
  signature: `0x${string}`;
}

interface PersistedClaimStats {
  settledCount: number;
  settledAmountMicroUsdc: string;
  lastClaimTxHash: `0x${string}` | null;
  lastClaimedAt: number | null;
  lastClaimedAmountMicroUsdc: string;
}

export interface ClaimSettlementStats {
  settledCount: number;
  settledAmountMicroUsdc: bigint;
  lastClaimTxHash: `0x${string}` | null;
  lastClaimedAt: number | null;
  lastClaimedAmountMicroUsdc: bigint;
}

const ESCROW_POOL_ABI = [
  'function getAvailableBalance(address buyer) view returns (uint256)',
  'function getClaimableBalance(address buyer) view returns (uint256)',
  'function getNonce(address buyer, address seller) view returns (uint256)',
  'function isNonceUsed(address buyer, address seller, uint256 nonce) view returns (bool)',
] as const;

export class BillingManager {
  private readonly dataDir: string;
  private readonly queuePath: string;
  private readonly statsPath: string;
  private readonly reservationPath: string;
  private readonly reservations = new Map<string, SignedInferenceIntent>();
  private closed = false;
  private lockFd: number | undefined;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly poolContract: ethers.Contract;
  private readonly chainId: number;
  private readonly escrowPoolAddress: `0x${string}`;
  private readonly cacheTtlMs: number;
  private readonly poolBalanceCache = new Map<string, CachedValue<bigint>>();
  private readonly poolNonceCache = new Map<string, CachedValue<bigint>>();
  private claimQueue: SignedAuthorization[] = [];
  private claimStats: ClaimSettlementStats = {
    settledCount: 0,
    settledAmountMicroUsdc: 0n,
    lastClaimTxHash: null,
    lastClaimedAt: null,
    lastClaimedAmountMicroUsdc: 0n,
  };
  private bitmapNonceSupport: boolean | null = null;

  constructor(
    escrowPoolAddress: `0x${string}`,
    rpcUrl: string,
    chainId: number,
    cacheTtlMs = 60_000,
    sellerAddress?: string,
  ) {
    const baseDir = path.join(process.env.TAM_HOME ?? process.env.HOME ?? homedir(), '.clawmarket-provider');
    this.dataDir = sellerAddress ? path.join(baseDir, String(chainId), escrowPoolAddress.toLowerCase(), sellerAddress.toLowerCase()) : baseDir;
    this.queuePath = path.join(this.dataDir, 'claim-queue.json');
    this.statsPath = path.join(this.dataDir, 'claim-stats.json');
    this.reservationPath = path.join(this.dataDir, 'reservations.json');
    this.escrowPoolAddress = escrowPoolAddress;
    this.chainId = chainId;
    this.cacheTtlMs = cacheTtlMs;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.poolContract = new ethers.Contract(escrowPoolAddress, ESCROW_POOL_ABI, this.provider);

    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    if (sellerAddress) {
      const lockPath = path.join(this.dataDir, 'ledger.lock');
      try {
        this.lockFd = acquireLedgerLock(lockPath);
      } catch (error) {
        if (this.lockFd !== undefined) fs.closeSync(this.lockFd);
        this.lockFd = undefined;
        throw new Error(`Seller ledger is locked. Stop the other process; after a crash verify its PID before removing ${lockPath}. ${String(error)}`);
      }
    }
    try {
      this.loadClaimQueue();
      this.loadClaimStats();
      const reserved = readJsonSafely(this.reservationPath, []) as SignedInferenceIntent[];
      for (const intent of reserved) this.reservations.set(this.getAuthorizationKey(intent), intent);
      if (sellerAddress) {
        const legacyPath = path.join(baseDir, 'claim-queue.json');
        if (!fs.existsSync(this.queuePath) && fs.existsSync(legacyPath)) {
          const legacy = readJsonSafely(legacyPath, []) as PersistedAuthorization[];
          for (const entry of legacy) {
            if (entry.seller.toLowerCase() === sellerAddress.toLowerCase() && entry.poolId.toLowerCase() === ethers.zeroPadValue(escrowPoolAddress, 32).toLowerCase()) {
              this.claimQueue.push({ ...entry, amount: BigInt(entry.amount), nonce: BigInt(entry.nonce) });
            }
          }
          if (this.claimQueue.length) this.saveClaimQueue();
        }

      }
    } catch (error) { this.close(); throw error; }
  }

  close(): void {
    this.closed = true;
    if (this.lockFd !== undefined) {
      fs.closeSync(this.lockFd);
      this.lockFd = undefined;
      fs.unlinkSync(path.join(this.dataDir, 'ledger.lock'));
    }
  }

  async verifyAuthorization(
    authorization: SignedAuthorization,
    buyerAddress: `0x${string}`,
    sellerAddress: `0x${string}`,
    intent?: SignedInferenceIntent,
  ): Promise<{ valid: boolean; error?: string }> {
    if (authorization.buyer.toLowerCase() !== buyerAddress.toLowerCase()) {
      return { valid: false, error: 'Buyer address mismatch with authorization' };
    }
    if (authorization.seller.toLowerCase() !== sellerAddress.toLowerCase()) {
      return { valid: false, error: 'Seller address mismatch with authorization' };
    }
    if (authorization.amount < MIN_COST_PER_REQUEST) {
      return { valid: false, error: 'Authorization amount below minimum' };
    }
    if (authorization.expiresAt < Math.floor(Date.now() / 1000)) {
      return { valid: false, error: 'Authorization has expired' };
    }

    const expectedPoolId = ethers.zeroPadValue(this.escrowPoolAddress, 32) as `0x${string}`;
    if (authorization.poolId.toLowerCase() !== expectedPoolId.toLowerCase()) {
      return { valid: false, error: 'Authorization pool mismatch' };
    }

    const domain = getDefaultAuthorizationDomain(this.escrowPoolAddress, this.chainId);
    const sigValid = intent
      ? await verifyInferenceIntent(intent, this.escrowPoolAddress, this.chainId)
      : await verifyAuthorizationSignature(authorization, buyerAddress, domain);
    if (!sigValid) {
      return { valid: false, error: 'Authorization signature verification failed' };
    }

    const nonceMode = normalizeAuthorizationNonceMode(authorization.nonceMode);
    if (nonceMode === BITMAP_NONCE_MODE) {
      if (!(await this.supportsBitmapAuthorizations())) {
        return {
          valid: false,
          error: 'Authorization bitmap nonce mode unsupported by deployed EscrowPool',
        };
      }
      if (await this.isPoolNonceUsed(authorization.buyer, authorization.seller, authorization.nonce)) {
        return { valid: false, error: 'Authorization nonce already used' };
      }
      if (this.hasQueuedAuthorization(authorization.buyer, authorization.seller, authorization.nonce)) {
        return { valid: false, error: 'Authorization nonce already queued' };
      }
    } else {
      const onChainNonce = await this.getPoolNonce(authorization.buyer, authorization.seller);
      const queuedNonce = this.getHighestQueuedNonce(authorization.buyer, authorization.seller);
      const latestNonce = onChainNonce > queuedNonce ? onChainNonce : queuedNonce;
      if (authorization.nonce <= latestNonce) {
        return { valid: false, error: 'Authorization nonce not increasing' };
      }
    }

    const availableBalance = await this.getClaimableBalance(authorization.buyer);
    const reservedBalance = this.getQueuedAmountForBuyer(authorization.buyer);
    if (authorization.amount + reservedBalance > availableBalance) {
      return { valid: false, error: 'Escrow pool balance insufficient' };
    }

    return { valid: true };
  }

  async reserveIntent(intent: SignedInferenceIntent, buyer: `0x${string}`, seller: `0x${string}`, maxUnconfirmedCredit = 100_000n): Promise<void> {
    if (intent.nonceMode !== 'bitmap' || !intent.requestId || !intent.payloadHash) throw new Error('A delivery-confirmed intent is required');
    const result = await this.verifyAuthorization(intent, buyer, seller, intent);
    if (!result.valid) throw new Error(result.error);
    const now = Math.floor(Date.now() / 1000);
    if (intent.expiresAt > now + 900) throw new Error('Intent validity exceeds 15 minutes');
    const balance = await this.getClaimableBalance(buyer, true);
    if (this.closed) throw new Error('Billing ledger is closed');
    // The final check + durable reservation are synchronous: concurrent checks cannot both win.
    const key = this.getAuthorizationKey(intent);
    for (const [oldKey, item] of this.reservations) if (item.expiresAt < now) this.reservations.delete(oldKey);
    if (this.reservations.size >= 5000) throw new Error('Too many outstanding reservations');
    if (this.reservations.has(key) || this.hasQueuedAuthorization(buyer, seller, intent.nonce)) throw new Error('Authorization already reserved');
    let reserved = 0n;
    for (const item of this.reservations.values()) {
      if (item.buyer.toLowerCase() === buyer.toLowerCase() && item.expiresAt >= Math.floor(Date.now() / 1000)) reserved += item.amount;
    }
    if (intent.amount + reserved > maxUnconfirmedCredit) throw new Error('Buyer unconfirmed credit limit exceeded');
    if (intent.amount + reserved + this.getQueuedAmountForBuyer(buyer) > balance) throw new Error('Escrow pool balance insufficient for in-flight requests');
    this.reservations.set(key, intent);
    try { this.saveReservations(); } catch (error) { this.reservations.delete(key); throw error; }
  }

  async acceptSettlement(intent: SignedInferenceIntent, authorization: SignedAuthorization, amount: bigint): Promise<void> {
    const key = this.getAuthorizationKey(intent);
    if (!this.reservations.has(key)) throw new Error('No reserved request');
    if (authorization.expiresAt < Math.floor(Date.now() / 1000)) throw new Error('Delivery confirmation expired');
    if (authorization.buyer.toLowerCase() !== intent.buyer.toLowerCase() || authorization.seller.toLowerCase() !== intent.seller.toLowerCase() ||
        authorization.poolId.toLowerCase() !== intent.poolId.toLowerCase() || authorization.nonce !== intent.nonce ||
        authorization.expiresAt !== intent.expiresAt || authorization.nonceMode !== intent.nonceMode || authorization.amount !== amount || amount > intent.amount) {
      throw new Error('Settlement does not match completed request');
    }
    if (!(await verifyAuthorizationSignature(authorization, intent.buyer, getDefaultAuthorizationDomain(this.escrowPoolAddress, this.chainId)))) throw new Error('Invalid delivery confirmation signature');
    if (this.closed) throw new Error('Billing ledger is closed');
    this.queueAuthorization(authorization); // Persist collectible payment BEFORE releasing the reservation.
    this.reservations.delete(key);
    this.saveReservations();
  }

  private saveReservations(): void {
    atomicWriteJson(this.reservationPath, [...this.reservations.values()]);
  }

  trackUsage(
    inputTokens: number,
    outputTokens: number,
    pricing: ModelPricing,
    utilization: number = 0,
  ): { costUsd: number; costMicroUsdc: bigint } {
    const costUsd = calculateUsageCost(inputTokens, outputTokens, pricing, utilization);
    return {
      costUsd,
      costMicroUsdc: BigInt(Math.ceil(costUsd * Number(PAYMENT_SCALE))),
    };
  }

  async getAvailableBalance(
    buyerAddress: `0x${string}`,
    skipCache = false,
  ): Promise<bigint> {
    const key = buyerAddress.toLowerCase();
    if (!skipCache) {
      const cached = this.poolBalanceCache.get(key);
      if (cached && Date.now() - cached.ts < this.cacheTtlMs) {
        return cached.data;
      }
    }

    const balance = await this.poolContract.getAvailableBalance(buyerAddress) as bigint;
    this.poolBalanceCache.set(key, { data: balance, ts: Date.now() });
    return balance;
  }

  async getClaimableBalance(
    buyerAddress: `0x${string}`,
    skipCache = false,
  ): Promise<bigint> {
    const key = `claimable:${buyerAddress.toLowerCase()}`;
    if (!skipCache) {
      const cached = this.poolBalanceCache.get(key);
      if (cached && Date.now() - cached.ts < this.cacheTtlMs) {
        return cached.data;
      }
    }

    try {
      const balance = await this.poolContract.getClaimableBalance(buyerAddress) as bigint;
      this.poolBalanceCache.set(key, { data: balance, ts: Date.now() });
      return balance;
    } catch (error) {
      if (!isMissingMethodCall(error)) {
        throw error;
      }
      const balance = await this.getAvailableBalance(buyerAddress, skipCache);
      this.poolBalanceCache.set(key, { data: balance, ts: Date.now() });
      return balance;
    }
  }

  async getPoolNonce(
    buyerAddress: `0x${string}`,
    sellerAddress: `0x${string}`,
    skipCache = false,
  ): Promise<bigint> {
    const key = `${buyerAddress.toLowerCase()}:${sellerAddress.toLowerCase()}`;
    if (!skipCache) {
      const cached = this.poolNonceCache.get(key);
      if (cached && Date.now() - cached.ts < this.cacheTtlMs) {
        return cached.data;
      }
    }

    const nonce = await this.poolContract.getNonce(buyerAddress, sellerAddress) as bigint;
    this.poolNonceCache.set(key, { data: nonce, ts: Date.now() });
    return nonce;
  }

  async supportsBitmapAuthorizations(): Promise<boolean> {
    if (this.bitmapNonceSupport != null) {
      return this.bitmapNonceSupport;
    }

    const supported = await supportsBitmapNonceQueries(this.provider, this.escrowPoolAddress);
    this.bitmapNonceSupport = supported;
    return supported;
  }

  async isPoolNonceUsed(
    buyerAddress: `0x${string}`,
    sellerAddress: `0x${string}`,
    nonce: bigint,
  ): Promise<boolean> {
    if (!(await this.supportsBitmapAuthorizations())) {
      return false;
    }
    return await this.poolContract.isNonceUsed(buyerAddress, sellerAddress, nonce) as boolean;
  }

  queueAuthorization(authorization: SignedAuthorization): void {
    if (this.closed) throw new Error('Billing ledger is closed');
    const key = this.getAuthorizationKey(authorization);
    const existing = new Set(this.claimQueue.map((item) => this.getAuthorizationKey(item)));
    if (existing.has(key)) {
      return;
    }
    this.claimQueue.push(authorization);
    this.saveClaimQueue();
  }

  dropQueuedAuthorizations(keys: string[]): void {
    if (this.closed) throw new Error('Billing ledger is closed');
    if (keys.length === 0) return;
    const removable = new Set(keys);
    this.claimQueue = this.claimQueue.filter((item) => !removable.has(this.getAuthorizationKey(item)));
    this.saveClaimQueue();
  }

  getQueuedAuthorizations(limit: number = this.claimQueue.length): SignedAuthorization[] {
    return [...this.claimQueue]
      .sort((a, b) => {
        if (a.expiresAt !== b.expiresAt) return a.expiresAt - b.expiresAt;
        if (a.buyer !== b.buyer) return a.buyer.localeCompare(b.buyer);
        if (a.seller !== b.seller) return a.seller.localeCompare(b.seller);
        return a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0;
      })
      .slice(0, limit);
  }

  getQueuedAuthorizationCount(): number {
    return this.claimQueue.length;
  }

  getQueuedAuthorizationAmount(): bigint {
    return this.claimQueue.reduce((total, item) => total + item.amount, 0n);
  }

  hasOutstandingAuthorizationsFromBuyer(buyerAddress: `0x${string}`): boolean {
    const buyer = buyerAddress.toLowerCase();
    return this.claimQueue.some((item) => item.buyer.toLowerCase() === buyer);
  }

  getClaimStats(): ClaimSettlementStats {
    return { ...this.claimStats };
  }

  recordClaimSettlement(
    authorizations: SignedAuthorization[],
    txHash: `0x${string}`,
    claimedAt: number = Date.now(),
  ): void {
    if (this.closed) throw new Error('Billing ledger is closed');
    if (authorizations.length === 0) {
      return;
    }

    const settledAmount = authorizations.reduce((total, item) => total + item.amount, 0n);
    this.claimStats = {
      settledCount: this.claimStats.settledCount + authorizations.length,
      settledAmountMicroUsdc: this.claimStats.settledAmountMicroUsdc + settledAmount,
      lastClaimTxHash: txHash,
      lastClaimedAt: claimedAt,
      lastClaimedAmountMicroUsdc: settledAmount,
    };
    this.saveClaimStats();
  }

  private getQueuedAmountForBuyer(buyerAddress: `0x${string}`): bigint {
    const buyer = buyerAddress.toLowerCase();
    return this.claimQueue.reduce((total, item) => {
      return item.buyer.toLowerCase() === buyer ? total + item.amount : total;
    }, 0n);
  }

  private getHighestQueuedNonce(
    buyerAddress: `0x${string}`,
    sellerAddress: `0x${string}`,
  ): bigint {
    const buyer = buyerAddress.toLowerCase();
    const seller = sellerAddress.toLowerCase();
    let maxNonce = 0n;

    for (const item of this.claimQueue) {
      if (item.buyer.toLowerCase() !== buyer || item.seller.toLowerCase() !== seller) {
        continue;
      }
      if (normalizeAuthorizationNonceMode(item.nonceMode) !== SEQUENTIAL_NONCE_MODE) {
        continue;
      }
      if (item.nonce > maxNonce) {
        maxNonce = item.nonce;
      }
    }

    return maxNonce;
  }

  private getAuthorizationKey(input: {
    buyer: `0x${string}`;
    seller: `0x${string}`;
    nonce: bigint;
  }): string {
    return [input.buyer.toLowerCase(), input.seller.toLowerCase(), input.nonce.toString()].join(':');
  }

  private loadClaimQueue(): void {
    if (!fs.existsSync(this.queuePath)) {
      return;
    }

    try {
      const raw = readJsonSafely(this.queuePath, []) as PersistedAuthorization[];
      this.claimQueue = raw.map((item) => ({
        buyer: item.buyer,
        seller: item.seller,
        amount: BigInt(item.amount),
        nonce: BigInt(item.nonce),
        expiresAt: item.expiresAt,
        poolId: item.poolId,
        nonceMode: item.nonceMode,
        signature: item.signature,
      }));
    } catch (error) {
      throw new Error(`Cannot recover claim queue; refusing to discard payments: ${String(error)}`);
    }
  }

  private saveClaimQueue(): void {
    const serialised: PersistedAuthorization[] = this.claimQueue.map((item) => ({
      buyer: item.buyer,
      seller: item.seller,
      amount: item.amount.toString(),
      nonce: item.nonce.toString(),
      expiresAt: item.expiresAt,
      poolId: item.poolId,
      nonceMode: item.nonceMode,
      signature: item.signature,
    }));
    atomicWriteJson(this.queuePath, serialised);
  }

  private loadClaimStats(): void {
    if (!fs.existsSync(this.statsPath)) {
      return;
    }

    try {
      const raw = readJsonSafely(this.statsPath, {}) as Partial<PersistedClaimStats>;
      this.claimStats = {
        settledCount: typeof raw.settledCount === 'number' ? raw.settledCount : 0,
        settledAmountMicroUsdc: raw.settledAmountMicroUsdc ? BigInt(raw.settledAmountMicroUsdc) : 0n,
        lastClaimTxHash: raw.lastClaimTxHash ?? null,
        lastClaimedAt: typeof raw.lastClaimedAt === 'number' ? raw.lastClaimedAt : null,
        lastClaimedAmountMicroUsdc: raw.lastClaimedAmountMicroUsdc ? BigInt(raw.lastClaimedAmountMicroUsdc) : 0n,
      };
    } catch (error) {
      throw new Error(`Cannot recover claim statistics: ${String(error)}`);
    }
  }

  private saveClaimStats(): void {
    const serialised: PersistedClaimStats = {
      settledCount: this.claimStats.settledCount,
      settledAmountMicroUsdc: this.claimStats.settledAmountMicroUsdc.toString(),
      lastClaimTxHash: this.claimStats.lastClaimTxHash,
      lastClaimedAt: this.claimStats.lastClaimedAt,
      lastClaimedAmountMicroUsdc: this.claimStats.lastClaimedAmountMicroUsdc.toString(),
    };
    atomicWriteJson(this.statsPath, serialised);
  }

  private hasQueuedAuthorization(
    buyerAddress: `0x${string}`,
    sellerAddress: `0x${string}`,
    nonce: bigint,
  ): boolean {
    const key = this.getAuthorizationKey({ buyer: buyerAddress, seller: sellerAddress, nonce });
    return this.claimQueue.some((item) => this.getAuthorizationKey(item) === key);
  }
}

export function calculateUsageCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelPricing,
  utilization: number = 0,
): number {
  if (!hasAimmPricing(pricing)) {
    const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1m;
    const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1m;
    return inputCost + outputCost;
  }

  const currentPrice = cucPrice(
    resolveModelBasePrice(pricing),
    utilization,
    resolveModelAlpha(pricing),
  );

  const rates = normalizeModelPricing({ ...pricing, p0: currentPrice });
  return (inputTokens * rates.inputPer1m + outputTokens * rates.outputPer1m) / 1_000_000;
}

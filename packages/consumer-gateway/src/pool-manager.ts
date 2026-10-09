import { PAYMENT_TOKEN, PAYMENT_NATIVE_SYMBOL, parsePaymentAmount, assertPaymentDeployment } from '@clawmarket/shared';
/**
 * Pool Manager — EscrowPool balance and nonce management for consumers.
 * Uses a single buyer balance shared across all providers.
 */

import { createHash } from 'node:crypto';

import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  type Account,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import {
  type AuthorizationNonceMode,
} from '@clawmarket/shared';

const BITMAP_NONCE_MODE = 'bitmap' as const;
const SEQUENTIAL_NONCE_MODE = 'sequential' as const;
const ALLOWANCE_POLL_INTERVAL_MS = 1_000;
const ALLOWANCE_POLL_ATTEMPTS = 15;

function normalizeAuthorizationNonceMode(
  nonceMode?: AuthorizationNonceMode,
): AuthorizationNonceMode {
  return nonceMode === BITMAP_NONCE_MODE ? BITMAP_NONCE_MODE : SEQUENTIAL_NONCE_MODE;
}

const ESCROW_POOL_ABI = [
  {
    inputs: [{ name: 'amount', type: 'uint256' }],
    name: 'deposit',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'buyer', type: 'address' }],
    name: 'getAvailableBalance',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'buyer', type: 'address' },
      { name: 'seller', type: 'address' },
    ],
    name: 'getNonce',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'amount', type: 'uint256' }],
    name: 'requestWithdraw',
    outputs: [{ name: 'unlockAt', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'cancelWithdraw',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'completeWithdraw',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'usdc',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'buyer', type: 'address' }],
    name: 'pendingWithdrawals',
    outputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'unlockAt', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const ERC20_APPROVAL_ABI = [
  {
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export interface DepositResult {
  approvalTx?: `0x${string}`;
  depositTx: `0x${string}`;
}

export interface PendingWithdraw {
  amount: bigint;
  unlockAt: bigint;
}

export class PoolManager {
  private publicClient!: PublicClient;
  private walletClient!: WalletClient;
  private account!: Account;
  private buyerAddress!: `0x${string}`;
  private chain!: Chain;
  private deploymentCheck?: Promise<void>;
  private tokenAddress: `0x${string}` | null = null;
  private readonly authorizationNonceMode: AuthorizationNonceMode;
  private readonly localSequentialNonceHighWater = new Map<string, bigint>();

  constructor(
    privateKey: `0x${string}`,
    private readonly poolAddress: `0x${string}`,
    rpcUrl: string,
    chainId: number = 84532,
  ) {
    const account = privateKeyToAccount(privateKey);
    this.account = account;
    this.buyerAddress = account.address;
    // Sequential remains the public testnet default until the seller fleet is version-gated for bitmap auth.
    this.authorizationNonceMode = normalizeAuthorizationNonceMode(
      parseAuthorizationNonceMode(process.env.CLAWMARKET_AUTH_NONCE_MODE)
        ?? SEQUENTIAL_NONCE_MODE,
    );

    const chain: Chain = chainId === 84532 ? baseSepolia : ({
      id: chainId,
      name: 'Custom',
      nativeCurrency: { name: PAYMENT_NATIVE_SYMBOL, symbol: PAYMENT_NATIVE_SYMBOL, decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    } as Chain);
    this.chain = chain;

    this.publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as any;
    this.walletClient = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    }) as any;

    console.log(`[ConsumerGateway] PoolManager: initialized for ${this.buyerAddress}`);
  }

  get buyer(): `0x${string}` {
    return this.buyerAddress;
  }

  async getAvailableBalance(): Promise<bigint> {
    await this.validateDeployment();
    return await this.publicClient.readContract({
      address: this.poolAddress,
      abi: ESCROW_POOL_ABI,
      functionName: 'getAvailableBalance',
      args: [this.buyerAddress],
    }) as bigint;
  }

  async getAvailableBalanceFormatted(): Promise<string> {
    return formatUnits(await this.getAvailableBalance(), PAYMENT_TOKEN.decimals);
  }

  async getPendingWithdraw(): Promise<PendingWithdraw> {
    const pending = await this.publicClient.readContract({
      address: this.poolAddress,
      abi: ESCROW_POOL_ABI,
      functionName: 'pendingWithdrawals',
      args: [this.buyerAddress],
    }) as readonly [bigint, bigint] | { amount: bigint; unlockAt: bigint };

    if (Array.isArray(pending)) {
      return {
        amount: pending[0] ?? 0n,
        unlockAt: pending[1] ?? 0n,
      };
    }

    const objectPending = pending as { amount?: bigint; unlockAt?: bigint };
    return {
      amount: objectPending.amount ?? 0n,
      unlockAt: objectPending.unlockAt ?? 0n,
    };
  }

  async ensureSufficientBalance(requiredUsd: number): Promise<bigint> {
    const required = parsePaymentAmount(requiredUsd);
    const available = await this.getAvailableBalance();
    if (available < required) {
      throw new Error(
        `Escrow pool balance insufficient: required=${required.toString()} available=${available.toString()}`,
      );
    }
    return available;
  }

  async getNextNonce(seller: `0x${string}`): Promise<bigint> {
    const current = await this.publicClient.readContract({
      address: this.poolAddress,
      abi: ESCROW_POOL_ABI,
      functionName: 'getNonce',
      args: [this.buyerAddress, seller],
    }) as bigint;
    return current + 1n;
  }

  async allocateAuthorizationNonce(
    seller: `0x${string}`,
    requestId: string,
  ): Promise<{ nonce: bigint; nonceMode: AuthorizationNonceMode }> {
    if (this.authorizationNonceMode === SEQUENTIAL_NONCE_MODE) {
      return {
        nonce: await this.allocateSequentialNonce(seller),
        nonceMode: SEQUENTIAL_NONCE_MODE,
      };
    }

    return {
      nonce: this.deriveBitmapNonce(seller, requestId),
      nonceMode: BITMAP_NONCE_MODE,
    };
  }

  private async allocateSequentialNonce(seller: `0x${string}`): Promise<bigint> {
    const key = seller.toLowerCase();
    const nextOnChainNonce = await this.getNextNonce(seller);
    const localHighWater = this.localSequentialNonceHighWater.get(key) ?? 0n;
    const nonce = nextOnChainNonce > localHighWater
      ? nextOnChainNonce
      : localHighWater + 1n;

    this.localSequentialNonceHighWater.set(key, nonce);
    return nonce;
  }

  async deposit(amountUsd: number): Promise<`0x${string}`> {
    await this.validateDeployment();
    const amount = parsePaymentAmount(amountUsd);
    const depositTx = await this.walletClient.writeContract({
      account: this.account,
      address: this.poolAddress,
      abi: ESCROW_POOL_ABI,
      chain: this.chain,
      functionName: 'deposit',
      args: [amount],
    }) as `0x${string}`;
    await this.waitForSuccessfulReceipt(depositTx, 'deposit');
    return depositTx;
  }

  async depositWithApproval(amountUsd: number): Promise<DepositResult> {
    await this.validateDeployment();
    const amount = parsePaymentAmount(amountUsd);
    console.log(`[ConsumerGateway] Deposit requested amount=${amountUsd.toFixed(PAYMENT_TOKEN.decimals)} ${PAYMENT_TOKEN.symbol} buyer=${this.buyerAddress}`);
    const approvalTx = await this.ensureAllowance(amount);
    const depositTx = await this.walletClient.writeContract({
      account: this.account,
      address: this.poolAddress,
      abi: ESCROW_POOL_ABI,
      chain: this.chain,
      functionName: 'deposit',
      args: [amount],
    }) as `0x${string}`;
    console.log(`[ConsumerGateway] Deposit submitted tx=${depositTx}`);
    await this.waitForSuccessfulReceipt(depositTx, 'deposit');
    console.log(`[ConsumerGateway] Deposit confirmed tx=${depositTx}`);

    return approvalTx ? { approvalTx, depositTx } : { depositTx };
  }

  async requestWithdraw(amountUsd: number): Promise<`0x${string}`> {
    await this.validateDeployment();
    const amount = parsePaymentAmount(amountUsd);
    return await this.walletClient.writeContract({
      account: this.account,
      address: this.poolAddress,
      abi: ESCROW_POOL_ABI,
      chain: this.chain,
      functionName: 'requestWithdraw',
      args: [amount],
    }) as `0x${string}`;
  }

  async cancelWithdraw(): Promise<`0x${string}`> {
    await this.validateDeployment();
    return await this.walletClient.writeContract({
      account: this.account,
      address: this.poolAddress,
      abi: ESCROW_POOL_ABI,
      chain: this.chain,
      functionName: 'cancelWithdraw',
    }) as `0x${string}`;
  }

  async completeWithdraw(): Promise<`0x${string}`> {
    await this.validateDeployment();
    return await this.walletClient.writeContract({
      account: this.account,
      address: this.poolAddress,
      abi: ESCROW_POOL_ABI,
      chain: this.chain,
      functionName: 'completeWithdraw',
    }) as `0x${string}`;
  }

  async getTokenAddress(): Promise<`0x${string}`> {
    if (this.tokenAddress) {
      return this.tokenAddress;
    }

    this.tokenAddress = await this.publicClient.readContract({
      address: this.poolAddress,
      abi: ESCROW_POOL_ABI,
      functionName: 'usdc',
    }) as `0x${string}`;
    return this.tokenAddress;
  }

  private async validateDeployment(): Promise<void> {
    this.deploymentCheck ??= assertPaymentDeployment(this.poolAddress, this.chain.rpcUrls.default.http[0], this.chain.id);
    await this.deploymentCheck;
  }

  private async ensureAllowance(amount: bigint): Promise<`0x${string}` | null> {
    const tokenAddress = await this.getTokenAddress();
    const allowance = await this.publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_APPROVAL_ABI,
      functionName: 'allowance',
      args: [this.buyerAddress, this.poolAddress],
    }) as bigint;

    if (allowance >= amount) {
      return null;
    }

    const approvalTx = await this.walletClient.writeContract({
      account: this.account,
      address: tokenAddress,
      abi: ERC20_APPROVAL_ABI,
      chain: this.chain,
      functionName: 'approve',
      args: [this.poolAddress, amount],
    }) as `0x${string}`;

    console.log(`[ConsumerGateway] Approval submitted tx=${approvalTx}`);
    await this.waitForSuccessfulReceipt(approvalTx, 'approval');
    await this.waitForAllowance(tokenAddress, amount);
    console.log(`[ConsumerGateway] Approval confirmed tx=${approvalTx}`);
    return approvalTx;
  }

  private async waitForSuccessfulReceipt(hash: `0x${string}`, label: string): Promise<void> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash }) as { status?: string };
    if (receipt.status === 'reverted') {
      throw new Error(`${label} transaction reverted: ${hash}`);
    }
  }

  private async waitForAllowance(tokenAddress: `0x${string}`, amount: bigint): Promise<void> {
    for (let attempt = 0; attempt < ALLOWANCE_POLL_ATTEMPTS; attempt++) {
      const allowance = await this.readAllowance(tokenAddress);
      if (allowance >= amount) {
        return;
      }
      await sleep(ALLOWANCE_POLL_INTERVAL_MS);
    }

    const allowance = await this.readAllowance(tokenAddress);
    throw new Error(
      `${PAYMENT_TOKEN.symbol} allowance not visible after approval: required=${amount.toString()} current=${allowance.toString()}`,
    );
  }

  private async readAllowance(tokenAddress: `0x${string}`): Promise<bigint> {
    return await this.publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_APPROVAL_ABI,
      functionName: 'allowance',
      args: [this.buyerAddress, this.poolAddress],
    }) as bigint;
  }

  private deriveBitmapNonce(seller: `0x${string}`, requestId: string): bigint {
    const digest = createHash('sha256')
      .update(this.buyerAddress.toLowerCase())
      .update(':')
      .update(seller.toLowerCase())
      .update(':')
      .update(requestId)
      .digest('hex');
    return BigInt(`0x${digest}`);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseAuthorizationNonceMode(value?: string): AuthorizationNonceMode | undefined {
  if (!value) {
    return undefined;
  }
  return value.trim().toLowerCase() as AuthorizationNonceMode;
}

import { PAYMENT_TOKEN, PAYMENT_NATIVE_SYMBOL, assertPaymentDeployment } from '@clawmarket/shared';
/**
 * Wallet Manager — Wallet lifecycle and balance queries for consumers.
 * Auto-generates a new wallet if no private key is provided and
 * persists it to ~/.clawmarket/wallet.json.
 */

import { createPublicClient, http, formatUnits, type PublicClient } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CONTRACTS } from '@clawmarket/shared';

/** Minimal ERC-20 ABI for balanceOf. */
const ERC20_BALANCE_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const ESCROW_POOL_USDC_ABI = [
  {
    inputs: [],
    name: 'usdc',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/** Project USDC contract address on Base Sepolia. Do not replace with official test USDC. */
const USDC_ADDRESS: `0x${string}` = CONTRACTS.TOKEN;

/** Wallet export shape. */
export interface WalletExport {
  address: `0x${string}`;
  balance: string;
  nativeBalance: string;
  nativeBalanceWei: string;
}

/**
 * Manages the consumer wallet — key generation, persistence, and balance queries.
 */
export class WalletManager {
  private privateKey!: `0x${string}`;
  private address!: `0x${string}`;
  private publicClient!: PublicClient;
  private initialized = false;
  private tokenAddress: `0x${string}` = USDC_ADDRESS;
  private rpcUrl: string;
  private chainId: number;

  constructor(rpcUrl: string, chainId: number = 84532) {
    this.rpcUrl = rpcUrl;
    this.chainId = chainId;
  }

  /**
   * Initialise the wallet. If no private key is supplied, generate one
   * and persist to ~/.clawmarket/wallet.json.
   * @param privateKey - Optional hex-encoded private key.
   */
  async init(privateKey?: `0x${string}`, escrowPoolAddress?: `0x${string}`): Promise<void> {
    if (privateKey) {
      this.privateKey = privateKey;
    } else {
      // Try to load from disk first
      const stored = this.loadStoredKey();
      if (stored) {
        this.privateKey = stored;
        console.log('[ConsumerGateway] WalletManager: loaded wallet from ~/.clawmarket/wallet.json');
      } else {
        this.privateKey = generatePrivateKey();
        this.saveKey(this.privateKey);
        console.log('[ConsumerGateway] WalletManager: generated new wallet, saved to ~/.clawmarket/wallet.json');
      }
    }

    const account = privateKeyToAccount(this.privateKey);
    this.address = account.address;

    const chain = this.chainId === 84532 ? baseSepolia : {
      id: this.chainId,
      name: 'Custom',
      nativeCurrency: { name: PAYMENT_NATIVE_SYMBOL, symbol: PAYMENT_NATIVE_SYMBOL, decimals: 18 },
      rpcUrls: { default: { http: [this.rpcUrl] } },
    };

    if (PAYMENT_TOKEN.symbol === 'BEM' || PAYMENT_TOKEN.chainId === 97) {
      if (!escrowPoolAddress) throw new Error(`${PAYMENT_TOKEN.symbol} escrow pool is required`);
      await assertPaymentDeployment(escrowPoolAddress, this.rpcUrl, this.chainId);
    }
    this.publicClient = createPublicClient({
      chain: chain as any,
      transport: http(this.rpcUrl),
    }) as any;
    this.tokenAddress = await this.resolveTokenAddress(escrowPoolAddress);

    this.initialized = true;
    console.log(`[ConsumerGateway] WalletManager: address ${this.address}`);
  }

  /**
   * Return the wallet address.
   */
  getAddress(): `0x${string}` {
    this.ensureInitialized();
    return this.address;
  }

  /**
   * Return the raw private key.
   */
  getPrivateKey(): `0x${string}` {
    this.ensureInitialized();
    return this.privateKey;
  }

  /**
   * Query the USDC balance on Base Sepolia.
   * @returns Balance as a human-readable string (e.g. "12.50").
   */
  async getBalance(): Promise<string> {
    this.ensureInitialized();
    try {
      const raw = await this.publicClient.readContract({
        address: this.tokenAddress,
        abi: ERC20_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [this.address],
      });
      return formatUnits(raw as bigint, PAYMENT_TOKEN.decimals);
    } catch (err) {
      console.error('[ConsumerGateway] WalletManager: failed to query balance:', err);
      return '0';
    }
  }

  async getNativeBalance(): Promise<{ formatted: string; wei: bigint }> {
    this.ensureInitialized();
    try {
      const wei = await this.publicClient.getBalance({ address: this.address });
      return { formatted: formatUnits(wei, 18), wei };
    } catch (err) {
      console.error('[ConsumerGateway] WalletManager: failed to query native balance:', err);
      return { formatted: '0', wei: 0n };
    }
  }

  /**
   * Export wallet summary including current balance.
   */
  async exportWallet(): Promise<WalletExport> {
    const [balance, nativeBalance] = await Promise.all([
      this.getBalance(),
      this.getNativeBalance(),
    ]);
    return {
      address: this.address,
      balance,
      nativeBalance: nativeBalance.formatted,
      nativeBalanceWei: nativeBalance.wei.toString(),
    };
  }

  // ---- private helpers ----

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('[ConsumerGateway] WalletManager not initialized — call init() first');
    }
  }

  private getConfigDir(): string {
    return path.join((process.env.TAM_HOME ?? process.env.HOME ?? os.homedir()), '.clawmarket');
  }

  private getWalletPath(): string {
    return path.join(this.getConfigDir(), 'wallet.json');
  }

  private getLegacyWalletPath(): string {
    return path.join(this.getConfigDir(), 'seller-wallet.json');
  }

  private loadStoredKey(): `0x${string}` | null {
    try {
      const walletPath = this.getWalletPath();
      if (!fs.existsSync(walletPath)) {
        this.migrateLegacyWallet(walletPath);
      }
      if (!fs.existsSync(walletPath)) return null;
      const data = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
      if (data.privateKey && typeof data.privateKey === 'string') {
        return data.privateKey as `0x${string}`;
      }
      return null;
    } catch {
      return null;
    }
  }

  private saveKey(key: `0x${string}`): void {
    try {
      const dir = this.getConfigDir();
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const account = privateKeyToAccount(key);
      fs.writeFileSync(
        this.getWalletPath(),
        JSON.stringify({ privateKey: key, address: account.address }, null, 2),
        { mode: 0o600 },
      );
    } catch (err) {
      console.error('[ConsumerGateway] WalletManager: failed to save wallet:', err);
    }
  }

  private migrateLegacyWallet(walletPath: string): void {
    const legacyPath = this.getLegacyWalletPath();
    if (!fs.existsSync(legacyPath) || fs.existsSync(walletPath)) {
      return;
    }

    try {
      fs.renameSync(legacyPath, walletPath);
      fs.chmodSync(walletPath, 0o600);
      console.log('[ConsumerGateway] WalletManager: migrated ~/.clawmarket/seller-wallet.json to ~/.clawmarket/wallet.json');
    } catch (err) {
      console.error('[ConsumerGateway] WalletManager: failed to migrate legacy wallet:', err);
    }
  }

  private async resolveTokenAddress(escrowPoolAddressOverride?: `0x${string}`): Promise<`0x${string}`> {
    if (PAYMENT_TOKEN.chainId === 97) {
      if (process.env.USDC_ADDRESS && process.env.USDC_ADDRESS.toLowerCase() !== PAYMENT_TOKEN.address.toLowerCase()) throw new Error('USDC_ADDRESS does not match the selected BSC testnet currency');
      return PAYMENT_TOKEN.address;
    }
    const envUsdc = (PAYMENT_TOKEN.symbol === 'BEM' ? PAYMENT_TOKEN.address : process.env.USDC_ADDRESS)?.trim() as `0x${string}` | undefined;
    if (envUsdc) {
      return envUsdc;
    }

    const escrowPoolAddress =
      (process.env.ESCROW_POOL_ADDRESS?.trim() as `0x${string}` | undefined) ??
      escrowPoolAddressOverride;
    if (!escrowPoolAddress) {
      return USDC_ADDRESS;
    }

    try {
      return (await this.publicClient.readContract({
        address: escrowPoolAddress,
        abi: ESCROW_POOL_USDC_ABI,
        functionName: 'usdc',
      })) as `0x${string}`;
    } catch (err) {
      console.error('[ConsumerGateway] WalletManager: failed to resolve USDC from EscrowPool:', err);
      return USDC_ADDRESS;
    }
  }
}

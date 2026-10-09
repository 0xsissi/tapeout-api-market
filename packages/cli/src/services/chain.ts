import { PAYMENT_TOKEN, PAYMENT_NATIVE_SYMBOL, PAYMENT_NETWORK_NAME, DEFAULT_RPC_URL } from '@clawmarket/shared';
import { createPublicClient, formatUnits, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { CONTRACTS } from '@clawmarket/shared';

export const BASE_SEPOLIA_RPC_URL = DEFAULT_RPC_URL;
// Tapeout API Market uses a project-issued USDC on Base Sepolia, not the official test USDC.
export const BASE_SEPOLIA_USDC = CONTRACTS.TOKEN;
export const MIN_GAS_WEI = 500_000_000_000_000n;
export const MIN_GAS_WEI_STRING = '500000000000000';

const ERC20_BALANCE_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export interface WalletBalances {
  address: `0x${string}`;
  ethWei: bigint;
  ethFormatted: string;
  usdcMicro: bigint;
  usdcFormatted: string;
}

export function addressFromPrivateKey(privateKey: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey.trim())) {
    throw new Error('Private key must be a 0x-prefixed 32-byte hex string.');
  }
  return privateKeyToAccount(privateKey.trim() as `0x${string}`).address;
}

export async function readBalances(
  address: `0x${string}`,
  rpcUrl = BASE_SEPOLIA_RPC_URL,
): Promise<WalletBalances> {
  const client = createPublicClient({
    chain: PAYMENT_TOKEN.chainId !== 84532 ? { id: PAYMENT_TOKEN.chainId, name: PAYMENT_NETWORK_NAME, nativeCurrency: { name: PAYMENT_NATIVE_SYMBOL, symbol: PAYMENT_NATIVE_SYMBOL, decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } : baseSepolia,
    transport: http(rpcUrl),
  });
  const [ethWei, usdcMicro] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({
      address: BASE_SEPOLIA_USDC,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [address],
    }),
  ]);

  return {
    address,
    ethWei,
    ethFormatted: formatUnits(ethWei, 18),
    usdcMicro,
    usdcFormatted: formatUnits(usdcMicro, PAYMENT_TOKEN.decimals),
  };
}

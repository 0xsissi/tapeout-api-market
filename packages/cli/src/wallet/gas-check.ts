import { formatUnits } from 'viem';

import { readBalances } from '../services/chain.js';

export interface GasCheckResult {
  ok: boolean;
  address: `0x${string}`;
  currentWei: bigint;
  currentEth: string;
  minWei: bigint;
  minEth: string;
}

export async function checkWalletGas(address: `0x${string}`, minGasWei: bigint): Promise<GasCheckResult> {
  const balances = await readBalances(address);
  return {
    ok: balances.ethWei >= minGasWei,
    address,
    currentWei: balances.ethWei,
    currentEth: balances.ethFormatted,
    minWei: minGasWei,
    minEth: formatUnits(minGasWei, 18),
  };
}

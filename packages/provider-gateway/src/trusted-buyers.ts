import { readFileSync, statSync } from 'node:fs';
export function approvedBuyer(address: string, file: string | undefined, scope: { sellerAddress: string; currency: string; chainId: number; poolAddress: string }, now = Date.now()): boolean {
  if (!file) return false;
  try {
    if (statSync(file).size > 2_000_000) return false;
    const state = JSON.parse(readFileSync(file, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.grants)) return false;
    return state.grants.some((g: any) => typeof g.address === 'string' && g.address.toLowerCase() === address.toLowerCase() && typeof g.sellerAddress === 'string' && g.sellerAddress.toLowerCase() === scope.sellerAddress.toLowerCase() && g.currency === scope.currency && g.chainId === scope.chainId && typeof g.poolAddress === 'string' && g.poolAddress.toLowerCase() === scope.poolAddress.toLowerCase() && Number.isFinite(g.expiresAt) && g.expiresAt > now);
  } catch { return false; }
}

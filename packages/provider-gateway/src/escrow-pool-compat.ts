import { ethers } from 'ethers';

export type EscrowPoolClaimMode = 'unknown' | 'extended' | 'legacy';

const BITMAP_NONCE_PROBE_IFACE = new ethers.Interface([
  'function isNonceUsed(address buyer, address seller, uint256 nonce) view returns (bool)',
]);

export async function supportsBitmapNonceQueries(
  provider: ethers.Provider,
  escrowPoolAddress: `0x${string}`,
): Promise<boolean> {
  try {
    await provider.call({
      to: escrowPoolAddress,
      data: BITMAP_NONCE_PROBE_IFACE.encodeFunctionData('isNonceUsed', [
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        0n,
      ]),
    });
    return true;
  } catch (error) {
    if (isMissingMethodCall(error)) {
      return false;
    }
    throw error;
  }
}

export function isMissingMethodCall(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('missing revert data') ||
    message.includes('function selector was not recognized') ||
    message.includes('unrecognized selector') ||
    message.includes('no matching fragment')
  );
}

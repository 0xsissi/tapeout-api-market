import { describe, expect, it, vi } from 'vitest';

const {
  createPublicClient,
  formatUnits,
  http,
  privateKeyToAccount,
} = vi.hoisted(() => ({
  createPublicClient: vi.fn(),
  formatUnits: vi.fn((value: bigint, decimals: number) => {
    const divisor = 10n ** BigInt(decimals);
    const whole = value / divisor;
    const fraction = (value % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole.toString();
  }),
  http: vi.fn((url: string) => ({ url })),
  privateKeyToAccount: vi.fn((key: string) => ({ address: `0x${key.slice(-40)}` })),
}));

vi.mock('viem', () => ({
  createPublicClient,
  formatUnits,
  http,
}));

vi.mock('viem/accounts', () => ({
  privateKeyToAccount,
}));

describe('chain services', () => {
  it('derives an address from a private key', async () => {
    const { addressFromPrivateKey } = await import('./chain.js');

    expect(addressFromPrivateKey('0x1111111111111111111111111111111111111111111111111111111111111111')).toBe(
      '0x1111111111111111111111111111111111111111',
    );
  });

  it('reads ETH and USDC balances', async () => {
    const getBalance = vi.fn().mockResolvedValue(500_000_000_000_000n);
    const readContract = vi.fn().mockResolvedValue(1_250_000n);
    createPublicClient.mockReturnValue({ getBalance, readContract });
    const { MIN_GAS_WEI, readBalances } = await import('./chain.js');

    const balances = await readBalances('0x00000000000000000000000000000000000000aa');

    expect(MIN_GAS_WEI).toBe(500_000_000_000_000n);
    expect(balances).toEqual({
      address: '0x00000000000000000000000000000000000000aa',
      ethWei: 500_000_000_000_000n,
      ethFormatted: '0.0005',
      usdcMicro: 1_250_000n,
      usdcFormatted: '1.25',
    });
    expect(getBalance).toHaveBeenCalledWith({ address: '0x00000000000000000000000000000000000000aa' });
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'balanceOf' }));
  });
});

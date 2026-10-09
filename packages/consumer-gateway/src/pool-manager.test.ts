import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  parseUnits,
  privateKeyToAccount,
} = vi.hoisted(() => ({
  createPublicClient: vi.fn(),
  createWalletClient: vi.fn(),
  formatUnits: vi.fn((value: bigint, decimals: number) => {
    const whole = value / (10n ** BigInt(decimals));
    const fraction = (value % (10n ** BigInt(decimals))).toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${whole.toString()}${fraction ? `.${fraction}` : ''}`;
  }),
  http: vi.fn((url: string) => ({ url })),
  parseUnits: vi.fn((value: string, decimals: number) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole + fraction.padEnd(decimals, '0'));
  }),
  privateKeyToAccount: vi.fn((key: string) => ({
    address: (`0x${key.slice(-40)}`) as `0x${string}`,
  })),
}));

vi.mock('viem', () => ({
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  parseUnits,
}));

vi.mock('viem/accounts', () => ({
  privateKeyToAccount,
}));

describe('PoolManager', () => {
  let publicClient: { readContract: ReturnType<typeof vi.fn>; waitForTransactionReceipt: ReturnType<typeof vi.fn> };
  let walletClient: { writeContract: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    delete process.env.CLAWMARKET_AUTH_NONCE_MODE;
    publicClient = {
      readContract: vi.fn(),
      waitForTransactionReceipt: vi.fn(),
    };
    walletClient = {
      writeContract: vi.fn(),
    };
    createPublicClient.mockReset();
    createPublicClient.mockReturnValue(publicClient);
    createWalletClient.mockReset();
    createWalletClient.mockReturnValue(walletClient);
    vi.resetModules();
  });

  async function createManager() {
    const { PoolManager } = await import('./pool-manager.js');
    return new PoolManager(
      '0x1111111111111111111111111111111111111111111111111111111111111111',
      '0x0000000000000000000000000000000000000abc',
      'http://127.0.0.1:8545',
    );
  }

  it('returns the available balance from the escrow pool', async () => {
    publicClient.readContract.mockResolvedValue(123_000n);
    const manager = await createManager();

    await expect(manager.getAvailableBalance()).resolves.toBe(123_000n);
  });

  it('returns the available balance formatted as USDC', async () => {
    publicClient.readContract.mockResolvedValue(123_450_000n);
    const manager = await createManager();

    await expect(manager.getAvailableBalanceFormatted()).resolves.toBe('123.45');
    expect(formatUnits).toHaveBeenCalledWith(123_450_000n, 6);
  });

  it('throws when the available balance is too low', async () => {
    publicClient.readContract.mockResolvedValue(1_000n);
    const manager = await createManager();

    await expect(manager.ensureSufficientBalance(1)).rejects.toThrow(/Escrow pool balance insufficient/);
  });

  it('returns the next seller nonce', async () => {
    publicClient.readContract.mockResolvedValue(7n);
    const manager = await createManager();

    await expect(
      manager.getNextNonce('0x0000000000000000000000000000000000000def'),
    ).resolves.toBe(8n);
  });

  it('allocates sequential nonces by default for network compatibility', async () => {
    publicClient.readContract.mockResolvedValue(7n);
    const manager = await createManager();

    await expect(
      manager.allocateAuthorizationNonce(
        '0x0000000000000000000000000000000000000def',
        'req-123',
      ),
    ).resolves.toEqual({
      nonce: 8n,
      nonceMode: 'sequential',
    });
  });

  it('keeps sequential nonces increasing locally before the chain catches up', async () => {
    publicClient.readContract.mockResolvedValue(7n);
    const manager = await createManager();

    const first = await manager.allocateAuthorizationNonce(
      '0x0000000000000000000000000000000000000def',
      'req-1',
    );
    const second = await manager.allocateAuthorizationNonce(
      '0x0000000000000000000000000000000000000def',
      'req-2',
    );

    expect(first).toEqual({ nonce: 8n, nonceMode: 'sequential' });
    expect(second).toEqual({ nonce: 9n, nonceMode: 'sequential' });
  });

  it('can opt into deterministic bitmap nonces through the env override', async () => {
    process.env.CLAWMARKET_AUTH_NONCE_MODE = 'bitmap';

    try {
      const manager = await createManager();
      const first = await manager.allocateAuthorizationNonce(
        '0x0000000000000000000000000000000000000def',
        'req-bitmap',
      );
      const second = await manager.allocateAuthorizationNonce(
        '0x0000000000000000000000000000000000000def',
        'req-bitmap',
      );

      expect(first.nonceMode).toBe('bitmap');
      expect(typeof first.nonce).toBe('bigint');
      expect(second).toEqual(first);
    } finally {
      delete process.env.CLAWMARKET_AUTH_NONCE_MODE;
    }
  });

  it('approves USDC before depositing when allowance is too low', async () => {
    publicClient.readContract
      .mockResolvedValueOnce('0x0000000000000000000000000000000000000def')
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(1_500_000n);
    publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });
    walletClient.writeContract
      .mockResolvedValueOnce('0xapprove')
      .mockResolvedValueOnce('0xdeposit');
    const manager = await createManager();

    await expect(manager.depositWithApproval(1.5)).resolves.toEqual({
      approvalTx: '0xapprove',
      depositTx: '0xdeposit',
    });
    expect(walletClient.writeContract).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        functionName: 'approve',
      }),
    );
    expect(publicClient.waitForTransactionReceipt).toHaveBeenNthCalledWith(1, { hash: '0xapprove' });
    expect(walletClient.writeContract).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        functionName: 'deposit',
      }),
    );
    expect(publicClient.waitForTransactionReceipt).toHaveBeenNthCalledWith(2, { hash: '0xdeposit' });
  });

  it('skips USDC approval when allowance already covers the deposit', async () => {
    publicClient.readContract
      .mockResolvedValueOnce('0x0000000000000000000000000000000000000def')
      .mockResolvedValueOnce(2_000_000n);
    publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });
    walletClient.writeContract.mockResolvedValueOnce('0xdeposit');
    const manager = await createManager();

    await expect(manager.depositWithApproval(1)).resolves.toEqual({
      depositTx: '0xdeposit',
    });
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'deposit',
      }),
    );
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: '0xdeposit' });
  });
});

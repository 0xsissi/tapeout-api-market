import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  JsonRpcProvider,
  Wallet,
  Contract,
  formatEther,
  encode,
} = vi.hoisted(() => {
  const contractState = {
    reportSettlement: vi.fn(),
    pendingRewards: vi.fn(),
    claimRewards: vi.fn(),
    currentPhase: vi.fn(),
  };
  return {
    JsonRpcProvider: vi.fn(),
    Wallet: vi.fn((privateKey: string) => ({
      address: '0x0000000000000000000000000000000000000abc',
      privateKey,
    })),
    Contract: vi.fn(() => contractState),
    formatEther: vi.fn((value: bigint) => `${value}`),
    encode: vi.fn(() => '0xencoded-attestation'),
  };
});

vi.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider,
    Wallet,
    Contract,
    formatEther,
    AbiCoder: {
      defaultAbiCoder: () => ({
        encode,
      }),
    },
  },
}));

describe('MiningReporter', () => {
  beforeEach(() => {
    JsonRpcProvider.mockClear();
    Wallet.mockClear();
    Contract.mockClear();
    formatEther.mockClear();
    encode.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createReporter() {
    const { MiningReporter } = await import('./mining-reporter.js');
    return new MiningReporter(
      '0x1111111111111111111111111111111111111111111111111111111111111111',
      '0x0000000000000000000000000000000000000001',
      'http://127.0.0.1:8545',
    );
  }

  it('reports settlements with encoded attestation and derived quality multiplier', async () => {
    const tx = {
      hash: '0xtx',
      wait: vi.fn().mockResolvedValue({ blockNumber: 123 }),
    };
    const reporter = await createReporter();
    const contract = Contract.mock.results[0].value;
    contract.reportSettlement.mockResolvedValue(tx);

    const result = await reporter.reportSettlement(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      50_000n,
      {
        providerId: 'provider-a',
        requestId: 'req-1',
        ttftMs: 250,
        totalLatencyMs: 800,
        tokensPerSecond: 42,
        success: true,
        timestamp: 1,
        buyerSignature: '0xsig',
      },
    );

    expect(encode).toHaveBeenCalledOnce();
    expect(contract.reportSettlement).toHaveBeenCalledWith(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      50_000n,
      150,
      '0xencoded-attestation',
    );
    expect(result).toBe('0xtx');
  });

  it('returns null when reporting settlement fails', async () => {
    const reporter = await createReporter();
    const contract = Contract.mock.results[0].value;
    contract.reportSettlement.mockRejectedValue(new Error('boom'));

    await expect(
      reporter.reportSettlement(
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        1n,
      ),
    ).resolves.toBeNull();
  });

  it('returns pending rewards and zero on error', async () => {
    const reporter = await createReporter();
    const contract = Contract.mock.results[0].value;
    contract.pendingRewards.mockResolvedValueOnce(123n).mockRejectedValueOnce(new Error('rpc'));

    await expect(reporter.getAccumulatedRewards()).resolves.toBe(123n);
    await expect(reporter.getAccumulatedRewards()).resolves.toBe(0n);
  });

  it('skips claiming when there are no pending rewards', async () => {
    const reporter = await createReporter();
    const contract = Contract.mock.results[0].value;
    contract.pendingRewards.mockResolvedValue(0n);

    await expect(reporter.claimRewards()).resolves.toBeNull();
    expect(contract.claimRewards).not.toHaveBeenCalled();
  });

  it('claims rewards when balance is available', async () => {
    const tx = {
      hash: '0xclaim',
      wait: vi.fn().mockResolvedValue({ blockNumber: 456 }),
    };
    const reporter = await createReporter();
    const contract = Contract.mock.results[0].value;
    contract.pendingRewards.mockResolvedValue(10n);
    contract.claimRewards.mockResolvedValue(tx);

    await expect(reporter.claimRewards()).resolves.toBe('0xclaim');
    expect(formatEther).toHaveBeenCalledWith(10n);
  });

  it('returns the current phase and falls back to zero on error', async () => {
    const reporter = await createReporter();
    const contract = Contract.mock.results[0].value;
    contract.currentPhase.mockResolvedValueOnce(3n).mockRejectedValueOnce(new Error('fail'));

    await expect(reporter.getCurrentPhase()).resolves.toBe(3);
    await expect(reporter.getCurrentPhase()).resolves.toBe(0);
  });
});

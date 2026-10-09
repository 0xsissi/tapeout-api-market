import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  verifyAuthorizationSignature,
  getDefaultAuthorizationDomain,
} = vi.hoisted(() => ({
  verifyAuthorizationSignature: vi.fn(),
  getDefaultAuthorizationDomain: vi.fn((contractAddress: `0x${string}`) => ({
    name: 'ClawEscrowPool',
    version: '1',
    chainId: 84532,
    verifyingContract: contractAddress,
  })),
}));

vi.mock('@clawmarket/crypto', () => ({
  verifyAuthorizationSignature,
  getDefaultAuthorizationDomain,
}));

describe('BillingManager', () => {
  const poolAddress = '0x0000000000000000000000000000000000000001' as const;
  const buyerAddress = '0x00000000000000000000000000000000000000b0' as const;
  const sellerAddress = '0x00000000000000000000000000000000000000c0' as const;
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T10:00:00.000Z'));
    verifyAuthorizationSignature.mockReset();
    getDefaultAuthorizationDomain.mockClear();
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmarket-billing-test-'));
    process.env.HOME = tempHome;
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tempHome, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  async function makeManager() {
    const { BillingManager } = await import('./billing.js');
    return new BillingManager(poolAddress, 'http://127.0.0.1:8545', 84532);
  }

  function makeAuthorization(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      buyer: buyerAddress,
      seller: sellerAddress,
      amount: 25_000n,
      nonce: 1n,
      expiresAt: Math.floor(Date.now() / 1000) + 900,
      poolId: '0x0000000000000000000000000000000000000000000000000000000000000001',
      signature: '0xsig',
      ...overrides,
    };
  }

  it('rejects authorizations with invalid signatures', async () => {
    const manager = await makeManager();
    verifyAuthorizationSignature.mockResolvedValue(false);

    const result = await manager.verifyAuthorization(
      makeAuthorization(),
      buyerAddress,
      sellerAddress,
    );

    expect(result).toEqual({
      valid: false,
      error: 'Authorization signature verification failed',
    });
  });

  it('rejects authorizations when the seller mismatches the provider', async () => {
    const manager = await makeManager();
    verifyAuthorizationSignature.mockResolvedValue(true);

    const result = await manager.verifyAuthorization(
      makeAuthorization(),
      buyerAddress,
      '0x00000000000000000000000000000000000000d0',
    );

    expect(result).toEqual({
      valid: false,
      error: 'Seller address mismatch with authorization',
    });
  });

  it('rejects authorizations when queued commitments exceed the buyer balance', async () => {
    const manager = await makeManager();
    verifyAuthorizationSignature.mockResolvedValue(true);
    vi.spyOn(manager, 'supportsBitmapAuthorizations').mockResolvedValue(true);
    vi.spyOn(manager, 'isPoolNonceUsed').mockResolvedValue(false);
    vi.spyOn(manager, 'getClaimableBalance').mockResolvedValue(30_000n);

    manager.queueAuthorization(makeAuthorization({
      amount: 15_000n,
      nonce: 99n,
      nonceMode: 'bitmap',
      signature: '0xqueued',
    }));

    const result = await manager.verifyAuthorization(
      makeAuthorization({ amount: 20_000n, nonce: 2n, nonceMode: 'bitmap' }),
      buyerAddress,
      sellerAddress,
    );

    expect(result).toEqual({
      valid: false,
      error: 'Escrow pool balance insufficient',
    });
  });

  it('accepts valid authorizations and persists the queue', async () => {
    const manager = await makeManager();
    const authorization = makeAuthorization({ nonceMode: 'bitmap' });
    verifyAuthorizationSignature.mockResolvedValue(true);
    vi.spyOn(manager, 'supportsBitmapAuthorizations').mockResolvedValue(true);
    vi.spyOn(manager, 'isPoolNonceUsed').mockResolvedValue(false);
    vi.spyOn(manager, 'getClaimableBalance').mockResolvedValue(100_000n);

    await expect(
      manager.verifyAuthorization(authorization, buyerAddress, sellerAddress),
    ).resolves.toEqual({ valid: true });

    manager.queueAuthorization(authorization);

    expect(manager.getQueuedAuthorizationCount()).toBe(1);
    expect(manager.getQueuedAuthorizationAmount()).toBe(25_000n);
    expect(manager.getQueuedAuthorizations()).toEqual([authorization]);

    manager.dropQueuedAuthorizations([`${buyerAddress.toLowerCase()}:${sellerAddress.toLowerCase()}:1`]);
    expect(manager.getQueuedAuthorizationCount()).toBe(0);
  });

  it('rejects bitmap authorizations when the nonce is already used on-chain', async () => {
    const manager = await makeManager();
    verifyAuthorizationSignature.mockResolvedValue(true);
    vi.spyOn(manager, 'supportsBitmapAuthorizations').mockResolvedValue(true);
    vi.spyOn(manager, 'isPoolNonceUsed').mockResolvedValue(true);

    const result = await manager.verifyAuthorization(
      makeAuthorization({ nonceMode: 'bitmap' }),
      buyerAddress,
      sellerAddress,
    );

    expect(result).toEqual({
      valid: false,
      error: 'Authorization nonce already used',
    });
  });

  it('rejects bitmap authorizations when the deployed escrow pool is legacy-only', async () => {
    const manager = await makeManager();
    verifyAuthorizationSignature.mockResolvedValue(true);
    vi.spyOn(manager, 'supportsBitmapAuthorizations').mockResolvedValue(false);

    const result = await manager.verifyAuthorization(
      makeAuthorization({ nonceMode: 'bitmap' }),
      buyerAddress,
      sellerAddress,
    );

    expect(result).toEqual({
      valid: false,
      error: 'Authorization bitmap nonce mode unsupported by deployed EscrowPool',
    });
  });

  it('keeps sequential nonce verification for legacy authorizations', async () => {
    const manager = await makeManager();
    verifyAuthorizationSignature.mockResolvedValue(true);
    vi.spyOn(manager, 'getPoolNonce').mockResolvedValue(4n);
    vi.spyOn(manager, 'getClaimableBalance').mockResolvedValue(100_000n);

    const result = await manager.verifyAuthorization(
      makeAuthorization({ nonce: 4n }),
      buyerAddress,
      sellerAddress,
    );

    expect(result).toEqual({
      valid: false,
      error: 'Authorization nonce not increasing',
    });
  });

  it('keeps legacy input/output pricing when AIMM fields are absent', async () => {
    const manager = await makeManager();

    const usage = manager.trackUsage(500_000, 250_000, {
      model: 'gpt-test',
      inputPer1m: 1.2,
      outputPer1m: 4.8,
    });

    expect(usage.costUsd).toBeCloseTo(1.8, 10);
    expect(usage.costMicroUsdc).toBe(1_800_000n);
  });

  it('uses the CUC curve when AIMM pricing is configured', async () => {
    const manager = await makeManager();

    const usage = manager.trackUsage(
      500_000,
      250_000,
      {
        model: 'gpt-test',
        inputPer1m: 1.2,
        outputPer1m: 4.8,
        p0: 2,
        alpha: 1,
      },
      0.5,
    );

    expect(usage.costUsd).toBeCloseTo(2.4, 10);
    expect(usage.costMicroUsdc).toBe(2_400_000n);
  });

  it('falls back to the legacy price average when only alpha is configured', async () => {
    const manager = await makeManager();

    const usage = manager.trackUsage(
      500_000,
      250_000,
      {
        model: 'gpt-test',
        inputPer1m: 2,
        outputPer1m: 4,
        alpha: 1,
      },
      0.5,
    );

    expect(usage.costUsd).toBeCloseTo(4, 10);
    expect(usage.costMicroUsdc).toBe(4_000_000n);
  });

  it('persists cumulative claim settlement stats across restarts', async () => {
    const manager = await makeManager();
    const first = makeAuthorization({ amount: 25_000n, nonce: 1n });
    const second = makeAuthorization({ amount: 40_000n, nonce: 2n, signature: '0xsig2' });

    manager.recordClaimSettlement([first, second], '0xclaim' as const, 1_777_000_000_000);

    expect(manager.getClaimStats()).toEqual({
      settledCount: 2,
      settledAmountMicroUsdc: 65_000n,
      lastClaimTxHash: '0xclaim',
      lastClaimedAt: 1_777_000_000_000,
      lastClaimedAmountMicroUsdc: 65_000n,
    });

    const restarted = await makeManager();
    expect(restarted.getClaimStats()).toEqual({
      settledCount: 2,
      settledAmountMicroUsdc: 65_000n,
      lastClaimTxHash: '0xclaim',
      lastClaimedAt: 1_777_000_000_000,
      lastClaimedAmountMicroUsdc: 65_000n,
    });
  });
});

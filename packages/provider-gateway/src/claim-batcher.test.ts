import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import http from 'node:http';

import { ethers } from 'ethers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('ClaimBatcher', () => {
  const buyerAddress = '0x00000000000000000000000000000000000000b0' as const;
  const sellerAddress = '0x00000000000000000000000000000000000000c0' as const;
  const poolAddress = '0x0000000000000000000000000000000000000001' as const;
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmarket-claim-batcher-'));
    process.env.HOME = tempHome;
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  async function createFixture(options: { minFlushAmountMicroUsdc?: bigint; rpcUrl?: string } = {}) {
    const { BillingManager } = await import('./billing.js');
    const { ClaimBatcher } = await import('./claim-batcher.js');

    const billing = new BillingManager(poolAddress, 'http://127.0.0.1:8545', 84532);
    const batcher = new ClaimBatcher(
      '0x1111111111111111111111111111111111111111111111111111111111111111',
      poolAddress,
      options.rpcUrl ?? 'http://127.0.0.1:8545',
      billing,
      2,
      5_000,
      options.minFlushAmountMicroUsdc ?? 10_000n,
      60_000,
    );

    return { billing, batcher };
  }

  function makeAuthorization(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      buyer: buyerAddress,
      seller: sellerAddress,
      amount: 25_000n,
      nonce: 1n,
      expiresAt: Math.floor(Date.now() / 1000) + 900,
      poolId: ethers.zeroPadValue(poolAddress, 32) as `0x${string}`,
      nonceMode: 'bitmap' as const,
      signature: '0xsig' as const,
      ...overrides,
    };
  }

  it('keeps receipt reads separate from log queries on RPCs that reject batched eth_getLogs', async () => {
    const requests: unknown[] = [];
    const server = http.createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const value = JSON.parse(body); requests.push(value);
      res.setHeader('content-type', 'application/json');
      if (Array.isArray(value)) {
        res.end(JSON.stringify([{ jsonrpc: '2.0', id: null, error: { code: -32005, message: 'method eth_getLogs in batch triggered rate limit' } }])); return;
      }
      const result = value.method === 'eth_chainId' ? '0x14a34' : value.method === 'eth_blockNumber' ? '0x64' : value.method === 'eth_getLogs' ? [] : null;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: value.id, result }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { billing, batcher } = await createFixture({ rpcUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
    const provider = (batcher as any).wallet.provider as ethers.JsonRpcProvider;
    try {
      const [logs, receipt] = await Promise.all([
        provider.getLogs({ address: poolAddress, fromBlock: 1, toBlock: 10 }),
        provider.getTransactionReceipt('0x' + '11'.repeat(32)),
      ]);
      expect(logs).toEqual([]); expect(receipt).toBeNull();
      expect(requests.some(Array.isArray)).toBe(false);
    } finally { provider.destroy(); billing.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('retries the same withdrawal history after an RPC failure instead of skipping its blocks', async () => {
    const { billing, batcher } = await createFixture();
    const queryFilter = vi.fn().mockRejectedValueOnce(new Error('RPC rate limit')).mockResolvedValueOnce([]);
    (batcher as any).wallet = { provider: { getBlockNumber: vi.fn().mockResolvedValueOnce(100).mockResolvedValueOnce(103).mockResolvedValueOnce(104) } };
    (batcher as any).contract = { queryFilter };
    await (batcher as any).pollWithdrawRequests();
    await expect((batcher as any).pollWithdrawRequests()).rejects.toThrow('RPC rate limit');
    await (batcher as any).pollWithdrawRequests();
    expect(queryFilter.mock.calls).toEqual([['WithdrawRequested', 101, 103], ['WithdrawRequested', 101, 104]]);
    billing.close();
  });

  it('drops claimed authorizations after a successful flush', async () => {
    const { billing, batcher } = await createFixture();
    const first = makeAuthorization();
    const second = makeAuthorization({ nonce: 2n, signature: '0xsig2' });
    billing.queueAuthorization(first);
    billing.queueAuthorization(second);

    const iface = new ethers.Interface([
      'event Claimed(address indexed buyer, address indexed seller, uint256 amount, uint256 nonce)',
    ]);
    (batcher as any).contract = {
      claim: vi.fn().mockResolvedValue({
        hash: '0xclaim',
        wait: vi.fn().mockResolvedValue({
          status: 1,
          logs: [
            iface.encodeEventLog(iface.getEvent('Claimed'), [
              first.buyer,
              first.seller,
              first.amount,
              first.nonce,
            ]),
            iface.encodeEventLog(iface.getEvent('Claimed'), [
              second.buyer,
              second.seller,
              second.amount,
              second.nonce,
            ]),
          ].map((log) => ({ ...log, address: poolAddress })),
        }),
      }),
    };

    await expect(batcher.flush()).resolves.toBe('0xclaim');
    expect(billing.getQueuedAuthorizationCount()).toBe(0);
    expect(billing.getClaimStats()).toMatchObject({
      settledCount: 2,
      settledAmountMicroUsdc: 50_000n,
      lastClaimTxHash: '0xclaim',
      lastClaimedAmountMicroUsdc: 50_000n,
    });
  }, 15_000);

  it('keeps insufficient-balance skips in the queue for a retry later', async () => {
    const { billing, batcher } = await createFixture();
    const authorization = makeAuthorization();
    billing.queueAuthorization(authorization);

    const iface = new ethers.Interface([
      'event ClaimSkipped(address indexed buyer, address indexed seller, uint256 amount, uint256 nonce, uint8 reason)',
    ]);
    (batcher as any).contract = {
      claim: vi.fn().mockResolvedValue({
        hash: '0xclaim',
        wait: vi.fn().mockResolvedValue({
          status: 1,
          logs: [
            iface.encodeEventLog(iface.getEvent('ClaimSkipped'), [
              authorization.buyer,
              authorization.seller,
              authorization.amount,
              authorization.nonce,
              5,
            ]),
          ].map((log) => ({ ...log, address: poolAddress })),
        }),
      }),
    };

    await expect(batcher.flush()).resolves.toBeNull();
    expect(billing.getQueuedAuthorizationCount()).toBe(1);
    expect(billing.getQueuedAuthorizations()).toEqual([authorization]);
  });

  it.each([null, { status: 0, logs: [] }, { status: 1, logs: [] }])('retains unpaid records when receipt evidence is missing: %j', async receipt => {
    const { billing, batcher } = await createFixture();
    billing.queueAuthorization(makeAuthorization());
    (batcher as any).contract = { claim: vi.fn(async () => ({ hash: '0xunverified', wait: async () => receipt })) };
    await expect(batcher.flush()).resolves.toBeNull();
    expect(billing.getQueuedAuthorizationCount()).toBe(1);
    expect(billing.getClaimStats().settledCount).toBe(0);
  });

  it.each(['wrong-pool', 'wrong-amount'])('does not record income from a mismatched %s event', async kind => {
    const { billing, batcher } = await createFixture();
    const auth = makeAuthorization(); billing.queueAuthorization(auth);
    const iface = new ethers.Interface(['event Claimed(address indexed buyer, address indexed seller, uint256 amount, uint256 nonce)']);
    const log = iface.encodeEventLog(iface.getEvent('Claimed'), [auth.buyer, auth.seller, kind === 'wrong-amount' ? 1n : auth.amount, auth.nonce]);
    (batcher as any).contract = { claim: vi.fn(async () => ({ hash: '0xmismatch', wait: async () => ({ status: 1, logs: [{ ...log, address: kind === 'wrong-pool' ? sellerAddress : poolAddress }] }) })) };
    await expect(batcher.flush()).resolves.toBeNull();
    expect(billing.getQueuedAuthorizationCount()).toBe(1);
    expect(billing.getClaimStats().settledCount).toBe(0);
  });

  it('counts only paid events as income in a batch containing an expired authorization', async () => {
    const { billing, batcher } = await createFixture();
    const paid = makeAuthorization(), expired = makeAuthorization({ nonce: 2n });
    billing.queueAuthorization(paid); billing.queueAuthorization(expired);
    const iface = new ethers.Interface([
      'event Claimed(address indexed buyer, address indexed seller, uint256 amount, uint256 nonce)',
      'event ClaimSkipped(address indexed buyer, address indexed seller, uint256 amount, uint256 nonce, uint8 reason)',
    ]);
    const logs = [
      iface.encodeEventLog(iface.getEvent('Claimed'), [paid.buyer, paid.seller, paid.amount, paid.nonce]),
      iface.encodeEventLog(iface.getEvent('ClaimSkipped'), [expired.buyer, expired.seller, expired.amount, expired.nonce, 2]),
    ].map(log => ({ ...log, address: poolAddress }));
    (batcher as any).contract = { claim: vi.fn(async () => ({ hash: '0xmixed', wait: async () => ({ status: 1, logs }) })) };
    await batcher.flush();
    expect(billing.getQueuedAuthorizationCount()).toBe(0);
    expect(billing.getClaimStats()).toMatchObject({ settledCount: 1, settledAmountMicroUsdc: 25_000n });
  });

  it('retries with a manual gas limit when estimateGas reports intrinsic gas too high', async () => {
    const { billing, batcher } = await createFixture();
    const authorization = makeAuthorization();
    billing.queueAuthorization(authorization);

    const iface = new ethers.Interface([
      'event Claimed(address indexed buyer, address indexed seller, uint256 amount, uint256 nonce)',
    ]);
    const claim = vi
      .fn()
      .mockRejectedValueOnce(new Error('intrinsic gas too high'))
      .mockResolvedValueOnce({
        hash: '0xmanualgas',
        wait: vi.fn().mockResolvedValue({
          status: 1,
          logs: [
            iface.encodeEventLog(iface.getEvent('Claimed'), [
              authorization.buyer,
              authorization.seller,
              authorization.amount,
              authorization.nonce,
            ]),
          ].map((log) => ({ ...log, address: poolAddress })),
        }),
      });

    (claim as any).staticCall = vi.fn().mockResolvedValue(undefined);
    (batcher as any).contract = { claim };

    await expect(batcher.flush()).resolves.toBe('0xmanualgas');
    expect(claim).toHaveBeenNthCalledWith(
      1,
      [
        {
          buyer: authorization.buyer,
          seller: authorization.seller,
          amount: authorization.amount,
          nonce: authorization.nonce,
          expiresAt: authorization.expiresAt,
          poolId: authorization.poolId,
          nonceMode: 1,
        },
      ],
      [authorization.signature],
    );
    expect(claim.staticCall).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenNthCalledWith(
      2,
      [
        {
          buyer: authorization.buyer,
          seller: authorization.seller,
          amount: authorization.amount,
          nonce: authorization.nonce,
          expiresAt: authorization.expiresAt,
          poolId: authorization.poolId,
          nonceMode: 1,
        },
      ],
      [authorization.signature],
      { gasLimit: 750000n },
    );
    expect(billing.getQueuedAuthorizationCount()).toBe(0);
  });

  it('retries with a manual gas limit when estimateGas returns missing revert data', async () => {
    const { billing, batcher } = await createFixture();
    const authorization = makeAuthorization();
    billing.queueAuthorization(authorization);

    const iface = new ethers.Interface([
      'event Claimed(address indexed buyer, address indexed seller, uint256 amount, uint256 nonce)',
    ]);
    const claim = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'missing revert data (action="estimateGas", data=null, reason=null, code=CALL_EXCEPTION)',
        ),
      )
      .mockResolvedValueOnce({
        hash: '0xmanualgas2',
        wait: vi.fn().mockResolvedValue({
          status: 1,
          logs: [
            iface.encodeEventLog(iface.getEvent('Claimed'), [
              authorization.buyer,
              authorization.seller,
              authorization.amount,
              authorization.nonce,
            ]),
          ].map((log) => ({ ...log, address: poolAddress })),
        }),
      });

    (claim as any).staticCall = vi.fn().mockResolvedValue(undefined);
    (batcher as any).contract = { claim };

    await expect(batcher.flush()).resolves.toBe('0xmanualgas2');
    expect(claim.staticCall).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenNthCalledWith(
      2,
      [
        {
          buyer: authorization.buyer,
          seller: authorization.seller,
          amount: authorization.amount,
          nonce: authorization.nonce,
          expiresAt: authorization.expiresAt,
          poolId: authorization.poolId,
          nonceMode: 1,
        },
      ],
      [authorization.signature],
      { gasLimit: 750000n },
    );
    expect(billing.getQueuedAuthorizationCount()).toBe(0);
  });

  it('falls back to the legacy claim ABI when the deployed escrow pool rejects nonceMode tuples', async () => {
    const { billing, batcher } = await createFixture();
    const authorization = makeAuthorization({ nonceMode: 'sequential' as const });
    billing.queueAuthorization(authorization);

    const iface = new ethers.Interface([
      'event Claimed(address indexed buyer, address indexed seller, uint256 amount, uint256 nonce)',
    ]);
    const extendedClaim = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'missing revert data (action="call", data=null, reason=null, code=CALL_EXCEPTION)',
        ),
      );
    const legacyClaim = vi.fn().mockResolvedValue({
      hash: '0xlegacy',
      wait: vi.fn().mockResolvedValue({
          status: 1,
        logs: [
          iface.encodeEventLog(iface.getEvent('Claimed'), [
            authorization.buyer,
            authorization.seller,
            authorization.amount,
            authorization.nonce,
          ]),
        ].map((log) => ({ ...log, address: poolAddress })),
      }),
    });

    (batcher as any).contract = { claim: extendedClaim };
    (batcher as any).legacyContract = { claim: legacyClaim };

    await expect(batcher.flush()).resolves.toBe('0xlegacy');
    expect(extendedClaim).toHaveBeenCalledOnce();
    expect(legacyClaim).toHaveBeenCalledWith(
      [
        {
          buyer: authorization.buyer,
          seller: authorization.seller,
          amount: authorization.amount,
          nonce: authorization.nonce,
          expiresAt: authorization.expiresAt,
          poolId: authorization.poolId,
        },
      ],
      [authorization.signature],
    );
    expect(billing.getQueuedAuthorizationCount()).toBe(0);
  });

  it('skips periodic flushes when the queued amount is below the auto-claim threshold', async () => {
    const { billing, batcher } = await createFixture({ minFlushAmountMicroUsdc: 1_000_000n });
    const authorization = makeAuthorization({ amount: 25_000n });
    billing.queueAuthorization(authorization);
    const claim = vi.fn();
    (batcher as any).contract = { claim };

    await expect(batcher.flush()).resolves.toBeNull();
    expect(claim).not.toHaveBeenCalled();
    expect(billing.getQueuedAuthorizationCount()).toBe(1);
  });

  it('forces a periodic flush when queued authorizations are close to expiry', async () => {
    const { billing, batcher } = await createFixture();
    const authorization = makeAuthorization({
      amount: 25_000n,
      expiresAt: Math.floor(Date.now() / 1000) + 30,
    });
    billing.queueAuthorization(authorization);

    const iface = new ethers.Interface([
      'event Claimed(address indexed buyer, address indexed seller, uint256 amount, uint256 nonce)',
    ]);
    const claim = vi.fn().mockResolvedValue({
      hash: '0xexpiring',
      wait: vi.fn().mockResolvedValue({
          status: 1,
        logs: [
          iface.encodeEventLog(iface.getEvent('Claimed'), [
            authorization.buyer,
            authorization.seller,
            authorization.amount,
            authorization.nonce,
          ]),
        ].map((log) => ({ ...log, address: poolAddress })),
      }),
    });
    (batcher as any).contract = { claim };

    await expect(batcher.flush()).resolves.toBe('0xexpiring');
    expect(claim).toHaveBeenCalledOnce();
    expect(billing.getQueuedAuthorizationCount()).toBe(0);
  });

  it('force-flushes queued authorizations when a queued buyer withdraw request appears in polled logs', async () => {
    const { billing, batcher } = await createFixture();
    const authorization = makeAuthorization();
    billing.queueAuthorization(authorization);

    (batcher as any).wallet = {
      provider: {
        getBlockNumber: vi.fn()
          .mockResolvedValueOnce(100)
          .mockResolvedValueOnce(101),
      },
    };
    (batcher as any).contract = {
      queryFilter: vi.fn().mockResolvedValue([
        {
          args: {
            buyer: authorization.buyer,
            amount: 100_000n,
            unlockAt: BigInt(Math.floor(Date.now() / 1000) + 48 * 3600),
          },
        },
      ]),
    };
    const flush = vi.spyOn(batcher, 'flush').mockResolvedValue('0xforced');

    await (batcher as any).pollWithdrawRequests();
    expect(flush).not.toHaveBeenCalled();

    await (batcher as any).pollWithdrawRequests();
    expect(flush).toHaveBeenCalledWith({ force: true });
    expect((batcher as any).contract.queryFilter).toHaveBeenCalledWith('WithdrawRequested', 101, 101);
  });
});

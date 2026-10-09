import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAYMENT_SCALE } from '@clawmarket/shared';

const units = PAYMENT_SCALE / 1_000_000n;

const {
  createPublicClient,
  formatUnits,
  http,
} = vi.hoisted(() => ({
  createPublicClient: vi.fn(() => ({
    getBalance: vi.fn().mockResolvedValue(500_000_000_000_000n),
    readContract: vi
      .fn()
      .mockResolvedValueOnce('0x00000000000000000000000000000000000000dd')
      .mockResolvedValueOnce(12_500_000n * units),
  })),
  formatUnits: vi.fn((value: bigint, decimals: number) => {
    const divisor = 10n ** BigInt(decimals);
    const whole = value / divisor;
    const fraction = (value % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole.toString();
  }),
  http: vi.fn((url: string) => ({ url })),
}));

vi.mock('viem', () => ({
  createPublicClient,
  formatUnits,
  http,
}));

import { SellerStatusServer } from './seller-status-server.js';
import type { ProviderGateway } from './sidecar.js';

describe('SellerStatusServer', () => {
  let server: SellerStatusServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  function createServer(options: { multiaddrs?: string[]; announcedMultiaddrs?: string[] } = {}) {
    const gateway = {
      publicKey: '0xpublic',
      billing: {
        getQueuedAuthorizationCount: vi.fn(() => 2),
        getQueuedAuthorizationAmount: vi.fn(() => 1_250_000n * units),
        getClaimStats: vi.fn(() => ({
          settledCount: 6,
          settledAmountMicroUsdc: 9_500_000n * units,
          lastClaimTxHash: '0xsettled',
          lastClaimedAt: 1_777_000_000_000,
          lastClaimedAmountMicroUsdc: 3_250_000n * units,
        })),
        getQueuedAuthorizations: vi.fn(() => [
          {
            buyer: '0x00000000000000000000000000000000000000b0',
            seller: '0x00000000000000000000000000000000000000c0',
            amount: 1_250_000n * units,
            nonce: 7n,
            expiresAt: 1_900_000_000,
            poolId: '0xpool',
            signature: '0xsig',
          },
        ]),
      },
      claimBatcher: {
        flush: vi.fn(async () => '0xclaim'),
        getFlushIntervalMs: vi.fn(() => 60_000),
        getMinFlushAmountMicroUsdc: vi.fn(() => 1_000_000n * units),
        getExpirySafetyMs: vi.fn(() => 60_000),
      },
      protection: {
        isAvailable: vi.fn(() => true),
        isOffline: false,
        offlineRemainingSeconds: 0,
        currentConcurrent: 1,
        maxConcurrent: 5,
        dailySpendUsd: 12.5,
        dailyLimitUsd: 400,
      },
      metricsSnapshot: {
        requestsInboundTotal: {
          ok: 4,
          reject: 2,
          error: 1,
        },
        quotesBroadcastTotal: 11,
        utilizationConcurrent: 0.2,
        utilizationWindow: 0.45,
        coolingAccounts: 0,
        circuitOpenAccounts: 0,
      },
      miningReporter: null,
      updateModelPricing: vi.fn(),
    } as unknown as ProviderGateway;

    return {
      gateway,
      server: new SellerStatusServer(
        {
          port: 0,
          apiToken: 'owner-local-token-for-tests-000000000000',
          walletAddress: '0x00000000000000000000000000000000000000c0',
          peerId: '12D3KooWSeller',
          backendMode: 'cliproxy',
          backendUrl: 'http://127.0.0.1:8080',
          models: [{ model: 'gpt-5.4', inputPer1m: 1, outputPer1m: 2, p0: 1.5, alpha: 1.2 }],
          escrowPoolAddress: '0x0000000000000000000000000000000000000001',
          rpcUrl: 'https://sepolia.base.org',
          chainId: 84532,
          miningRewardsAddress: '0x0000000000000000000000000000000000000002',
          clockSkewMs: 1_234,
          getMultiaddrs: () => options.multiaddrs ?? ['/ip4/203.0.113.30/tcp/9090/p2p/12D3KooWSeller'],
          getAnnouncedMultiaddrs: () =>
            options.announcedMultiaddrs ?? ['/ip4/203.0.113.30/tcp/9090/p2p/12D3KooWSeller'],
        },
        gateway,
      ),
    };
  }

  it('returns seller status with claim queue and protection state', async () => {
    const fixture = createServer();
    server = fixture.server;
    await server.start();

    const response = await fetch(`${server.getUrl()}/v1/seller/status`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.seller.walletAddress).toBe('0x00000000000000000000000000000000000000c0');
    expect(body.backend.models).toEqual([{ model: 'gpt-5.4', inputPer1m: 1, outputPer1m: 2, p0: 1.5, alpha: 1.2 }]);
    expect(body.claims).toMatchObject({
      queuedCount: 2,
      queuedAmountMicroUsdc: (1_250_000n * units).toString(),
      queuedAmountUsdc: '1.25',
      lastFlushTxHash: null,
      lastClaimTxHash: '0xsettled',
      lastClaimedAt: 1777000000000,
      lastClaimedAmountMicroUsdc: (3_250_000n * units).toString(),
      lastClaimedAmountUsdc: '3.25',
      settledCount: 6,
      settledAmountMicroUsdc: (9_500_000n * units).toString(),
      settledAmountUsdc: '9.5',
      autoFlushIntervalMs: 60000,
      autoFlushMinAmountMicroUsdc: (1_000_000n * units).toString(),
      autoFlushMinAmountUsdc: '1',
      claimExpirySafetyMs: 60000,
    });
    expect(body.wallet).toMatchObject({
      usdcBalance: '12.5',
      nativeBalance: '0.0005',
      nativeBalanceWei: '500000000000000',
    });
    expect(body.claims.preview[0]).toMatchObject({
      nonce: '7',
      amountMicroUsdc: (1_250_000n * units).toString(),
      amountUsdc: '1.25',
    });
    expect(body.protection).toMatchObject({
      available: true,
      currentConcurrent: 1,
      maxConcurrent: 5,
      dailySpendUsd: 12.5,
      dailyLimitUsd: 400,
    });
    expect(body.metrics).toMatchObject({
      requestsInboundTotal: {
        ok: 4,
        reject: 2,
        error: 1,
      },
      quotesBroadcastTotal: 11,
      utilizationConcurrent: 0.2,
      utilizationWindow: 0.45,
      coolingAccounts: 0,
      circuitOpenAccounts: 0,
    });
    expect(body.clock).toMatchObject({
      skewMs: 1234,
    });
    expect(body.reachability).toMatchObject({
      status: 'public_direct',
      label: '公网可直连',
      publicDirect: true,
      relay: false,
      announced: true,
    });
    expect(body.mining).toMatchObject({
      enabled: false,
      status: 'not_configured',
      rewardsAddress: '0x0000000000000000000000000000000000000002',
    });
  });

  it('flushes queued claims on demand', async () => {
    const fixture = createServer();
    server = fixture.server;
    await server.start();

    const response = await fetch(`${server.getUrl()}/v1/seller/claims/flush`, { method: 'POST', headers: { authorization: 'Bearer owner-local-token-for-tests-000000000000' } });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(fixture.gateway.claimBatcher.flush).toHaveBeenCalledOnce();
    expect(body).toMatchObject({
      flushed: true,
      txHash: '0xclaim',
      claims: {
        queuedCount: 2,
        queuedAmountMicroUsdc: (1_250_000n * units).toString(),
        queuedAmountUsdc: '1.25',
      },
    });
  });

  it('rejects unauthenticated or cross-origin financial actions and authenticates pricing changes', async () => {
    const fixture = createServer(); server = fixture.server; await server.start();
    const headers = { authorization: 'Bearer owner-local-token-for-tests-000000000000', 'content-type': 'application/json' };
    expect((await fetch(`${server.getUrl()}/v1/seller/claims/flush`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${server.getUrl()}/v1/seller/claims/flush`, { method: 'POST', headers: { ...headers, origin: 'http://evil.example' } })).status).toBe(403);
    expect(fixture.gateway.claimBatcher.flush).not.toHaveBeenCalled();
    const result = await fetch(`${server.getUrl()}/v1/seller/pricing`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5.4', p0: 2, maximum: 5 }) });
    expect(result.status).toBe(200);
    expect(fixture.gateway.updateModelPricing).toHaveBeenCalledWith('gpt-5.4', 2, 1.2, 5);
  });

  it('includes the last flush tx hash in seller status', async () => {
    const fixture = createServer();
    server = fixture.server;
    await server.start();

    await fetch(`${server.getUrl()}/v1/seller/claims/flush`, { method: 'POST', headers: { authorization: 'Bearer owner-local-token-for-tests-000000000000' } });
    const response = await fetch(`${server.getUrl()}/v1/seller/status`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.claims.lastFlushTxHash).toBe('0xclaim');
  });

  it('renders a Prometheus metrics endpoint for AIMM health checks', async () => {
    const fixture = createServer();
    server = fixture.server;
    await server.start();

    const response = await fetch(`${server.getUrl()}/metrics`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(body).toContain('aimm_quotes_broadcast_total 11');
    expect(body).toContain('aimm_requests_inbound_total{result="ok"} 4');
    expect(body).toContain('aimm_requests_inbound_total{result="reject"} 2');
    expect(body).toContain('aimm_utilization{layer="concurrent"} 0.2');
    expect(body).toContain('aimm_utilization{layer="window"} 0.45');
    expect(body).toContain('aimm_cooling_accounts 0');
    expect(body).toContain('aimm_circuit_open_accounts 0');
    expect(body).toContain('aimm_clock_skew_ms 1234');
  });

  it('reports relay reachability when only circuit addresses are announced', async () => {
    const fixture = createServer({
      multiaddrs: ['/ip4/127.0.0.1/tcp/9090/p2p/12D3KooWSeller'],
      announcedMultiaddrs: [
        '/ip4/203.0.113.30/tcp/9090/p2p/12D3KooWRelay/p2p-circuit/p2p/12D3KooWSeller',
      ],
    });
    server = fixture.server;
    await server.start();

    const response = await fetch(`${server.getUrl()}/v1/seller/status`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reachability).toMatchObject({
      status: 'relay',
      label: 'relay 可连接',
      publicDirect: false,
      relay: true,
      announced: true,
    });
  });

  it('reports not reachable when only local addresses are available', async () => {
    const fixture = createServer({
      multiaddrs: ['/ip4/127.0.0.1/tcp/9090/p2p/12D3KooWSeller'],
      announcedMultiaddrs: [],
    });
    server = fixture.server;
    await server.start();

    const response = await fetch(`${server.getUrl()}/v1/seller/status`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reachability).toMatchObject({
      status: 'not_reachable',
      label: '暂不可被买家连接',
      publicDirect: false,
      relay: false,
      announced: false,
    });
  });
});

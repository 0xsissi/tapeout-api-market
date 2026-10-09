import { PAYMENT_TOKEN, PAYMENT_NATIVE_SYMBOL, formatPaymentAmount, loadLocalApiToken } from '@clawmarket/shared';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ModelPricing } from '@clawmarket/shared';
import { createPublicClient, formatUnits, http as httpTransport } from 'viem';
import { baseSepolia } from 'viem/chains';

import type { ProviderGateway } from './sidecar.js';

export interface SellerStatusServerConfig {
  port: number;
  host?: string;
  walletAddress: `0x${string}`;
  peerId: string;
  backendMode: string;
  backendUrl: string;
  models: ModelPricing[];
  escrowPoolAddress: `0x${string}`;
  rpcUrl: string;
  chainId: number;
  miningRewardsAddress?: `0x${string}`;
  clockSkewMs?: number | null;
  getMultiaddrs?: () => string[];
  getAnnouncedMultiaddrs?: () => string[];
  apiToken?: string;
}

type SellerReachabilityStatus = 'public_direct' | 'relay' | 'not_reachable';

interface SellerReachabilityPayload {
  status: SellerReachabilityStatus;
  label: string;
  summary: string;
  publicDirect: boolean;
  relay: boolean;
  announced: boolean;
  publicDirectMultiaddrs: string[];
  relayMultiaddrs: string[];
  privateMultiaddrs: string[];
  announcedMultiaddrs: string[];
  checkedAt: number;
}

const ERC20_BALANCE_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export class SellerStatusServer {
  private readonly host: string;
  private server: http.Server | null = null;
  private lastFlushTxHash: `0x${string}` | null = null;

  constructor(
    private readonly config: SellerStatusServerConfig,
    private readonly gateway: ProviderGateway,
  ) {
    this.host = config.host ?? '127.0.0.1';
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error: unknown) => {
        this.writeJson(res, 500, {
          error: 'seller_status_error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.config.port, this.host, () => {
        this.server?.off('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  getUrl(): string {
    if (!this.server) {
      return `http://${this.host}:${this.config.port}`;
    }

    const address = this.server.address();
    if (typeof address === 'object' && address) {
      const info = address as AddressInfo;
      return `http://${this.host}:${info.port}`;
    }
    return `http://${this.host}:${this.config.port}`;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (method === 'POST') {
      const address = this.server?.address();
      const port = typeof address === 'object' && address ? address.port : this.config.port;
      const remote = req.socket.remoteAddress;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '') || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? '') || req.headers.origin) { this.writeJson(res, 403, { error: 'forbidden_origin', message: '管理操作仅允许本机程序调用。' }); return; }
      if (req.headers.authorization !== `Bearer ${this.config.apiToken ?? loadLocalApiToken()}`) { this.writeJson(res, 401, { error: 'local_token_required', message: '需要本机管理令牌。' }); return; }
    }

    if (method === 'OPTIONS') {
      this.writeEmpty(res, 204);
      return;
    }

    if (method === 'GET' && path === '/health') {
      this.writeJson(res, 200, { status: 'ok' });
      return;
    }

    if (method === 'GET' && path === '/v1/seller/status') {
      this.writeJson(res, 200, await this.createStatusPayload());
      return;
    }

    if (method === 'GET' && path === '/metrics') {
      this.writeText(res, 200, renderPrometheusMetrics(this.gateway.metricsSnapshot, this.config.clockSkewMs ?? null));
      return;
    }

    if (method === 'POST' && path === '/v1/seller/claims/flush') {
      await drainRequestBody(req);
      const txHash = await this.gateway.claimBatcher.flush({ force: true });
      this.lastFlushTxHash = txHash as `0x${string}` | null;
      const queuedAmount = this.gateway.billing.getQueuedAuthorizationAmount();
      this.writeJson(res, 200, {
        flushed: Boolean(txHash),
        txHash,
        claims: {
          queuedCount: this.gateway.billing.getQueuedAuthorizationCount(),
          queuedAmountMicroUsdc: queuedAmount.toString(),
          queuedAmountUsdc: formatMicroUsdc(queuedAmount),
        },
      });
      return;
    }

    if (method === 'POST' && path === '/v1/seller/pricing') {
      let text = ''; for await (const chunk of req) { text += chunk.toString(); if (text.length > 4096) { this.writeJson(res, 413, { error: 'invalid_pricing', message: '报价内容过大。' }); return; } }
      try {
        const body = JSON.parse(text);
        const current = this.config.models.find(item => item.model === body.model);
        if (!current || typeof body.p0 !== 'number' || typeof body.maximum !== 'number' || (body.alpha != null && typeof body.alpha !== 'number')) throw new Error('Invalid pricing');
        this.gateway.updateModelPricing(body.model, body.p0, body.alpha ?? current.alpha ?? 1, body.maximum);
        this.writeJson(res, 200, { updated: true, model: body.model, p0: body.p0, alpha: body.alpha ?? current.alpha ?? 1, maximum: body.maximum });
      } catch { this.writeJson(res, 400, { error: 'invalid_pricing', message: '模型或报价参数无效。' }); }
      return;
    }

    this.writeJson(res, 404, {
      error: 'not_found',
      message: `No route for ${method} ${path}`,
    });
  }

  private async createStatusPayload() {
    const queuedAmount = this.gateway.billing.getQueuedAuthorizationAmount();
    const claimStats = this.gateway.billing.getClaimStats();
    const queuedPreview = this.gateway.billing.getQueuedAuthorizations(20).map((item) => ({
      buyer: item.buyer,
      seller: item.seller,
      nonce: item.nonce.toString(),
      expiresAt: item.expiresAt,
      amountMicroUsdc: item.amount.toString(),
      amountUsdc: formatMicroUsdc(item.amount),
    }));
    const walletBalances = await this.readWalletBalances();

    return {
      status: 'ok',
      paymentToken: PAYMENT_TOKEN,
      seller: {
        walletAddress: this.config.walletAddress,
        peerId: this.config.peerId,
        publicKey: this.gateway.publicKey,
      },
      backend: {
        mode: this.config.backendMode,
        url: this.config.backendUrl,
        models: this.config.models.map((item) => ({
          model: item.model,
          inputPer1m: item.inputPer1m,
          outputPer1m: item.outputPer1m,
          p0: item.p0,
          alpha: item.alpha,
        })),
      },
      escrow: {
        poolAddress: this.config.escrowPoolAddress,
        rpcUrl: this.config.rpcUrl,
        chainId: this.config.chainId,
      },
      claims: {
        queuedCount: this.gateway.billing.getQueuedAuthorizationCount(),
        queuedAmountMicroUsdc: queuedAmount.toString(),
        queuedAmountUsdc: formatMicroUsdc(queuedAmount),
        preview: queuedPreview,
        lastFlushTxHash: this.lastFlushTxHash,
        lastClaimTxHash: claimStats.lastClaimTxHash,
        lastClaimedAt: claimStats.lastClaimedAt,
        lastClaimedAmountMicroUsdc: claimStats.lastClaimedAmountMicroUsdc.toString(),
        lastClaimedAmountUsdc: formatMicroUsdc(claimStats.lastClaimedAmountMicroUsdc),
        settledCount: claimStats.settledCount,
        settledAmountMicroUsdc: claimStats.settledAmountMicroUsdc.toString(),
        settledAmountUsdc: formatMicroUsdc(claimStats.settledAmountMicroUsdc),
        autoFlushIntervalMs: this.gateway.claimBatcher.getFlushIntervalMs(),
        autoFlushMinAmountMicroUsdc: this.gateway.claimBatcher.getMinFlushAmountMicroUsdc().toString(),
        autoFlushMinAmountUsdc: formatMicroUsdc(this.gateway.claimBatcher.getMinFlushAmountMicroUsdc()),
        claimExpirySafetyMs: this.gateway.claimBatcher.getExpirySafetyMs(),
      },
      wallet: walletBalances,
      protection: {
        available: this.gateway.protection.isAvailable(),
        offline: this.gateway.protection.isOffline,
        offlineRemainingSeconds: this.gateway.protection.offlineRemainingSeconds,
        currentConcurrent: this.gateway.protection.currentConcurrent,
        maxConcurrent: this.gateway.protection.maxConcurrent,
        dailySpendUsd: this.gateway.protection.dailySpendUsd,
        dailyLimitUsd: this.gateway.protection.dailyLimitUsd,
      },
      clock: {
        skewMs: this.config.clockSkewMs ?? null,
      },
      metrics: this.gateway.metricsSnapshot,
      reachability: this.createReachabilityStatus(),
      mining: this.createMiningStatus(),
    };
  }

  private async readWalletBalances(): Promise<{
    usdcBalance: string;
    nativeBalance: string;
    nativeBalanceWei: string;
  }> {
    const chain = this.config.chainId === 84532
      ? baseSepolia
      : {
          id: this.config.chainId,
          name: 'Custom',
          nativeCurrency: { name: PAYMENT_NATIVE_SYMBOL, symbol: PAYMENT_NATIVE_SYMBOL, decimals: 18 },
          rpcUrls: { default: { http: [this.config.rpcUrl] } },
        };
    const client = createPublicClient({
      chain: chain as any,
      transport: httpTransport(this.config.rpcUrl),
    }) as any;

    try {
      const [nativeBalanceWei, usdcBalanceRaw] = await Promise.all([
        client.getBalance({ address: this.config.walletAddress }),
        client.readContract({
          address: this.config.escrowPoolAddress,
          abi: [
            {
              inputs: [],
              name: 'usdc',
              outputs: [{ name: '', type: 'address' }],
              stateMutability: 'view',
              type: 'function',
            },
          ] as const,
          functionName: 'usdc',
        }).then((tokenAddress: `0x${string}`) => client.readContract({
          address: tokenAddress,
          abi: ERC20_BALANCE_ABI,
          functionName: 'balanceOf',
          args: [this.config.walletAddress],
        })),
      ]);

      return {
        usdcBalance: formatUnits(usdcBalanceRaw as bigint, PAYMENT_TOKEN.decimals),
        nativeBalance: formatUnits(nativeBalanceWei as bigint, 18),
        nativeBalanceWei: (nativeBalanceWei as bigint).toString(),
      };
    } catch {
      return {
        usdcBalance: '0',
        nativeBalance: '0',
        nativeBalanceWei: '0',
      };
    }
  }

  private createReachabilityStatus(): SellerReachabilityPayload {
    const rawMultiaddrs = dedupeStrings(this.config.getMultiaddrs?.() ?? []);
    const announcedMultiaddrs = dedupeStrings(this.config.getAnnouncedMultiaddrs?.() ?? []);
    const sourceMultiaddrs = dedupeStrings([...announcedMultiaddrs, ...rawMultiaddrs]);
    const relayMultiaddrs = sourceMultiaddrs.filter(isRelayMultiaddr);
    const publicDirectMultiaddrs = sourceMultiaddrs.filter(
      (addr) => !isRelayMultiaddr(addr) && isPublicMultiaddr(addr),
    );
    const privateMultiaddrs = rawMultiaddrs.filter(
      (addr) => !isRelayMultiaddr(addr) && !isPublicMultiaddr(addr),
    );
    const announced = announcedMultiaddrs.length > 0;

    if (publicDirectMultiaddrs.length > 0) {
      return {
        status: 'public_direct',
        label: '公网可直连',
        summary: '买家可以优先尝试直接连接这个 seller；relay 仍可作为备用路径。',
        publicDirect: true,
        relay: relayMultiaddrs.length > 0,
        announced,
        publicDirectMultiaddrs,
        relayMultiaddrs,
        privateMultiaddrs,
        announcedMultiaddrs,
        checkedAt: Date.now(),
      };
    }

    if (relayMultiaddrs.length > 0) {
      return {
        status: 'relay',
        label: 'relay 可连接',
        summary: 'seller 当前通过公网 relay 暴露给买家，适合内网机器当卖家。',
        publicDirect: false,
        relay: true,
        announced,
        publicDirectMultiaddrs,
        relayMultiaddrs,
        privateMultiaddrs,
        announcedMultiaddrs,
        checkedAt: Date.now(),
      };
    }

    return {
      status: 'not_reachable',
      label: '暂不可被买家连接',
      summary: announced
        ? 'seller 已有公告地址，但没有公网直连或 relay 地址；买家大概率无法拨入。'
        : 'seller 只监听本机/内网地址，尚未发布可被公网买家拨入的地址。',
      publicDirect: false,
      relay: false,
      announced,
      publicDirectMultiaddrs,
      relayMultiaddrs,
      privateMultiaddrs,
      announcedMultiaddrs,
      checkedAt: Date.now(),
    };
  }

  private createMiningStatus() {
    if (this.gateway.miningReporter) {
      return {
        enabled: true,
        status: 'configured',
        rewardsAddress: this.config.miningRewardsAddress ?? null,
      };
    }

    if (this.config.miningRewardsAddress) {
      return {
        enabled: false,
        status: 'not_configured',
        rewardsAddress: this.config.miningRewardsAddress,
        reason: 'MiningReporter is not active in ProviderGateway yet; seller status only exposes claim queue state.',
      };
    }

    return {
      enabled: false,
      status: 'not_configured',
      rewardsAddress: null,
      reason: 'MINING_REWARDS_ADDRESS is not set for this seller process.',
    };
  }

  private writeJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
    if (res.headersSent) return;
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(),
    });
    res.end(`${JSON.stringify(payload)}\n`);
  }

  private writeText(res: http.ServerResponse, statusCode: number, payload: string): void {
    if (res.headersSent) return;
    res.writeHead(statusCode, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(),
    });
    res.end(payload);
  }

  private writeEmpty(res: http.ServerResponse, statusCode: number): void {
    if (res.headersSent) return;
    res.writeHead(statusCode, corsHeaders());
    res.end();
  }
}

async function drainRequestBody(req: http.IncomingMessage): Promise<void> {
  for await (const _chunk of req) {
    // The flush endpoint does not need a body, but draining keeps HTTP clients happy.
  }
}

function formatMicroUsdc(value: bigint): string { return formatPaymentAmount(value); }

function renderPrometheusMetrics(
  snapshot: ProviderGateway['metricsSnapshot'],
  clockSkewMs: number | null,
): string {
  const lines = [
    '# HELP aimm_quotes_broadcast_total Total quotes broadcast by this seller runtime.',
    '# TYPE aimm_quotes_broadcast_total counter',
    `aimm_quotes_broadcast_total ${snapshot.quotesBroadcastTotal}`,
    '# HELP aimm_requests_inbound_total Total inbound provider requests grouped by terminal result.',
    '# TYPE aimm_requests_inbound_total counter',
    `aimm_requests_inbound_total{result="ok"} ${snapshot.requestsInboundTotal.ok}`,
    `aimm_requests_inbound_total{result="reject"} ${snapshot.requestsInboundTotal.reject}`,
    `aimm_requests_inbound_total{result="error"} ${snapshot.requestsInboundTotal.error}`,
    '# HELP aimm_utilization Current AIMM utilization by layer.',
    '# TYPE aimm_utilization gauge',
    `aimm_utilization{layer="concurrent"} ${snapshot.utilizationConcurrent}`,
    `aimm_utilization{layer="window"} ${snapshot.utilizationWindow}`,
    '# HELP aimm_cooling_accounts Provider-level upstream quota cooling gate count.',
    '# TYPE aimm_cooling_accounts gauge',
    `aimm_cooling_accounts ${snapshot.coolingAccounts}`,
    '# HELP aimm_circuit_open_accounts Provider-level sustained-high-utilization circuit count.',
    '# TYPE aimm_circuit_open_accounts gauge',
    `aimm_circuit_open_accounts ${snapshot.circuitOpenAccounts}`,
  ];

  if (typeof clockSkewMs === 'number' && Number.isFinite(clockSkewMs)) {
    lines.push(
      '# HELP aimm_clock_skew_ms Absolute local clock skew measured at process start.',
      '# TYPE aimm_clock_skew_ms gauge',
      `aimm_clock_skew_ms ${Math.abs(clockSkewMs)}`,
    );
  }

  return `${lines.join('\n')}\n`;
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value).trim()).filter(Boolean)));
}

function isRelayMultiaddr(value: string): boolean {
  return value.includes('/p2p-circuit');
}

function isPublicMultiaddr(value: string): boolean {
  const dnsHost = extractMultiaddrSegment(value, 'dns4') ?? extractMultiaddrSegment(value, 'dns6');
  if (dnsHost) {
    return true;
  }

  const ipv4Host = extractMultiaddrSegment(value, 'ip4');
  if (ipv4Host) {
    return isPublicIpv4(ipv4Host);
  }

  const ipv6Host = extractMultiaddrSegment(value, 'ip6');
  if (ipv6Host) {
    return isPublicIpv6(ipv6Host);
  }

  return false;
}

function extractMultiaddrSegment(value: string, protocol: string): string | null {
  const marker = `/${protocol}/`;
  const start = value.indexOf(marker);
  if (start === -1) {
    return null;
  }

  const rest = value.slice(start + marker.length);
  const end = rest.indexOf('/');
  return end === -1 ? rest : rest.slice(0, end);
}

function isPublicIpv4(host: string): boolean {
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b, c] = parts;
  if (a === undefined || b === undefined || c === undefined) return false;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIpv6(host: string): boolean {
  const normalised = host.toLowerCase();
  if (normalised === '::' || normalised === '::1') {
    return false;
  }
  if (normalised.startsWith('fc') || normalised.startsWith('fd')) {
    return false;
  }
  if (
    normalised.startsWith('fe8') ||
    normalised.startsWith('fe9') ||
    normalised.startsWith('fea') ||
    normalised.startsWith('feb')
  ) {
    return false;
  }
  return true;
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization',
  };
}

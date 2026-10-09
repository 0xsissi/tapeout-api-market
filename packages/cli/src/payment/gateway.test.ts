import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTRACTS, PAYMENT_TOKEN } from '@clawmarket/shared';
import { assertGatewaySettlement } from './gateway.js';
import { executePurchase, executeWithdrawCancel, requestChat } from '../services/buyer.js';
import { executeFlushClaims } from '../services/seller.js';
import { AgentController, localAgentBackend } from '../agent/controller.js';
import { AgentStore, defaultAgentPolicy } from '../agent/store.js';
import { getCliDefaults } from '../config/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('gateway settlement identity', () => {
  const pool = process.env.ESCROW_POOL_ADDRESS ?? CONTRACTS.ESCROW_POOL;
  const valid = { paymentToken: PAYMENT_TOKEN, escrowPool: pool };
  it('requires currency, token address, precision, chain and pool to agree', () => {
    expect(() => assertGatewaySettlement(valid)).not.toThrow();
    expect(() => assertGatewaySettlement({ ...valid, chainId: 1 })).toThrow('已停止操作');
    for (const payload of [{}, { ...valid, paymentToken: { ...PAYMENT_TOKEN, symbol: 'BEM' } }, { ...valid, paymentToken: { ...PAYMENT_TOKEN, decimals: 8 } }, { ...valid, paymentToken: { ...PAYMENT_TOKEN, chainId: 56 } }, { ...valid, paymentToken: { ...PAYMENT_TOKEN, address: pool } }, { ...valid, escrowPool: '0x2222222222222222222222222222222222222222' }]) expect(() => assertGatewaySettlement(payload)).toThrow('已停止操作');
    expect(() => assertGatewaySettlement({ paymentToken: PAYMENT_TOKEN, escrow: { poolAddress: pool, chainId: PAYMENT_TOKEN.chainId } })).not.toThrow();
  });
  it('never posts a deposit, withdrawal, invocation or claim to an incompatible gateway', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ...valid, paymentToken: { ...PAYMENT_TOKEN, symbol: 'BEM' } })));
    vi.stubGlobal('fetch', fetch);
    await expect(executePurchase('http://127.0.0.1:18080', '1')).rejects.toThrow('已停止操作');
    await expect(executeWithdrawCancel('http://127.0.0.1:18080')).rejects.toThrow();
    await expect(requestChat({ url: 'http://127.0.0.1:18080', model: 'model', promptText: 'hello' })).rejects.toThrow();
    await expect(executeFlushClaims('http://127.0.0.1:8787')).rejects.toThrow();
    expect(fetch.mock.calls.every(call => !call[1] || (call[1] as RequestInit).method !== 'POST')).toBe(true);
  });
  it('records an AI currency mismatch as a rejected action and releases its reserved budget', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tam-gateway-test-'));
    try {
      const config = getCliDefaults();
      const store = new AgentStore(dir, 'fixture');
      store.savePolicy({ ...defaultAgentPolicy(), paused: false, allowedActions: ['invoke'], models: ['model'], dailySpendToken: '1', maxCallToken: '1' });
      const fetch = vi.fn(async () => new Response(JSON.stringify({ paymentToken: { ...PAYMENT_TOKEN, symbol: 'BEM' }, escrowPool: pool })));
      vi.stubGlobal('fetch', fetch);
      const controller = new AgentController(store, localAgentBackend(config));
      const result = await controller.execute({ id: 'wrong-currency', action: 'invoke', params: { model: 'model', messages: [{ role: 'user', content: 'hello' }] } });
      expect(result.operation.status).toBe('failed'); expect(store.budget().reservedToken).toBe('0'); expect(fetch).toHaveBeenCalledTimes(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

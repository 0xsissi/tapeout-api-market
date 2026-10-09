import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentError, AgentStore, defaultAgentPolicy } from './store.js';
import { AgentController, agentStoreFor, type AgentBackend } from './controller.js';
import { getCliDefaults } from '../config/store.js';

const directories: string[] = [], servers: AgentController[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tam-agent-test-')); directories.push(dir);
  const store = new AgentStore(dir, 'test-wallet:test-pool');
  store.savePolicy({ ...defaultAgentPolicy(), paused: false, allowedActions: ['invoke', 'deposit', 'collect', 'price'], dailySpendToken: '2', maxCallToken: '1', dailyDepositToken: '5', models: ['model-a'], sellerPrice: { minimum: 1, maximum: 10, maxChangePercent: 10, minIntervalSeconds: 60 } });
  const backend: AgentBackend = { status: vi.fn(async () => ({ buyer: { address: '0xbuyer' }, seller: { backend: { models: [{ model: 'model-a', p0: 5 }] } }, network: {} })), execute: vi.fn(async request => request.action === 'invoke' ? { id: 'request-a', choices: [{ message: { content: 'PRIVATE_RESPONSE' } }], tamSettlement: { amountToken: '0.25', seller: '0xseller' } } : request.action === 'collect' ? { flushed: true, txHash: '0xabc' } : { depositTx: '0xabc' }) };
  return { store, backend, controller: new AgentController(store, backend) };
}
const invoke = (id: string) => ({ id, action: 'invoke' as const, params: { model: 'model-a', messages: [{ role: 'user', content: `PRIVATE_PROMPT_${id}` }] }, reason: '价格符合主人预算' });
describe('AI management rules and recovery', () => {
  it('reserves concurrent requests before execution and charges the confirmed amount', async () => {
    const { store, backend, controller } = setup();
    const finishers: Array<(result: unknown) => void> = [];
    (backend.execute as any).mockImplementation(() => new Promise(resolve => { finishers.push(resolve); }));
    const running = controller.execute(invoke('one'));
    expect(store.budget()).toMatchObject({ reservedToken: '1', remainingToken: '1' });
    const runningTwo = controller.execute(invoke('two'));
    expect(store.budget().remainingToken).toBe('0');
    await expect(controller.execute(invoke('three'))).rejects.toThrow('预算');
    // The first request remains reserved if its process disappears, even after a restart.
    const restarted = new AgentStore(store.directory, store.scope);
    expect(restarted.budget().reservedToken).toBe('2');
    finishers[1]!({ id: 'request-b', tamSettlement: { amountToken: '0.25', seller: '0xseller' } });
    await runningTwo;
    expect(restarted.budget()).toMatchObject({ spentToken: '0.25', reservedToken: '1' });
    finishers[0]!({ id: 'request-a', tamSettlement: { amountToken: '0.25', seller: '0xseller' } });
    await running;
    expect(restarted.budget()).toMatchObject({ spentToken: '0.5', reservedToken: '0' });
  });
  it('replays an operation without a second payment and never persists prompts or output', async () => {
    const { store, backend, controller } = setup();
    expect((await controller.execute(invoke('same'))).operation.status).toBe('succeeded');
    expect((await controller.execute(invoke('same'))).replay).toBe(true);
    expect(backend.execute).toHaveBeenCalledTimes(1);
    await expect(controller.execute({ ...invoke('same'), params: { model: 'model-a', messages: [] } })).rejects.toThrow('不同参数');
    const journal = readFileSync(store.statePath, 'utf8');
    expect(journal).not.toContain('PRIVATE_PROMPT'); expect(journal).not.toContain('PRIVATE_RESPONSE');
    expect(store.budget()).toMatchObject({ spentToken: '0.25', remainingToken: '1.75' });
  });
  it('holds uncertain payments across a new UTC day and rejects retries with another ID', async () => {
    const { store, backend, controller } = setup();
    store.savePolicy({ ...store.policy(), dailySpendToken: '1' });
    (backend.execute as any).mockRejectedValue(new Error('lost response'));
    expect((await controller.execute(invoke('unknown'))).operation.status).toBe('uncertain');
    await expect(controller.execute({ ...invoke('unknown'), id: 'new-id-same-request' })).rejects.toThrow('同样的操作');
    await expect(controller.execute({ id: 'reordered', action: 'invoke', params: { messages: invoke('unknown').params.messages, model: 'model-a' } })).rejects.toThrow('同样的操作');
    const state = JSON.parse(readFileSync(store.statePath, 'utf8'));
    state.operations[0].createdAt = new Date(Date.now() - 86_400_000).toISOString(); writeFileSync(store.statePath, JSON.stringify(state));
    expect(store.budget().remainingToken).toBe('0');
    await expect(controller.execute(invoke('different'))).rejects.toThrow('预算');
  });
  it('checks deposit budgets, model permissions, pause and seller pricing limits', async () => {
    const { store, backend, controller } = setup();
    await expect(controller.execute({ id: 'large', action: 'deposit', params: { amountToken: '6' } })).rejects.toThrow('充值额度');
    await expect(controller.execute({ ...invoke('other-model'), params: { model: 'model-b' } })).rejects.toThrow('模型');
    expect((await controller.execute({ id: 'floor', action: 'price', params: { model: 'model-a', p0: 0.5 } })).operation.status).toBe('failed');
    expect((await controller.execute({ id: 'jump', action: 'price', params: { model: 'model-a', p0: 6 } })).operation.status).toBe('failed');
    expect((await controller.execute({ id: 'safe-price', action: 'price', params: { model: 'model-a', p0: 5.25 } })).operation.status).toBe('succeeded');
    expect(backend.execute).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ maximum: 10 }) }), '1');
    await expect(controller.execute({ id: 'fast-price', action: 'price', params: { model: 'model-a', p0: 5.1 } })).rejects.toThrow('频繁');
    store.savePolicy({ ...store.policy(), paused: true });
    await expect(controller.execute(invoke('paused'))).rejects.toThrow('暂停');
  });
  it('fails closed for corrupt journals and prevents reusing another wallet scope', () => {
    const { store } = setup(); store.begin(invoke('pending'), '1');
    expect(() => new AgentStore(store.directory, 'another-wallet').budget()).toThrow('不匹配');
    writeFileSync(store.statePath, '{'); expect(() => store.budget()).toThrow();
  });
  it('preserves outstanding reservations from the original default USDC journal on upgrade', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tam-agent-upgrade-')); directories.push(dir);
    const config = getCliDefaults({ homeDir: dir });
    const oldScope = `${config.paths.walletPath}|${config.buyer.url}|${config.seller.url}|84532|default`;
    const original = new AgentStore(config.paths.dataDir, oldScope);
    original.savePolicy({ ...defaultAgentPolicy(), paused: false, allowedActions: ['invoke'], models: ['model-a'], dailySpendToken: '2', maxCallToken: '1' });
    original.begin(invoke('old-pending'), '1');
    const upgraded = agentStoreFor(config);
    expect(upgraded.budget()).toMatchObject({ reservedToken: '1', remainingToken: '1' });
    upgraded.finish('old-pending', 'uncertain', '保留原额度');
    expect(upgraded.operations()[0]?.status).toBe('uncertain');
    expect(upgraded.budget().reservedToken).toBe('1');
    expect(() => agentStoreFor({ ...config, settlement: { ...config.settlement, escrowPoolAddress: '0x2222222222222222222222222222222222222222' } }).budget()).toThrow('不匹配');
  });
  it('retains reservations for missing or excessive fee receipts and releases explicit rejected calls', async () => {
    const { store, backend, controller } = setup();
    (backend.execute as any).mockResolvedValueOnce({ id: 'no-fee' }).mockResolvedValueOnce({ id: 'too-much', tamSettlement: { amountToken: '3', seller: '0xseller' } });
    expect((await controller.execute(invoke('missing'))).operation.status).toBe('uncertain');
    expect((await controller.execute(invoke('excessive'))).operation.status).toBe('uncertain');
    expect(store.budget().reservedToken).toBe('2');
    store.savePolicy({ ...store.policy(), dailySpendToken: '3' });
    (backend.execute as any).mockRejectedValueOnce(new AgentError('budget_exceeded', '调用被网关拒绝', 400));
    expect((await controller.execute(invoke('rejected'))).operation.status).toBe('failed');
    expect(store.budget()).toMatchObject({ reservedToken: '2', remainingToken: '1' });
  });
  it('authenticates HTTP tools and actions, rejects browser origins and offers no policy mutation route', async () => {
    const { store, controller } = setup(); servers.push(controller);
    const url = await controller.start(0), headers = { authorization: `Bearer ${store.token()}`, 'content-type': 'application/json' };
    expect((await fetch(`${url}/v1/tam/status`)).status).toBe(401);
    expect((await fetch(`${url}/v1/tam/status`, { headers: { ...headers, origin: 'http://evil.example' } })).status).toBe(403);
    expect((await fetch(`${url}/v1/tam/policy`, { method: 'POST', headers, body: '{}' })).status).toBe(404);
    const tools = await (await fetch(`${url}/v1/tam/tools`, { headers })).json() as any; expect(tools.actions.map((x: any) => x.name)).toContain('invoke');
    expect(tools.functionTools[0].function.parameters.properties.params.required).toContain('model');
    const action = await (await fetch(`${url}/v1/tam/actions`, { method: 'POST', headers, body: JSON.stringify(invoke('http-one')) })).json() as any;
    expect(action.operation.status).toBe('succeeded');
    const status = await (await fetch(`${url}/v1/tam/status`, { headers })).json() as any;
    expect(status.budget.spentToken).toBe('0.25'); expect(JSON.stringify(status)).not.toContain(store.token());
  });
});

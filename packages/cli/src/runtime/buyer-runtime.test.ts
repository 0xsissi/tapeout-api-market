import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({ createWriteStream: vi.fn(() => new PassThrough()) }));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(async () => {}), readFile: vi.fn(async () => 'fixture log') }));
vi.mock('../payment/runtime.js', () => ({ prepareSettlementRuntime: vi.fn(async () => ({ CHAIN_ID: '97' })) }));
vi.mock('../payment/gateway.js', async () => ({
  ...await vi.importActual<typeof import('../payment/gateway.js')>('../payment/gateway.js'),
  checkGatewaySettlement: vi.fn(async () => {}),
}));
vi.mock('../services/http.js', () => ({
  getServiceStatus: vi.fn(async () => ({ online: false, message: 'offline' })),
  fetchJson: vi.fn(async () => ({ address: '0x1111111111111111111111111111111111111111' })),
}));
vi.mock('../wallet/store.js', async () => ({
  ...await vi.importActual<typeof import('../wallet/store.js')>('../wallet/store.js'),
  ensureStoredWallet: vi.fn(async () => ({ created: false, wallet: { address: '0x1111111111111111111111111111111111111111', privateKey: 'fixture-key' } })),
}));
vi.mock('../utils.js', async () => ({
  ...await vi.importActual<typeof import('../utils.js')>('../utils.js'),
  fileExists: vi.fn(async () => false),
  waitForService: vi.fn(async () => true),
}));
vi.mock('./process.js', () => ({ spawnManagedProcess: vi.fn(), stopProcessTree: vi.fn(async (child: ChildProcess) => { Object.assign(child, { exitCode: 0 }); child.emit('exit', 0); }) }));

import { getCliDefaults } from '../config/store.js';
import { PAYMENT_TOKEN, CONTRACTS } from '@clawmarket/shared';
import { getDefaultBuyerRuntimeOptions, getManagedBuyerRuntime, startBuyerRuntime, stopBuyerRuntime } from './buyer-runtime.js';
import { spawnManagedProcess, stopProcessTree } from './process.js';
import { prepareSettlementRuntime } from '../payment/runtime.js';
import { checkGatewaySettlement } from '../payment/gateway.js';
import { fetchJson, getServiceStatus } from '../services/http.js';
import { waitForService } from '../utils.js';

const options = () => ({ ...getDefaultBuyerRuntimeOptions(getCliDefaults({ homeDir: '/fixture/tam-home', cwd: '/fixture/tam' })), report: vi.fn() });
function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null, killed: false, stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcess;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(spawnManagedProcess).mockImplementation(() => fakeChild());
  vi.mocked(getServiceStatus).mockResolvedValue({ online: false, message: 'offline' });
  vi.mocked(fetchJson).mockResolvedValue({ address: '0x1111111111111111111111111111111111111111' });
  vi.mocked(waitForService).mockResolvedValue(true);
  vi.stubEnv('BUYER_PRIVATE_KEY', '');
});
afterEach(async () => { await stopBuyerRuntime(); vi.unstubAllEnvs(); });

describe('buyer runtime', () => {
  it('uses buyer subscribed models for refresh and discoverable lists', () => {
    const config = getCliDefaults({ homeDir: '/tmp/clawmarket-home', cwd: '/tmp/clawmarket-workspace' });
    config.buyer.subscribedModels = ['gpt-5.4', 'claude-sonnet-4', 'gpt-5.4'];

    const options = getDefaultBuyerRuntimeOptions(config);

    expect(options.refreshModels).toEqual(['gpt-5.4', 'claude-sonnet-4']);
    expect(options.discoverableModels).toEqual(['gpt-5.4', 'claude-sonnet-4']);
    expect(options.bootstrapPeers).toEqual(config.network.bootstrapPeers);
  });

  it('shares startup while deployment validation is pending, then spawns once', async () => {
    let resolve!: (env: NodeJS.ProcessEnv) => void;
    vi.mocked(prepareSettlementRuntime).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const first = startBuyerRuntime(options());
    const second = startBuyerRuntime(options());
    expect(second).toBe(first);
    await vi.waitFor(() => expect(prepareSettlementRuntime).toHaveBeenCalledTimes(1));
    expect(spawnManagedProcess).not.toHaveBeenCalled();
    resolve({ CHAIN_ID: '97' });
    await Promise.all([first, second]);
    expect(spawnManagedProcess).toHaveBeenCalledTimes(1);
    expect(getManagedBuyerRuntime()).not.toBeNull();
  });

  it('reuses a matching external buyer without starting or stopping it', async () => {
    vi.mocked(getServiceStatus).mockResolvedValue({ online: true, message: 'online' });
    const config = options();
    await startBuyerRuntime(config);
    expect(checkGatewaySettlement).toHaveBeenCalledWith(config.url, 'buyer', config.settlement?.escrowPoolAddress);
    expect(config.report).toHaveBeenCalledWith(`已连接现有买家：${config.url}`);
    expect(prepareSettlementRuntime).not.toHaveBeenCalled();
    expect(spawnManagedProcess).not.toHaveBeenCalled();
    expect(await stopBuyerRuntime()).toBe(false);
    expect(stopProcessTree).not.toHaveBeenCalled();
  });

  it('reuses identity metadata without waiting for a wallet balance RPC', async () => {
    vi.mocked(getServiceStatus).mockResolvedValue({ online: true, message: 'online' });
    vi.mocked(fetchJson).mockResolvedValue({ address: '0x1111111111111111111111111111111111111111', paymentToken: PAYMENT_TOKEN, escrowPool: CONTRACTS.ESCROW_POOL });
    const onProgress = vi.fn();
    await startBuyerRuntime({ ...options(), onProgress });
    expect(checkGatewaySettlement).not.toHaveBeenCalled();
    expect(prepareSettlementRuntime).not.toHaveBeenCalled();
    expect(onProgress.mock.calls).toEqual([['checking'], ['verifying'], ['ready']]);
  });

  it('rejects incompatible identity metadata instead of falling back to a balance endpoint', async () => {
    vi.mocked(getServiceStatus).mockResolvedValue({ online: true, message: 'online' });
    vi.mocked(fetchJson).mockResolvedValue({ address: '0x1111111111111111111111111111111111111111', paymentToken: { ...PAYMENT_TOKEN, chainId: 1 }, escrowPool: CONTRACTS.ESCROW_POOL });
    await expect(startBuyerRuntime(options())).rejects.toThrow('已停止操作');
    expect(checkGatewaySettlement).not.toHaveBeenCalled();
    expect(spawnManagedProcess).not.toHaveBeenCalled();
  });

  it('rejects an existing buyer using another wallet without taking it over', async () => {
    vi.mocked(getServiceStatus).mockResolvedValue({ online: true, message: 'online' });
    vi.mocked(fetchJson).mockResolvedValue({ address: '0x2222222222222222222222222222222222222222' });
    await expect(startBuyerRuntime(options())).rejects.toThrow('另一个钱包');
    expect(spawnManagedProcess).not.toHaveBeenCalled();
    expect(stopProcessTree).not.toHaveBeenCalled();
  });

  it('rejects a mismatched settlement gateway without spawning a replacement', async () => {
    vi.mocked(getServiceStatus).mockResolvedValue({ online: true, message: 'online' });
    vi.mocked(checkGatewaySettlement).mockRejectedValueOnce(new Error('settlement mismatch'));
    await expect(startBuyerRuntime(options())).rejects.toThrow('settlement mismatch');
    expect(spawnManagedProcess).not.toHaveBeenCalled();
  });

  it('stops a start before spawn even if an earlier RPC finishes later', async () => {
    let resolve!: (env: NodeJS.ProcessEnv) => void;
    vi.mocked(prepareSettlementRuntime).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const start = startBuyerRuntime(options());
    const rejected = expect(start).rejects.toHaveProperty('name', 'AbortError');
    await vi.waitFor(() => expect(prepareSettlementRuntime).toHaveBeenCalledTimes(1));
    expect(await stopBuyerRuntime()).toBe(true);
    await rejected;
    resolve({ CHAIN_ID: '97' });
    await Promise.resolve();
    expect(spawnManagedProcess).not.toHaveBeenCalled();
    await startBuyerRuntime(options());
    expect(spawnManagedProcess).toHaveBeenCalledTimes(1);
  });

  it('cancels readiness and cleans up its process when the console closes', async () => {
    vi.mocked(waitForService).mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const start = startBuyerRuntime({ ...options(), signal: controller.signal });
    const rejected = expect(start).rejects.toHaveProperty('name', 'AbortError');
    await vi.waitFor(() => expect(spawnManagedProcess).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    expect(stopProcessTree).toHaveBeenCalledTimes(1);
    expect(getManagedBuyerRuntime()).toBeNull();
  });

  it('keeps a ready managed buyer when its console re-enters, then stops on explicit exit', async () => {
    const controller = new AbortController();
    await startBuyerRuntime({ ...options(), signal: controller.signal });
    controller.abort();
    expect(getManagedBuyerRuntime()).not.toBeNull();
    expect(stopProcessTree).not.toHaveBeenCalled();
    expect(await stopBuyerRuntime()).toBe(true);
    expect(stopProcessTree).toHaveBeenCalledTimes(1);
  });

  it('releases a failed start so the next attempt can retry on the same port', async () => {
    vi.mocked(waitForService).mockResolvedValueOnce(false);
    await expect(startBuyerRuntime(options())).rejects.toThrow('启动超时');
    expect(stopProcessTree).toHaveBeenCalledTimes(1);
    expect(getManagedBuyerRuntime()).toBeNull();
    await startBuyerRuntime(options());
    expect(spawnManagedProcess).toHaveBeenCalledTimes(2);
  });

  it('reports a child crash immediately rather than waiting the full readiness timeout', async () => {
    vi.mocked(waitForService).mockImplementationOnce(() => new Promise(() => {}));
    const child = fakeChild();
    vi.mocked(spawnManagedProcess).mockReturnValueOnce(child);
    const start = startBuyerRuntime(options());
    const rejected = expect(start).rejects.toThrow('进程在服务就绪前退出');
    await vi.waitFor(() => expect(waitForService).toHaveBeenCalledTimes(1));
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1);
    await rejected;
    expect(getManagedBuyerRuntime()).toBeNull();
  });

  it('does not spawn a local buyer for an unavailable remote gateway', async () => {
    await expect(startBuyerRuntime({ ...options(), url: 'https://remote.example:18380' })).rejects.toThrow('远程买家未连接');
    expect(spawnManagedProcess).not.toHaveBeenCalled();
  });
});

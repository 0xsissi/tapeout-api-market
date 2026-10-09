import net from 'node:net';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';
vi.mock('../payment/runtime.js', () => ({ prepareSettlementRuntime: vi.fn(async () => ({ CHAIN_ID: '97' })) }));

vi.mock('../utils.js', async () => ({
  ...await vi.importActual<typeof import('../utils.js')>('../utils.js'),
  waitForService: vi.fn(async () => true),
}));

import { waitForService } from '../utils.js';
import { buildSellerModelsJson, cancelSellerStartup, createQuotaLogMonitor, getDefaultSellerRuntimeOptions, getManagedSellerRuntime, isPortAvailable, startSellerRuntime, waitForSellerService } from './seller-runtime.js';
import { prepareSettlementRuntime } from '../payment/runtime.js';
import { getCliDefaults } from '../config/store.js';

it('shares seller preparation and cancels it without continuing into a process spawn', async () => {
  let finish!: (value: NodeJS.ProcessEnv) => void;
  vi.mocked(prepareSettlementRuntime).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const onProgress = vi.fn();
  const config = { ...getDefaultSellerRuntimeOptions(getCliDefaults({ homeDir: '/fixture/tam', cwd: '/fixture/tam' })), inputPrice: '1', outputPrice: '1', p0: '1', onProgress, report: vi.fn() };
  const start = startSellerRuntime(config);
  expect(startSellerRuntime({ ...config, onProgress: vi.fn() })).toBe(start);
  const rejected = expect(start).rejects.toHaveProperty('name', 'AbortError');
  await vi.waitFor(() => expect(prepareSettlementRuntime).toHaveBeenCalledOnce());
  await cancelSellerStartup();
  await rejected;
  finish({ CHAIN_ID: '97' });
  await Promise.resolve();
  expect(onProgress.mock.calls).toEqual([['checking'], ['settlement']]);
  expect(getManagedSellerRuntime()).toBeNull();
});

describe('seller readiness', () => {
  const child = () => Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) as unknown as ChildProcess;

  it.each(['exit', 'error'])('returns immediately when the process emits %s and cancels health polling', async event => {
    const process = child();
    vi.mocked(waitForService).mockImplementationOnce(() => new Promise(() => {}));
    const pending = waitForSellerService(process, 'http://127.0.0.1:9087/health');
    const signal = vi.mocked(waitForService).mock.calls.at(-1)![4]!;
    process.emit(event, event === 'error' ? new Error('fixture spawn failed') : 1);
    await expect(pending).resolves.toBe(false);
    expect(signal.aborted).toBe(true);
    expect(process.listenerCount('exit')).toBe(0);
    expect(process.listenerCount('error')).toBe(0);
  });

  it('does not wait for a process that has already exited', async () => {
    const process = child();
    process.exitCode = 1;
    await expect(waitForSellerService(process, 'http://127.0.0.1:9087/health')).resolves.toBe(false);
  });

  it('removes readiness listeners after becoming healthy', async () => {
    const process = child();
    await expect(waitForSellerService(process, 'http://127.0.0.1:9087/health')).resolves.toBe(true);
    expect(process.listenerCount('exit')).toBe(0);
    expect(process.listenerCount('error')).toBe(0);
  });
});

describe('seller runtime quota monitor', () => {
  it('builds explicit MODELS_JSON from configured seller models', () => {
    expect(JSON.parse(buildSellerModelsJson('gpt-5.4, gpt-5.4-mini', '60', '70', '55', '1.5') ?? '[]')).toEqual([
      { model: 'gpt-5.4', inputPer1m: 60 * 55 / 65, outputPer1m: 70 * 55 / 65, p0: 55, alpha: 1.5 },
      { model: 'gpt-5.4-mini', inputPer1m: 60 * 55 / 65, outputPer1m: 70 * 55 / 65, p0: 55, alpha: 1.5 },
    ]);
  });

  it('omits MODELS_JSON when no seller models are configured', () => {
    expect(buildSellerModelsJson('', '60', '70', '55', '1')).toBeUndefined();
  });

  it('reports a quota warning after repeated upstream quota errors', () => {
    const report = vi.fn();
    const onWarning = vi.fn();
    const monitor = createQuotaLogMonitor('codex', report, onWarning);

    monitor('normal startup\n');
    monitor('upstream returned insufficient_quota\n');
    monitor('billing quota exceeded\n');
    monitor('rate_limit_exceeded from upstream\n');

    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toContain('Codex 账号可能额度用完');
    expect(onWarning).toHaveBeenCalledWith(report.mock.calls[0]?.[0]);
  });

  it('detects when a local port is already occupied', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', () => resolve());
    });

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await expect(isPortAvailable(port)).resolves.toBe(false);

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await expect(isPortAvailable(port)).resolves.toBe(true);
  });
});

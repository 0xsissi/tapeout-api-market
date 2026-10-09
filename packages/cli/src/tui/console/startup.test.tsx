import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../runtime/buyer-runtime.js', async () => ({
  ...await vi.importActual<typeof import('../../runtime/buyer-runtime.js')>('../../runtime/buyer-runtime.js'),
  startBuyerRuntime: vi.fn(async () => {}), stopBuyerRuntime: vi.fn(async () => false), cancelBuyerStartup: vi.fn(async () => {}),
}));
vi.mock('../../runtime/seller-runtime.js', async () => ({
  ...await vi.importActual<typeof import('../../runtime/seller-runtime.js')>('../../runtime/seller-runtime.js'),
  startSellerRuntime: vi.fn(async () => {}), stopSellerRuntime: vi.fn(async () => false),
}));
vi.mock('../../services/http.js', () => ({ getServiceStatus: vi.fn(async () => ({ online: false, message: '尚未启动' })) }));
vi.mock('../../wallet/store.js', async () => ({
  ...await vi.importActual<typeof import('../../wallet/store.js')>('../../wallet/store.js'),
  ensureStoredWallet: vi.fn(async () => ({ created: false, wallet: { address: '0x1111111111111111111111111111111111111111' } })),
}));
vi.mock('../../services/buyer.js', () => ({
  loadBuyerSummary: vi.fn(), loadBuyerNetworkStatus: vi.fn(async () => ({ models: [] })),
  requestChatStream: vi.fn(), executePurchase: vi.fn(),
}));

import { getCliDefaults } from '../../config/store.js';
import { startBuyerRuntime, stopBuyerRuntime } from '../../runtime/buyer-runtime.js';
import { startSellerRuntime } from '../../runtime/seller-runtime.js';
import { executePurchase, loadBuyerSummary, requestChatStream } from '../../services/buyer.js';
import { getServiceStatus } from '../../services/http.js';
import { setUiLanguage } from '../../i18n/language.js';
import { ConsoleApp } from './index.js';

beforeEach(() => {
  vi.mocked(startBuyerRuntime).mockReset().mockResolvedValue();
  vi.mocked(startSellerRuntime).mockReset().mockResolvedValue();
  vi.mocked(getServiceStatus).mockReset().mockResolvedValue({ online: false, message: '尚未启动' });
  setUiLanguage('zh');
});
afterEach(() => { cleanup(); vi.clearAllMocks(); setUiLanguage('zh'); });

async function makeConfig() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tam-console-startup-'));
  const config = getCliDefaults({ homeDir: root, cwd: process.cwd() });
  config.settlement = { ...config.settlement!, escrowPoolAddress: '0x1111111111111111111111111111111111111111', maxRequestCostToken: 0.01, maxUnconfirmedCreditToken: 0.01, dailyLimitToken: 1 };
  return config;
}

describe('console buyer startup', () => {
  it('shows the current stage and elapsed time while menus remain available', async () => {
    let finish!: () => void;
    vi.mocked(startBuyerRuntime).mockImplementationOnce(options => {
      options.onProgress?.('settlement');
      return new Promise(resolve => { finish = resolve; });
    });
    const app = render(<ConsoleApp config={await makeConfig()} />);
    Object.defineProperty(app.stdout, 'rows', { value: 32, configurable: true }); app.stdout.emit('resize');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('核对 BSC 测试网和结算合约'));
    await vi.waitFor(() => expect(app.lastFrame()).toMatch(/买家启动中 · [1-9]\d*s/), { timeout: 2500 });
    app.stdin.write('\t');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 余额与充值'));
    expect(app.lastFrame()).toContain('核对 BSC 测试网和结算合约');
    app.stdin.write('l');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Verifying BSC Testnet and escrow contracts'));
    expect(app.lastFrame()).toContain('Starting buyer');
    finish();
    await vi.waitFor(() => expect(app.lastFrame()).not.toContain('Starting buyer'));
  });

  it('shows seller phases across menus and aborts an unfinished start when closed', async () => {
    vi.mocked(startSellerRuntime).mockImplementationOnce(options => {
      options.onProgress?.('proxy-build');
      return new Promise((_, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
    });
    const app = render(<ConsoleApp config={await makeConfig()} />);
    Object.defineProperty(app.stdout, 'rows', { value: 32, configurable: true }); app.stdout.emit('resize');
    await vi.waitFor(() => expect(app.lastFrame()).not.toContain('buyer …'));
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 发送一条聊天消息'));
    app.stdin.write('\u001B[B');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 启动买家服务'));
    app.stdin.write('\u001B[B');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 启动卖家服务'));
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('准备反代依赖和编译缓存'));
    app.stdin.write('\t');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 余额与充值'));
    expect(app.lastFrame()).toContain('卖家启动中');
    const signal = vi.mocked(startSellerRuntime).mock.calls[0]![0].signal!;
    app.unmount();
    expect(signal.aborted).toBe(true);
  });
  it('starts once on entry and keeps navigation and language switching available while connecting', async () => {
    let finish!: () => void;
    vi.mocked(startBuyerRuntime).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const app = render(<ConsoleApp config={await makeConfig()} />);
    Object.defineProperty(app.stdout, 'rows', { value: 32, configurable: true }); app.stdout.emit('resize');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('买家启动中'));
    const activityRow = app.lastFrame()!.split('\n').findIndex(line => line.includes('最近活动'));
    app.stdin.write('\t');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 余额与充值'));
    app.stdin.write('l');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ Wallet & funds'));
    expect(app.lastFrame()).toContain('Starting buyer');
    app.stdin.write('/'); await vi.waitFor(() => expect(app.lastFrame()).toContain('Command Palette'));
    app.stdin.write('Start buyer'); await vi.waitFor(() => expect(app.lastFrame()).toContain('1. Start buyer'));
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).not.toContain('Command Palette'));
    expect(startBuyerRuntime).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(app.lastFrame()).not.toContain('buyer …'));
    expect(app.lastFrame()!.split('\n')).toHaveLength(31);
    expect(app.lastFrame()!.split('\n').findIndex(line => line.includes('Recent activity'))).toBe(activityRow);
    expect(requestChatStream).not.toHaveBeenCalled();
    expect(executePurchase).not.toHaveBeenCalled();
  });

  it('shows connected after startup verifies an existing buyer, with no extra call or deposit', async () => {
    const config = await makeConfig();
    vi.mocked(startBuyerRuntime).mockImplementationOnce(async options => {
      options.report?.(`已连接现有买家：${config.buyer.url}`);
      vi.mocked(getServiceStatus).mockImplementation(async (_url, role) => ({ online: role === 'buyer', message: role === 'buyer' ? 'online' : 'offline' }));
    });
    vi.mocked(loadBuyerSummary).mockResolvedValue([{ status: 'ok', port: 18380, address: '0x1111' }, { address: '0x1111', escrowAvailable: '0' } as Awaited<ReturnType<typeof loadBuyerSummary>>[1]]);
    const app = render(<ConsoleApp config={config} />);
    await vi.waitFor(() => expect(app.lastFrame()).toContain('buyer ●'));
    expect(app.lastFrame()).toContain('已连接现有买家');
    expect(startBuyerRuntime).toHaveBeenCalledTimes(1);
    expect(requestChatStream).not.toHaveBeenCalled();
    expect(executePurchase).not.toHaveBeenCalled();
  });

  it('keeps the console usable after a failure and allows retry from the dashboard', async () => {
    vi.mocked(startBuyerRuntime).mockRejectedValueOnce(new Error('fixture startup failed'));
    const app = render(<ConsoleApp config={await makeConfig()} />);
    await vi.waitFor(() => expect(app.lastFrame()).toContain('fixture startup failed'));
    expect(app.lastFrame()).not.toContain('buyer …');
    app.stdin.write('\r'); await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 发送一条聊天消息'));
    app.stdin.write('\u001B[B'); await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 启动买家服务'));
    app.stdin.write('\r');
    await vi.waitFor(() => expect(startBuyerRuntime).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(app.lastFrame()).not.toContain('操作未完成'));
  });

  it('opens settings rather than guessing missing BEM budgets or a settlement pool', async () => {
    const config = await makeConfig();
    config.settlement!.symbol = 'BEM';
    config.settlement!.maxRequestCostToken = 0;
    config.settlement!.dailyLimitToken = 0;
    const app = render(<ConsoleApp config={config} />);
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 设置'));
    expect(app.lastFrame()).toContain('再启动买家');
    expect(startBuyerRuntime).not.toHaveBeenCalled();
    expect(config.settlement!.maxRequestCostToken).toBe(0);
    expect(executePurchase).not.toHaveBeenCalled();
  });

  it('does not restart a manually stopped buyer on a later refresh or language change', async () => {
    const app = render(<ConsoleApp config={await makeConfig()} />);
    await vi.waitFor(() => expect(startBuyerRuntime).toHaveBeenCalledTimes(1));
    app.stdin.write('/'); await vi.waitFor(() => expect(app.lastFrame()).toContain('Command Palette'));
    app.stdin.write('Stop buyer'); await vi.waitFor(() => expect(app.lastFrame()).toContain('1. Stop buyer'));
    app.stdin.write('\r'); await vi.waitFor(() => expect(stopBuyerRuntime).toHaveBeenCalledTimes(1));
    app.stdin.write('l'); await vi.waitFor(() => expect(app.lastFrame()).toContain('Overview'));
    await new Promise(resolve => setTimeout(resolve, 3100));
    expect(startBuyerRuntime).toHaveBeenCalledTimes(1);
  });

  it('aborts an unfinished startup when the console unmounts', async () => {
    vi.mocked(startBuyerRuntime).mockImplementationOnce(options => new Promise((_, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
    }));
    const app = render(<ConsoleApp config={await makeConfig()} />);
    await vi.waitFor(() => expect(startBuyerRuntime).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(startBuyerRuntime).mock.calls[0]![0].signal!;
    expect(signal.aborted).toBe(false);
    app.unmount();
    expect(signal.aborted).toBe(true);
  });
});

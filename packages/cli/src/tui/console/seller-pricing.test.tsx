import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../runtime/buyer-runtime.js', async () => ({
  ...await vi.importActual<typeof import('../../runtime/buyer-runtime.js')>('../../runtime/buyer-runtime.js'),
  startBuyerRuntime: vi.fn(async () => {}), stopBuyerRuntime: vi.fn(async () => false), cancelBuyerStartup: vi.fn(async () => {}),
}));
vi.mock('../../runtime/seller-runtime.js', async () => ({
  ...await vi.importActual<typeof import('../../runtime/seller-runtime.js')>('../../runtime/seller-runtime.js'),
  startSellerRuntime: vi.fn(async () => {}), stopSellerRuntime: vi.fn(async () => true),
}));
vi.mock('../../runtime/auth-inspector.js', () => ({ inspectAuthDir: vi.fn(async () => ({ hasAuth: false })) }));
vi.mock('../../services/http.js', () => ({ getServiceStatus: vi.fn(async () => ({ online: false, message: 'offline' })) }));
vi.mock('../../services/seller.js', async () => ({
  ...await vi.importActual<typeof import('../../services/seller.js')>('../../services/seller.js'),
  loadSellerSummary: vi.fn(async () => null),
}));
vi.mock('../../wallet/store.js', async () => ({
  ...await vi.importActual<typeof import('../../wallet/store.js')>('../../wallet/store.js'),
  ensureStoredWallet: vi.fn(async () => ({ created: false, wallet: { address: '0x1111111111111111111111111111111111111111' } })),
}));

import { getCliDefaults } from '../../config/store.js';
import { startSellerRuntime, stopSellerRuntime } from '../../runtime/seller-runtime.js';
import { getServiceStatus } from '../../services/http.js';
import { setUiLanguage } from '../../i18n/language.js';
import { ConsoleApp } from './index.js';

beforeEach(() => {
  vi.mocked(startSellerRuntime).mockReset().mockResolvedValue();
  vi.mocked(stopSellerRuntime).mockReset().mockResolvedValue(true);
  vi.mocked(getServiceStatus).mockReset().mockResolvedValue({ online: false, message: 'offline' });
  vi.stubEnv('CLAWMARKET_CONFIG_PATH', '');
  // An empty override is also an explicit path, so remove it for each isolated fixture.
  delete process.env.CLAWMARKET_CONFIG_PATH;
  setUiLanguage('zh');
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllEnvs(); setUiLanguage('zh'); });

async function openSeller() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tam-seller-pricing-'));
  const config = getCliDefaults({ homeDir: root, cwd: process.cwd() });
  config.settlement = { ...config.settlement, escrowPoolAddress: '0x1111111111111111111111111111111111111111' };
  const app = render(<ConsoleApp config={config} />);
  Object.defineProperty(app.stdout, 'rows', { value: 40, configurable: true }); app.stdout.emit('resize');
  await vi.waitFor(() => expect(app.lastFrame()).toContain('最近活动'));
  for (const label of ['余额与充值', '调用体验', '服务市场', 'API 接入', '我的服务']) {
    app.stdin.write('\t');
    await vi.waitFor(() => expect(app.lastFrame()).toContain(`▶ ${label}`));
  }
  app.stdin.write('\r');
  await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 启动 seller'));
  return { app, config };
}

async function editPrice(app: ReturnType<typeof render>) {
  app.stdin.write('p');
  await vi.waitFor(() => expect(app.lastFrame()).toContain('Edit seller p0'));
  app.stdin.write('\u007F');
  await vi.waitFor(() => expect(app.lastFrame()).toMatch(/> 6\s/));
  app.stdin.write('\u007F');
  await vi.waitFor(() => expect(app.lastFrame()).not.toMatch(/> 6\s/));
  app.stdin.write('5');
  await vi.waitFor(() => expect(app.lastFrame()).toMatch(/> 5\s/));
  app.stdin.write('\r');
  await vi.waitFor(() => expect(app.lastFrame()).toContain('Edit seller alpha'));
  app.stdin.write('\r');
  await vi.waitFor(() => expect(app.lastFrame()).toContain('Edit seller maxConcurrent'));
  app.stdin.write('\r');
}

describe('seller pricing navigation', () => {
  it('saves an offline seller without starting it, then returns to the menu', async () => {
    const { app, config } = await openSeller();
    await editPrice(app);
    await vi.waitFor(() => expect(app.lastFrame()).toContain('AIMM 参数已保存'));
    expect(app.lastFrame()).not.toContain('现在重启 seller');
    expect(startSellerRuntime).not.toHaveBeenCalled();
    expect(stopSellerRuntime).not.toHaveBeenCalled();
    const saved = JSON.parse(await readFile(config.paths.configPath, 'utf8'));
    expect(saved.seller.pricing).toEqual({ ...config.seller.pricing, input: 5, output: 5, p0: 5 });
    app.stdin.write('\u001B');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 我的服务'));
    app.stdin.write('\u001B[A');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ API 接入'));
  });

  it('allows navigation during a restart and recovers from failure without losing the saved price', async () => {
    const { app, config } = await openSeller();
    vi.mocked(getServiceStatus).mockImplementation(async (_url, role) => ({ online: role === 'seller', message: 'fixture' }));
    await vi.waitFor(() => expect(app.lastFrame()).toContain('seller ●'), { timeout: 4500 });
    let fail!: (error: Error) => void;
    vi.mocked(startSellerRuntime).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    await editPrice(app);
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 重启'));
    // Ink installs keyboard handlers in passive effects after the rendered frame.
    await new Promise(resolve => setTimeout(resolve, 40));
    app.stdin.write('\r');
    await vi.waitFor(() => expect(startSellerRuntime).toHaveBeenCalledTimes(1));
    expect(app.lastFrame()).not.toContain('现在重启 seller');
    app.stdin.write('\t');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 上游账号'));
    fail(new Error('fixture seller startup failed'));
    await vi.waitFor(() => expect(app.lastFrame()).toContain('fixture seller startup failed'));
    app.stdin.write('\u001B[A');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 我的服务'));
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ Flush claims'));
    app.stdin.write('p');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Edit seller p0'));
    app.stdin.write('\u001B');
    await vi.waitFor(() => expect(app.lastFrame()).not.toContain('Edit seller p0'));
    expect(JSON.parse(await readFile(config.paths.configPath, 'utf8')).seller.pricing.p0).toBe(5);
  });

  it('catches a manual startup error and allows Esc, menu switching and retry', async () => {
    const { app } = await openSeller();
    vi.mocked(startSellerRuntime).mockRejectedValueOnce(new Error('fixture manual startup failed'));
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('fixture manual startup failed'));
    app.stdin.write('\u001B');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 我的服务'));
    app.stdin.write('\t');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 上游账号'));
    app.stdin.write('\u001B[A');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 我的服务'));
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('▶ 启动 seller'));
    app.stdin.write('\r');
    await vi.waitFor(() => expect(startSellerRuntime).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(app.lastFrame()).not.toContain('操作未完成'));
  });
});

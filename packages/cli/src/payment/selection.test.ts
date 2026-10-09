import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractPaymentOption, paymentChoicePath, preparePaymentEnvironment, readPaymentChoice, savePaymentChoice } from './selection.js';
import { needsSettlementConfiguration } from './configuration.js';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
describe('owner currency selection', () => {
  it('extracts a currency override before runtime imports and rejects ambiguous choices', () => {
    expect(extractPaymentOption(['seller', '--payment-token', 'bem', 'start'])).toEqual({ symbol: 'BEM', args: ['seller', 'start'] });
    expect(extractPaymentOption(['--payment-token=USDC', 'config', 'show']).symbol).toBe('USDC');
    for (const args of [['--payment-token'], ['--payment-token=BTC'], ['--payment-token', 'BEM', '--payment-token=USDC']]) expect(() => extractPaymentOption(args)).toThrow();
  });
  it('saves the next-launch choice without modifying either pricing profile', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tam-choice-'));
    expect(await readPaymentChoice(home)).toBeNull();
    await savePaymentChoice('BEM', home);
    const file = path.join(home, '.clawmarket', 'config.json');
    await writeFile(file, JSON.stringify({ settlement: { symbol: 'USDC' }, seller: { pricing: { p0: 60 } } }));
    await savePaymentChoice('USDC', home);
    expect(await readPaymentChoice(home)).toBe('USDC');
    expect(JSON.parse(await readFile(file, 'utf8')).seller.pricing.p0).toBe(60);
    await writeFile(paymentChoicePath(home), '{');
    await expect(readPaymentChoice(home)).rejects.toThrow('选择文件无效');
  });
  it('loads the matching pool before shared protocol constants and preserves explicit environment overrides', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tam-choice-'));
    await mkdir(path.join(home, '.clawmarket'));
    await writeFile(path.join(home, '.clawmarket', 'config-bem.json'), JSON.stringify({ settlement: { symbol: 'BEM', rpcUrl: 'https://rpc.fixture', escrowPoolAddress: '0x1111111111111111111111111111111111111111' } }));
    const env = { HOME: home } as NodeJS.ProcessEnv;
    await preparePaymentEnvironment('BEM', env);
    expect(env).toMatchObject({ CLAWMARKET_PAYMENT_TOKEN: 'BEM', RPC_URL: 'https://rpc.fixture', ESCROW_POOL_ADDRESS: '0x1111111111111111111111111111111111111111' });
    env.RPC_URL = 'https://override.fixture';
    await preparePaymentEnvironment('BEM', env);
    expect(env.RPC_URL).toBe('https://override.fixture');
    env.CLAWMARKET_CONFIG_PATH = path.join(home, '.clawmarket', 'config-bem.json');
    await expect(preparePaymentEnvironment('USDC', env)).rejects.toThrow('配置币种');
  });
  it('keeps BEM prices, limits, identities, seeds, logs and service ports separate from USDC', async () => {
    vi.stubEnv('CLAWMARKET_PAYMENT_TOKEN', 'USDC'); vi.stubEnv('ESCROW_POOL_ADDRESS', ''); vi.resetModules();
    const usdc = (await import('../config/store.js')).getCliDefaults({ homeDir: '/tmp/tam-profile' });
    vi.stubEnv('CLAWMARKET_PAYMENT_TOKEN', 'BEM'); vi.resetModules();
    const bem = (await import('../config/store.js')).getCliDefaults({ homeDir: '/tmp/tam-profile' });
    expect(bem.settlement.symbol).toBe('BEM');
    expect(bem.seller.pricing.p0).toBe(0); expect(bem.settlement.maxRequestCostToken).toBe(0); expect(bem.settlement.dailyLimitToken).toBe(0);
    expect(usdc.seller.pricing.p0).toBe(60);
    expect(needsSettlementConfiguration(bem)).toBe(true); expect(needsSettlementConfiguration(usdc)).toBe(false);
    for (const key of ['url', 'identityPath', 'seedFile', 'p2pPort', 'cliproxyPort'] as const) expect(bem.seller[key]).not.toBe(usdc.seller[key]);
    expect(bem.buyer.url).not.toBe(usdc.buyer.url); expect(bem.paths.dataDir).not.toBe(usdc.paths.dataDir); expect(bem.paths.configPath).not.toBe(usdc.paths.configPath);
    expect(bem.paths.walletPath).toBe(usdc.paths.walletPath); // Same owner wallet, separate chain balances.
  });
  it('does not reuse Base Sepolia configuration or identity files for BSC testnet', async () => {
    vi.stubEnv('CLAWMARKET_PAYMENT_TOKEN', 'USDC'); vi.stubEnv('CLAWMARKET_PAYMENT_NETWORK', 'default'); vi.stubEnv('ESCROW_POOL_ADDRESS', ''); vi.resetModules();
    const base = (await import('../config/store.js')).getCliDefaults({ homeDir: '/tmp/tam-network-profile' });
    vi.stubEnv('CLAWMARKET_PAYMENT_NETWORK', 'bsc-testnet'); vi.resetModules();
    const bsc = (await import('../config/store.js')).getCliDefaults({ homeDir: '/tmp/tam-network-profile' });
    expect(bsc.settlement.network).toBe('bsc-testnet');
    expect(bsc.paths.configPath).not.toBe(base.paths.configPath); expect(bsc.paths.dataDir).not.toBe(base.paths.dataDir);
    expect(bsc.buyer.identityPath).not.toBe(base.buyer.identityPath); expect(bsc.seller.identityPath).not.toBe(base.seller.identityPath);
    expect(bsc.buyer.url).not.toBe(base.buyer.url); expect(bsc.seller.url).not.toBe(base.seller.url);
    expect(bsc.settlement.escrowPoolAddress).not.toBe(base.settlement.escrowPoolAddress);
  });
});

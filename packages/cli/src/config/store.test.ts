import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getCliDefaults,
  getConfigValue,
  loadCliConfig,
  parseConfigValue,
  saveCliConfig,
  setConfigValue,
} from './store.js';

describe('config store', () => {
  it('synchronizes base rates when editing p0 and recomputes p0 when editing a rate', () => {
    const config = getCliDefaults();
    const updated = setConfigValue(config, 'seller.pricing.p0', 5);
    expect(updated.seller.pricing).toMatchObject({ input: 5, output: 5, p0: 5 });
    expect(setConfigValue(updated, 'seller.pricing.output', 9).seller.pricing).toMatchObject({ input: 5, output: 9, p0: 7 });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('loads defaults when config.json does not exist', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-cli-'));

    const config = await loadCliConfig({ homeDir, cwd: '/tmp/workspace' });

    expect(config.buyer.url).toBe('http://127.0.0.1:18080');
    expect(config.buyer.subscribedModels.length).toBeGreaterThan(0);
    expect(config.buyer.minGasWei).toBe('500000000000000');
    expect(config.seller.upstream).toBe('codex');
    expect(config.buyer.selectedModel).toBe('gpt-6.1-sol');
    expect(config.buyer.subscribedModels).toContain('gpt-6.1-sol');
    expect(config.seller.models).toEqual(['gpt-6.1-sol']);
    expect(config.seller.minGasWei).toBe('500000000000000');
    expect(config.paths.configPath).toBe(path.join(homeDir, '.clawmarket', 'config.json'));
  });

  it('saves and reloads config values', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-cli-'));
    const defaults = getCliDefaults({ homeDir, cwd: '/tmp/workspace' });
    const { paths, ...config } = defaults;
    const next = setConfigValue(config, 'buyer.selectedModel', 'gpt-5.4-mini');

    const savedPath = await saveCliConfig(next, { homeDir, cwd: '/tmp/workspace' });
    const raw = JSON.parse(await readFile(savedPath, 'utf8')) as { buyer: { selectedModel: string } };
    const reloaded = await loadCliConfig({ homeDir, cwd: '/tmp/workspace' });

    expect(raw.buyer.selectedModel).toBe('gpt-5.4-mini');
    expect(getConfigValue(reloaded, 'buyer.selectedModel')).toBe('gpt-5.4-mini');
    expect(paths.configPath).toBe(savedPath);
  });

  it('replaces the retired saved bootstrap while preserving community peers and explicit overrides', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'tam-bootstrap-config-'));
    const { paths, ...config } = getCliDefaults({ homeDir, cwd: '/tmp/workspace' });
    const community = '/dns4/community.example.com/tcp/9090/p2p/COMMUNITY';
    const retired = '/dns4/retired.example.com/tcp/9090/p2p/RETIRED';
    vi.stubEnv('TAM_RETIRED_BOOTSTRAP_PEERS', retired);
    config.network.bootstrapPeers = [community, retired];
    await saveCliConfig(config, { homeDir, cwd: '/tmp/workspace' });
    const migrated = await loadCliConfig({ homeDir, cwd: '/tmp/workspace' });
    expect(migrated.network.bootstrapPeers).toContain(community);
    expect(migrated.network.bootstrapPeers).not.toContain(retired);
    vi.stubEnv('CLAWMARKET_BOOTSTRAP_PEERS', community);
    expect((await loadCliConfig({ homeDir, cwd: '/tmp/workspace' })).network.bootstrapPeers).toEqual([community]);
  });

  it('saves and reloads buyer subscribed models', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-cli-'));
    const defaults = getCliDefaults({ homeDir, cwd: '/tmp/workspace' });
    const { paths, ...config } = defaults;
    const next = setConfigValue(config, 'buyer.subscribedModels', ['gpt-5.4', 'claude-sonnet-4']);

    const savedPath = await saveCliConfig(next, { homeDir, cwd: '/tmp/workspace' });
    const raw = JSON.parse(await readFile(savedPath, 'utf8')) as { buyer: { subscribedModels: string[] } };
    const reloaded = await loadCliConfig({ homeDir, cwd: '/tmp/workspace' });

    expect(raw.buyer.subscribedModels).toEqual(['gpt-5.4', 'claude-sonnet-4']);
    expect(getConfigValue(reloaded, 'buyer.subscribedModels')).toEqual(['gpt-5.4', 'claude-sonnet-4']);
    expect(paths.configPath).toBe(savedPath);
  });

  it('parses config values from CLI input', () => {
    expect(parseConfigValue('42')).toBe(42);
    expect(parseConfigValue('true')).toBe(true);
    expect(parseConfigValue('["a","b"]')).toEqual(['a', 'b']);
    expect(parseConfigValue('gpt-5.4')).toBe('gpt-5.4');
  });

  it('fails closed for corrupt config files and invalid settlement overrides', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'tam-config-invalid-'));
    const defaults = getCliDefaults({ homeDir });
    await mkdir(path.dirname(defaults.paths.configPath), { recursive: true });
    await writeFile(defaults.paths.configPath, '{');
    await expect(loadCliConfig({ homeDir })).rejects.toThrow();
    await writeFile(defaults.paths.configPath, JSON.stringify({ settlement: { symbol: 'BEM' } }));
    await expect(loadCliConfig({ homeDir })).rejects.toThrow('币种');
    await writeFile(defaults.paths.configPath, '{}');
    vi.stubEnv('MAX_REQUEST_COST_TOKEN', 'invalid');
    await expect(loadCliConfig({ homeDir })).rejects.toThrow('额度');
  });

  it('applies CLAWMARKET env values as one-time overrides over config.json', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-cli-'));
    const defaults = getCliDefaults({ homeDir, cwd: '/tmp/workspace' });
    const { paths, ...config } = defaults;

    await saveCliConfig({
      ...config,
      buyer: {
        ...config.buyer,
        url: 'http://127.0.0.1:19999',
      },
    }, { homeDir, cwd: '/tmp/workspace' });

    vi.stubEnv('CLAWMARKET_BUYER_URL', 'http://127.0.0.1:18888');

    const reloaded = await loadCliConfig({ homeDir, cwd: '/tmp/workspace' });
    expect(paths.configPath).toBe(path.join(homeDir, '.clawmarket', 'config.json'));
    expect(reloaded.buyer.url).toBe('http://127.0.0.1:18888');
  });

  it('normalizes seller upstream and applies env override', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'clawmarket-cli-'));
    const defaults = getCliDefaults({ homeDir, cwd: '/tmp/workspace' });
    const { paths, ...config } = defaults;

    await saveCliConfig({
      ...config,
      seller: {
        ...config.seller,
        upstream: 'not-real' as any,
      },
    }, { homeDir, cwd: '/tmp/workspace' });

    expect((await loadCliConfig({ homeDir, cwd: '/tmp/workspace' })).seller.upstream).toBe('codex');

    vi.stubEnv('CLAWMARKET_SELLER_UPSTREAM', 'claude');
    expect((await loadCliConfig({ homeDir, cwd: '/tmp/workspace' })).seller.upstream).toBe('claude');
    expect(paths.configPath).toBe(path.join(homeDir, '.clawmarket', 'config.json'));
  });
});

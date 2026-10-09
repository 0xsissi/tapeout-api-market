import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveProviderBackend } from './provider-backend.mjs';

describe('resolveProviderBackend', () => {
  let tempHome;
  let originalHome;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawmarket-provider-backend-'));
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
    vi.unstubAllGlobals();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  it('prefers explicit proxy mode when PROXY_URL is set', async () => {
    const result = await resolveProviderBackend({
      PROXY_URL: 'https://proxy.example.com/cliproxy',
      PROXY_HEADERS_JSON: '{"Authorization":"Bearer proxy"}',
      MODELS_JSON: '[{"model":"gpt-5.4","inputPer1m":2,"outputPer1m":6}]',
      DAILY_LIMIT_USD: '25',
      PROVIDER_REGION: 'local-test',
    });

    expect(result).toEqual({
      backendMode: 'proxy-url',
      backendUrl: 'https://proxy.example.com/cliproxy',
      backendHeaders: { Authorization: 'Bearer proxy' },
      models: [{ model: 'gpt-5.4', inputPer1m: 2, outputPer1m: 6 }],
      dailyLimitUsd: 25,
      region: 'local-test',
    });
  });

  it('supports direct openai-compatible upstream config without cliproxy', async () => {
    const result = await resolveProviderBackend({
      UPSTREAM_BASE_URL: 'https://codex.example.com/openai',
      UPSTREAM_API_KEY: 'secret-token',
      UPSTREAM_MODEL: 'gpt-5.4',
      UPSTREAM_INPUT_PER_1M: '3',
      UPSTREAM_OUTPUT_PER_1M: '9',
    });

    expect(result).toEqual({
      backendMode: 'openai-compatible-direct',
      backendUrl: 'https://codex.example.com/openai',
      backendHeaders: { Authorization: 'Bearer secret-token' },
      models: [{ model: 'gpt-5.4', inputPer1m: 3, outputPer1m: 9 }],
      dailyLimitUsd: 1000,
      region: 'base-sepolia',
    });
  });

  it('discovers models from a proxy /v1/models endpoint when MODELS_JSON is omitted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            { id: 'gemini-2.5-pro' },
            { id: 'claude-sonnet-4' },
            { id: 'gemini-2.5-pro' },
          ],
        }),
      })),
    );

    const result = await resolveProviderBackend({
      PROXY_URL: 'https://proxy.example.com/openai',
      PROXY_INPUT_PER_1M: '7',
      PROXY_OUTPUT_PER_1M: '11',
    });

    expect(result).toEqual({
      backendMode: 'proxy-url',
      backendUrl: 'https://proxy.example.com/openai',
      backendHeaders: undefined,
      models: [
        { model: 'gemini-2.5-pro', inputPer1m: 7, outputPer1m: 11 },
        { model: 'claude-sonnet-4', inputPer1m: 7, outputPer1m: 11 },
      ],
      dailyLimitUsd: 1000,
      region: 'base-sepolia',
    });
  });

  it('discovers all upstream models when no single upstream model is pinned', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            { id: 'gemini-2.5-flash' },
            { id: 'gemini-2.5-pro' },
          ],
        }),
      })),
    );

    const result = await resolveProviderBackend({
      UPSTREAM_BASE_URL: 'https://proxy.example.com/vendor/openai',
      UPSTREAM_API_KEY: 'secret-token',
      UPSTREAM_INPUT_PER_1M: '3',
      UPSTREAM_OUTPUT_PER_1M: '9',
    });

    expect(result).toEqual({
      backendMode: 'openai-compatible-direct',
      backendUrl: 'https://proxy.example.com/vendor/openai',
      backendHeaders: { Authorization: 'Bearer secret-token' },
      models: [
        { model: 'gemini-2.5-flash', inputPer1m: 3, outputPer1m: 9 },
        { model: 'gemini-2.5-pro', inputPer1m: 3, outputPer1m: 9 },
      ],
      dailyLimitUsd: 1000,
      region: 'base-sepolia',
    });
  });

  it('falls back to ~/.clawmarket/seller.json for direct backend config', async () => {
    const sellerDir = path.join(tempHome, '.clawmarket');
    fs.mkdirSync(sellerDir, { recursive: true });
    fs.writeFileSync(
      path.join(sellerDir, 'seller.json'),
      JSON.stringify({
        sourceType: 'api-key',
        model: 'gpt-5.4',
        apiBaseUrl: 'https://codex.example.com/openai',
        apiKey: 'profile-token',
        pricing: { inputPer1m: 1, outputPer1m: 5 },
        dailyLimitUsd: 30,
        region: 'auto',
      }),
    );

    const result = await resolveProviderBackend({});

    expect(result).toEqual({
      backendMode: 'seller-profile',
      backendUrl: 'https://codex.example.com/openai',
      backendHeaders: { Authorization: 'Bearer profile-token' },
      models: [{ model: 'gpt-5.4', inputPer1m: 1, outputPer1m: 5 }],
      dailyLimitUsd: 30,
      region: 'auto',
      sellerProfilePath: path.join(tempHome, '.clawmarket', 'seller.json'),
    });
  });
});

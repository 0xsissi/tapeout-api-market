import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  isEmbeddedCliproxyEnabled,
  renderEmbeddedCliproxyConfig,
  resolveEmbeddedCliproxyOptions,
} from './embedded-cliproxy.mjs';

describe('embedded cliproxy helpers', () => {
  it('detects embedded cliproxy mode from backend flags', () => {
    expect(isEmbeddedCliproxyEnabled({ BACKEND_MODE: 'embedded-cliproxy' })).toBe(true);
    expect(isEmbeddedCliproxyEnabled({ CLIPROXY_EMBED: 'true' })).toBe(true);
    expect(isEmbeddedCliproxyEnabled({ BACKEND_MODE: 'proxy-url' })).toBe(false);
  });

  it('resolves workspace defaults and custom overrides', () => {
    const options = resolveEmbeddedCliproxyOptions({
      CLIPROXY_SOURCE_DIR: '/tmp/cliproxy-src',
      CLIPROXY_WORK_DIR: '/tmp/cliproxy-work',
      CLIPROXY_HOST: '127.0.0.1',
      CLIPROXY_PORT: '4312',
      CLIPROXY_EXPOSE_MODELS: 'gpt-5.4,gpt-5.4-mini',
      CLIPROXY_PROXY_URL: 'http://127.0.0.1:7897',
    });

    expect(options.sourceDir).toBe('/tmp/cliproxy-src');
    expect(options.workDir).toBe('/tmp/cliproxy-work');
    expect(options.authDir).toBe(path.join('/tmp/cliproxy-work', 'auths'));
    expect(options.configPath).toBe(path.join('/tmp/cliproxy-work', 'config.yaml'));
    expect(options.backendUrl).toBe('http://127.0.0.1:4312');
    expect(options.exposeModels).toEqual(['gpt-5.4', 'gpt-5.4-mini']);
    expect(options.proxyUrl).toBe('http://127.0.0.1:7897');
  });

  it('renders optional oauth alias and codex headers into config yaml', () => {
    const rendered = renderEmbeddedCliproxyConfig({
      host: '127.0.0.1',
      port: 4310,
      authDir: '/tmp/auths',
      proxyUrl: 'http://127.0.0.1:7897',
      codexHeaderDefaults: {
        userAgent: 'codex-cli-test',
        betaFeatures: 'multi_agent',
      },
      oauthModelAlias: {
        codex: [
          { name: 'gpt-5-codex', alias: 'gpt-5.4', fork: true },
        ],
      },
      oauthExcludedModels: {
        codex: ['gpt-5-mini'],
      },
    });

    expect(rendered).toContain('auth-dir: "/tmp/auths"');
    expect(rendered).toContain('proxy-url: "http://127.0.0.1:7897"');
    expect(rendered).toContain('codex-header-defaults:');
    expect(rendered).toContain('user-agent: "codex-cli-test"');
    expect(rendered).toContain('oauth-model-alias:');
    expect(rendered).toContain('- name: "gpt-5-codex"');
    expect(rendered).toContain('alias: "gpt-5.4"');
    expect(rendered).toContain('fork: true');
    expect(rendered).toContain('oauth-excluded-models:');
    expect(rendered).toContain('- "gpt-5-mini"');
  });
});

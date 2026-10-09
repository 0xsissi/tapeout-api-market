import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClientPolicyManager, DEFAULT_CLIENT_POLICY } from './client-policy.js';

describe('ClientPolicyManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CLAW_MIN_CLIENT_VERSION;
    delete process.env.CLAW_RECOMMENDED_VERSION;
  });

  it('falls back to defaults when no file exists', () => {
    const manager = new ClientPolicyManager({ policyFilePath: '/tmp/does-not-exist.json' });

    expect(manager.get()).toEqual(DEFAULT_CLIENT_POLICY);
  });

  it('loads policy from a file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'client-policy-'));
    const filePath = path.join(dir, 'client-policy.json');
    writeFileSync(filePath, JSON.stringify({
      minClientVersion: '0.2.0',
      recommendedVersion: '0.2.3',
      bannedVersions: ['0.2.1'],
    }));

    const manager = new ClientPolicyManager({ policyFilePath: filePath });

    expect(manager.get()).toMatchObject({
      minClientVersion: '0.2.0',
      recommendedVersion: '0.2.3',
      bannedVersions: ['0.2.1'],
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it('applies env overrides on top of file values', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'client-policy-'));
    const filePath = path.join(dir, 'client-policy.json');
    writeFileSync(filePath, JSON.stringify({
      minClientVersion: '0.2.0',
      recommendedVersion: '0.2.3',
    }));
    process.env.CLAW_MIN_CLIENT_VERSION = '0.2.2';

    const manager = new ClientPolicyManager({ policyFilePath: filePath });

    expect(manager.get()).toMatchObject({
      minClientVersion: '0.2.2',
      recommendedVersion: '0.2.3',
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it('allows runtime overrides', () => {
    const manager = new ClientPolicyManager({ policyFilePath: '/tmp/does-not-exist.json' });

    manager.updateOverride({
      minClientVersion: '0.3.0',
      bannedVersions: ['0.3.1'],
    });

    expect(manager.get()).toMatchObject({
      minClientVersion: '0.3.0',
      bannedVersions: ['0.3.1'],
    });
  });
});

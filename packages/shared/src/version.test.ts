import { describe, expect, it, vi, afterEach } from 'vitest';

import { compareVersion, isClientVersionAllowed, normalizeVersion } from './version.js';

describe('shared version helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('compares lower versions correctly', () => {
    expect(compareVersion('0.1.9', '0.2.0')).toBe(-1);
  });

  it('compares equal versions correctly', () => {
    expect(compareVersion('0.2.0', '0.2.0')).toBe(0);
  });

  it('compares higher versions correctly', () => {
    expect(compareVersion('1.0.0', '0.9.99')).toBe(1);
  });

  it('normalizes prerelease suffixes', () => {
    expect(normalizeVersion('0.2.0-dev')).toBe('0.2.0');
    expect(compareVersion('0.2.0-dev', '0.2.0')).toBe(0);
  });

  it('normalizes leading v prefixes', () => {
    expect(compareVersion('v0.2.1', '0.2.0')).toBe(1);
  });

  it('treats missing patch numbers as zero', () => {
    expect(compareVersion('0.2', '0.2.0')).toBe(0);
  });

  it('warns and returns zero for invalid input', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(compareVersion('', 'abc')).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('rejects versions below the minimum', () => {
    expect(
      isClientVersionAllowed('0.1.9', {
        minClientVersion: '0.2.0',
        recommendedVersion: '0.2.3',
        upgradeUrl: 'https://github.com/example/releases/latest',
      }),
    ).toEqual({ allowed: false, reason: 'below_min' });
  });

  it('rejects explicitly banned versions', () => {
    expect(
      isClientVersionAllowed('0.2.1', {
        minClientVersion: '0.2.0',
        recommendedVersion: '0.2.3',
        upgradeUrl: 'https://github.com/example/releases/latest',
        bannedVersions: ['0.2.1'],
      }),
    ).toEqual({ allowed: false, reason: 'banned' });
  });

  it('allows supported versions', () => {
    expect(
      isClientVersionAllowed('0.2.3', {
        minClientVersion: '0.2.0',
        recommendedVersion: '0.2.3',
        upgradeUrl: 'https://github.com/example/releases/latest',
        bannedVersions: ['0.2.1'],
      }),
    ).toEqual({ allowed: true });
  });
});

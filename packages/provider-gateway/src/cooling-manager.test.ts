import { describe, expect, it } from 'vitest';

import { CoolingManager } from './cooling-manager.js';

describe('CoolingManager', () => {
  it('tracks retry-after windows per account', () => {
    const manager = new CoolingManager();

    manager.tripAccount('acct-a', 7, 'quota', 1_000);

    expect(manager.isAvailable('acct-a', 1_000)).toBe(false);
    expect(manager.remainingSeconds('acct-a', 1_000)).toBe(7);
    expect(manager.activeCount(1_000)).toBe(1);
    expect(manager.record('acct-a', 1_000)).toMatchObject({
      reason: 'quota',
      until: 8_000,
    });
  });

  it('expires cooled accounts after the retry window', () => {
    const manager = new CoolingManager();

    manager.tripAccount('acct-a', 3, 'quota', 1_000);
    expect(manager.isAvailable('acct-a', 3_500)).toBe(false);
    expect(manager.isAvailable('acct-a', 4_000)).toBe(true);
    expect(manager.activeAccounts(4_000)).toEqual([]);
  });

  it('reports the earliest recovery window across cooled accounts', () => {
    const manager = new CoolingManager();

    manager.tripAccount('acct-a', 10, 'quota', 1_000);
    manager.tripAccount('acct-b', 4, 'quota', 1_000);

    expect(manager.minRemainingSeconds(1_000)).toBe(4);
    expect(manager.minRemainingSeconds(5_000)).toBe(6);
  });
});

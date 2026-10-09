import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionStickyTable } from './session-sticky.js';

describe('SessionStickyTable', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('evicts the least recently used entry', () => {
    const table = new SessionStickyTable({ capacity: 2, ttlMs: 1_000 });
    table.set('a', 'peer-a');
    table.set('b', 'peer-b');
    table.get('a');
    table.set('c', 'peer-c');

    expect(table.get('a')?.peerId).toBe('peer-a');
    expect(table.get('b')).toBeNull();
    expect(table.get('c')?.peerId).toBe('peer-c');
  });

  it('expires stale entries by ttl', () => {
    const table = new SessionStickyTable({ capacity: 2, ttlMs: 1_000 });
    table.set('a', 'peer-a');
    vi.advanceTimersByTime(1_001);

    expect(table.get('a')).toBeNull();
    expect(table.size).toBe(0);
  });

  it('updates the same key instead of duplicating it', () => {
    const table = new SessionStickyTable({ capacity: 2, ttlMs: 10_000 });
    table.set('a', 'peer-a');
    table.set('a', 'peer-b');

    expect(table.size).toBe(1);
    expect(table.get('a')?.peerId).toBe('peer-b');
  });

  it('tracks failures and resets them after success', () => {
    const table = new SessionStickyTable({ capacity: 2, ttlMs: 10_000 });
    table.set('a', 'peer-a');
    table.markFailure('a');
    table.markFailure('a');
    expect(table.get('a')?.consecutiveFailures).toBe(2);

    table.markSuccess('a');
    expect(table.get('a')?.consecutiveFailures).toBe(0);
  });

  it('returns only a key prefix in snapshot output', () => {
    const table = new SessionStickyTable({ capacity: 2, ttlMs: 10_000 });
    table.set('abcdef1234567890', 'peer-a');

    expect(table.snapshot()).toEqual([
      expect.objectContaining({
        keyHashPrefix: 'abcdef123456',
        peerId: 'peer-a',
      }),
    ]);
  });

  it('applies runtime config updates for capacity and ttl', () => {
    const table = new SessionStickyTable({ capacity: 3, ttlMs: 10_000 });
    table.set('a', 'peer-a');
    table.set('b', 'peer-b');
    table.set('c', 'peer-c');

    table.updateConfig({ capacity: 2 });
    expect(table.size).toBe(2);

    vi.advanceTimersByTime(5_000);
    table.updateConfig({ ttlMs: 1_000 });
    expect(table.size).toBe(0);
  });

  it('reports hit rate and eviction rate stats', () => {
    const table = new SessionStickyTable({ capacity: 1, ttlMs: 1_000 });

    table.set('a', 'peer-a');
    table.get('a');
    table.get('missing');
    table.set('b', 'peer-b');

    expect(table.stats()).toMatchObject({
      size: 1,
      capacity: 1,
      lookups: 2,
      hits: 1,
      misses: 1,
      hitRate: 0.5,
      evictions: 1,
      evictionRate: 0.5,
    });
  });
});

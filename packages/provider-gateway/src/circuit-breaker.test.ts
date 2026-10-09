import { describe, expect, it } from 'vitest';

import { CircuitBreaker } from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('sustained u>=0.95 for 60s triggers account revoke', () => {
    const breaker = new CircuitBreaker({
      openThreshold: 0.95,
      closeThreshold: 0.9,
      sustainMs: 60_000,
    });

    expect(breaker.tick(0.97, 0)).toEqual({
      opened: false,
      closed: false,
      isOpen: false,
    });
    expect(breaker.tick(0.97, 59_999)).toEqual({
      opened: false,
      closed: false,
      isOpen: false,
    });
    expect(breaker.tick(0.97, 60_000)).toEqual({
      opened: true,
      closed: false,
      isOpen: true,
    });
    expect(breaker.isOpen).toBe(true);
  });

  it('closes after utilization recovers below the close threshold', () => {
    const breaker = new CircuitBreaker({
      openThreshold: 0.95,
      closeThreshold: 0.9,
      sustainMs: 10_000,
    });

    breaker.tick(0.96, 0);
    breaker.tick(0.96, 10_000);
    expect(breaker.isOpen).toBe(true);

    expect(breaker.tick(0.89, 15_000)).toEqual({
      opened: false,
      closed: true,
      isOpen: false,
    });
    expect(breaker.isOpen).toBe(false);
  });
});

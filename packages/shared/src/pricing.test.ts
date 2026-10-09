import { describe, expect, it } from 'vitest';

import {
  cucPrice,
  hasAimmPricing,
  resolveModelAlpha,
  resolveModelBasePrice,
  normalizeModelPricing,
} from './pricing.js';

describe('pricing', () => {
  it('makes p0=5 real input/output base rates instead of retaining the old 60/60', () => {
    expect(normalizeModelPricing({ model: 'sol', inputPer1m: 60, outputPer1m: 60, p0: 5, alpha: 1 })).toEqual({ model: 'sol', inputPer1m: 5, outputPer1m: 5, p0: 5, alpha: 1 });
  });
  it('preserves unequal rates when rescaling and leaves Luna prices exactly unchanged', () => {
    expect(normalizeModelPricing({ model: 'x', inputPer1m: 1, outputPer1m: 5, p0: 6 })).toMatchObject({ inputPer1m: 2, outputPer1m: 10 });
    expect(normalizeModelPricing({ model: 'luna', inputPer1m: 0.02, outputPer1m: 0.1, p0: 0.06 })).toMatchObject({ inputPer1m: 0.02, outputPer1m: 0.1 });
  });
  it('cucPrice matches formula exactly', () => {
    expect(cucPrice(2.0, 0.5, 1.0)).toBeCloseTo(4.0, 4);
    expect(cucPrice(2.0, 0.9, 1.0)).toBeCloseTo(20.0, 4);
    expect(cucPrice(2.0, 0.0, 1.5)).toBeCloseTo(2.0, 4);
  });

  it('prices idle utilization at the base price', () => {
    expect(cucPrice(2, 0, 1)).toBeCloseTo(2, 12);
  });

  it('doubles the price at 50% utilization when alpha is 1', () => {
    expect(cucPrice(2, 0.5, 1)).toBeCloseTo(4, 12);
  });

  it('explodes near full utilization', () => {
    expect(cucPrice(2, 0.9999, 1)).toBeGreaterThan(1_000);
  });

  it('detects AIMM pricing when either p0 or alpha is configured', () => {
    expect(hasAimmPricing({})).toBe(false);
    expect(hasAimmPricing({ p0: 2 })).toBe(true);
    expect(hasAimmPricing({ alpha: 0.5 })).toBe(true);
  });

  it('falls back to the legacy price average for p0 and alpha=1', () => {
    expect(resolveModelBasePrice({ inputPer1m: 2, outputPer1m: 4 })).toBe(3);
    expect(resolveModelAlpha({})).toBe(1);
  });
});

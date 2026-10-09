import type { ModelPricing } from './types/index.js';

/** p0 is the mean base rate; preserve the input/output ratio when its value changes. */
export function normalizeModelPricing<T extends ModelPricing>(pricing: T): T {
  if (pricing.p0 == null) return { ...pricing };
  const mean = (pricing.inputPer1m + pricing.outputPer1m) / 2;
  if (![pricing.inputPer1m, pricing.outputPer1m, pricing.p0].every(value => Number.isFinite(value) && value >= 0)) throw new Error('Invalid model base price');
  if (mean === 0) {
    if (pricing.p0 !== 0) throw new Error('Cannot scale zero input and output rates to a positive base price');
    return { ...pricing };
  }
  if (Math.abs(mean - pricing.p0) <= Number.EPSILON * Math.max(mean, pricing.p0) * 4) return { ...pricing };
  const factor = pricing.p0 / mean;
  return { ...pricing, inputPer1m: pricing.inputPer1m * factor, outputPer1m: pricing.outputPer1m * factor };
}

export function cucPrice(p0: number, u: number, alpha: number): number {
  const uClamped = Math.min(Math.max(u, 0), 0.999);
  return p0 / Math.pow(1 - uClamped, alpha);
}

export function hasAimmPricing(pricing: Pick<ModelPricing, 'p0' | 'alpha'>): boolean {
  return pricing.p0 != null || pricing.alpha != null;
}

export function resolveModelBasePrice(
  pricing: Pick<ModelPricing, 'inputPer1m' | 'outputPer1m' | 'p0'>,
): number {
  return pricing.p0 ?? (pricing.inputPer1m + pricing.outputPer1m) / 2;
}

export function resolveModelAlpha(pricing: Pick<ModelPricing, 'alpha'>): number {
  return pricing.alpha ?? 1.0;
}

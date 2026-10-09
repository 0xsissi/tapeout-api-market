import { describe, expect, it } from 'vitest';

import { checkClockSkew, formatClockSkewMs, probeClockSkew } from './clock.js';

describe('clock skew checks', () => {
  it('estimates skew from the midpoint of the request round trip', async () => {
    let nowValue = 1_000;
    const result = await probeClockSkew({
      url: 'https://clock.example.test',
      now: () => {
        const current = nowValue;
        nowValue += current === 1_000 ? 200 : 0;
        return current;
      },
      fetchImpl: async () => ({
        headers: {
          get(name: string) {
            return name.toLowerCase() === 'date'
              ? new Date(2_000).toUTCString()
              : null;
          },
        },
      }),
    });

    expect(result.midpointTimeMs).toBe(1_100);
    expect(result.skewMs).toBe(900);
    expect(result.absoluteSkewMs).toBe(900);
    expect(result.roundTripMs).toBe(200);
  });

  it('marks large skew as warning or fatal', async () => {
    const fetchImpl = async () => ({
      headers: {
        get() {
          return new Date(400_000).toUTCString();
        },
      },
    });
    const result = await checkClockSkew({
      urls: ['https://clock.example.test'],
      fetchImpl,
      now: () => 0,
      warningMs: 30_000,
      fatalMs: 300_000,
    });

    expect(result).toMatchObject({
      reachable: true,
      warning: true,
      fatal: true,
    });
  });

  it('returns unavailable when no probe source succeeds', async () => {
    const result = await checkClockSkew({
      urls: ['https://clock.example.test'],
      fetchImpl: async () => {
        throw new Error('network_down');
      },
    });

    expect(result).toEqual({
      reachable: false,
      reason: 'network_down',
    });
  });

  it('formats signed skew values for logs', () => {
    expect(formatClockSkewMs(1234)).toBe('+1234ms');
    expect(formatClockSkewMs(-987)).toBe('-987ms');
  });
});

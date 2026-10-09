import { describe, expect, it, vi } from 'vitest';

import { UtilizationTracker } from './utilization.js';

describe('UtilizationTracker', () => {
  it('tracks concurrent requests against maxConcurrent', () => {
    const tracker = new UtilizationTracker(10);

    for (let index = 0; index < 5; index++) {
      tracker.onRequestStart();
    }

    expect(tracker.inFlightCount).toBe(5);
    expect(tracker.current).toBeCloseTo(0.5, 12);
  });

  it('never drops below zero after request failures', () => {
    const tracker = new UtilizationTracker(5);

    tracker.onRequestStart();
    tracker.onRequestEnd();
    tracker.onRequestEnd();

    expect(tracker.inFlightCount).toBe(0);
    expect(tracker.current).toBe(0);
  });

  it('emits utilization jumps once the threshold is crossed', () => {
    const tracker = new UtilizationTracker(10, 0.15);
    const listener = vi.fn();
    tracker.on('u-jump', listener);

    tracker.onRequestStart();
    tracker.onRequestStart();
    tracker.onRequestStart();
    tracker.onRequestStart();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, { from: 0, to: 0.2, inFlight: 2 });
    expect(listener).toHaveBeenNthCalledWith(2, { from: 0.2, to: 0.4, inFlight: 4 });
  });
});

import { describe, expect, it } from 'vitest';
import { aimmExample, createFlowClock, FLOW_STAGES } from '../../apps/marketplace/public/brief-demo-core.js';

describe('product brief pricing and playback', () => {
  it('shows fixed and AIMM prices using the same utilization formula as the protocol', () => {
    expect(aimmExample(.5, 0)).toEqual({ factor: 1, price: 5 });
    expect(aimmExample(.5, 1)).toEqual({ factor: 2, price: 10 });
    expect(aimmExample(.5, 2)).toEqual({ factor: 4, price: 20 });
    expect(aimmExample(.8, 2).price).toBeCloseTo(125);
    expect(() => aimmExample(1, 1)).toThrow(RangeError);
  });
  it('pauses time while hidden or paused, without jumping through steps after a background gap', () => {
    const clock = createFlowClock({ duration: 1000 });
    clock.setPlaying(true); clock.advance(100);
    expect(clock.state().progress).toBe(0);
    clock.setVisible(true); clock.advance(100);
    expect(clock.state().progress).toBe(.1);
    clock.setVisible(false); clock.advance(60_000);
    expect(clock.state().progress).toBe(.1);
    clock.setVisible(true); clock.advance(60_000);
    expect(clock.state().progress).toBe(.2);
    clock.setPlaying(false); clock.advance(100);
    expect(clock.state().progress).toBe(.2);
  });
  it('manual selection pauses on that step, while playback advances and wraps', () => {
    const clock = createFlowClock({ duration: 200 });
    clock.setPlaying(true); clock.setVisible(true); clock.advance(100); clock.advance(100);
    expect(clock.state().step).toBe(1);
    expect(clock.select(5)).toMatchObject({ step: 5, progress: 0, playing: false });
    clock.setPlaying(true); clock.advance(100); clock.advance(100);
    expect(clock.state().step).toBe(0);
    expect(() => clock.select(6)).toThrow(RangeError);
  });
  it('keeps final receipt signing off-chain and shows model responses traveling back to the buyer', () => {
    expect(FLOW_STAGES[3].routes).toEqual([{ id: 'upstream', reverse: true }, { id: 'request', reverse: true }]);
    expect(FLOW_STAGES[4].nodes).toEqual(['buyer', 'seller']);
    expect(FLOW_STAGES[4].money).toBeUndefined();
    expect(FLOW_STAGES[4].routes).toEqual([{ id: 'request' }]);
    expect(FLOW_STAGES[5].money).toBe(true);
    expect(FLOW_STAGES[5].nodes).toContain('pool');
  });
});

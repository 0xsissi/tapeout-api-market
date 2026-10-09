export function aimmExample(utilization, alpha, base = 5) {
  if (!Number.isFinite(utilization) || utilization < 0 || utilization >= 1 || !Number.isFinite(alpha) || alpha < 0 || !Number.isFinite(base) || base <= 0) throw new RangeError('Invalid pricing example');
  const factor = 1 / (1 - utilization) ** alpha;
  return { factor, price: base * factor };
}

// Presentation clock. Hidden views and long gaps must not advance the demo.
export function createFlowClock({ duration = 5000, steps = 6 } = {}) {
  let step = 0, elapsed = 0, playing = false, visible = false;
  const state = () => ({ step, progress: elapsed / duration, playing, visible });
  return {
    state,
    setPlaying(value) { playing = Boolean(value); return state(); },
    setVisible(value) { visible = Boolean(value); return state(); },
    select(index) {
      if (!Number.isInteger(index) || index < 0 || index >= steps) throw new RangeError('Invalid demo step');
      step = index; elapsed = 0; playing = false; return state();
    },
    advance(delta) {
      if (playing && visible && Number.isFinite(delta) && delta > 0) {
        elapsed += Math.min(delta, 100);
        if (elapsed >= duration) { elapsed -= duration; step = (step + 1) % steps; }
      }
      return state();
    },
  };
}

export const FLOW_STAGES = [
  { nodes: ['buyer', 'seller'], routes: [{ id: 'discover' }] },
  { nodes: ['buyer', 'pool'], routes: [{ id: 'deposit' }], money: true },
  { nodes: ['buyer', 'seller', 'model'], routes: [{ id: 'request' }, { id: 'upstream' }] },
  { nodes: ['buyer', 'seller', 'model'], routes: [{ id: 'upstream', reverse: true }, { id: 'request', reverse: true }] },
  { nodes: ['buyer', 'seller'], routes: [{ id: 'request' }] },
  { nodes: ['seller', 'pool'], routes: [{ id: 'collect' }, { id: 'collect', reverse: true }], money: true },
];

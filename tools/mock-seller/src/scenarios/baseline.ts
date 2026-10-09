import type { ScenarioDefinition } from '../scenario-types.js';

export const baselineScenario: ScenarioDefinition = {
  name: 'baseline',
  description: 'Stable mixed cluster with sustained concurrent traffic.',
  preset: 'mixed',
  sellerCount: 10,
  phases: [{ durationMs: 3_000, concurrency: 5, sessions: 10 }],
  assertions: [
    { metric: 'successRate', operator: '>=', target: 0.99 },
  ],
  schedulerOverrides: {
    mode: 'new',
    rolloutPct: 100,
    logRingBufferSize: 4000,
  },
};

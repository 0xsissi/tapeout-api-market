import type { ScenarioDefinition } from '../scenario-types.js';

export const loadSpikeScenario: ScenarioDefinition = {
  name: 'load-spike',
  description: 'Traffic ramps from light load to a burst that forces failover and redistribution.',
  preset: 'mixed',
  sellerCount: 50,
  phases: [
    { durationMs: 5_000, concurrency: 10, sessions: 10 },
    { durationMs: 10_000, concurrency: 120, sessions: 120 },
  ],
  assertions: [
    { metric: 'successRate', operator: '>=', target: 0.95 },
    { metric: 'topSellerShare', operator: '<', target: 0.5 },
  ],
  schedulerOverrides: {
    mode: 'new',
    rolloutPct: 100,
    enableTopNPreselect: true,
    logRingBufferSize: 6000,
  },
};

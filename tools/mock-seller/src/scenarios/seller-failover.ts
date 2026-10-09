import type { ScenarioDefinition } from '../scenario-types.js';

export const sellerFailoverScenario: ScenarioDefinition = {
  name: 'seller-failover',
  description: 'Unreliable cluster where a subset of sellers crash and recover.',
  preset: 'unreliable',
  sellerCount: 12,
  phases: [{ durationMs: 5_000, concurrency: 6, sessions: 12 }],
  assertions: [
    { metric: 'successRate', operator: '>=', target: 0.95 },
    { metric: 'failoverRate', operator: '>=', target: 0.05 },
  ],
  schedulerOverrides: {
    mode: 'new',
    rolloutPct: 100,
    enableSessionSticky: false,
    enableTopNPreselect: true,
    logRingBufferSize: 5000,
  },
};

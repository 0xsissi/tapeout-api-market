import type { ScenarioDefinition } from '../scenario-types.js';

export const sessionStickinessScenario: ScenarioDefinition = {
  name: 'session-stickiness',
  description: 'Repeated sessions should stay on the same seller after the first hop.',
  preset: 'mixed',
  sellerCount: 10,
  phases: [{ durationMs: 3_000, concurrency: 5, sessions: 5 }],
  assertions: [
    { metric: 'stickySessionRate', operator: '>=', target: 0.8 },
  ],
  schedulerOverrides: {
    mode: 'new',
    rolloutPct: 100,
    enableSessionSticky: true,
    logRingBufferSize: 4000,
  },
};

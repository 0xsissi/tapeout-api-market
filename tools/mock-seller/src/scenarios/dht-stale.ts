import type { ScenarioDefinition } from '../scenario-types.js';

export const dhtStaleScenario: ScenarioDefinition = {
  name: 'dht-stale',
  description: 'Buyer keeps routing with stale provider announcements while some sellers have gone away.',
  preset: 'unreliable',
  sellerCount: 30,
  phases: [{ durationMs: 14_000, concurrency: 18, sessions: 24 }],
  assertions: [
    { metric: 'successRate', operator: '>=', target: 0.9 },
  ],
  schedulerOverrides: {
    mode: 'new',
    rolloutPct: 100,
    enableHardFilter: true,
    enableTopNPreselect: true,
    logRingBufferSize: 4000,
  },
};

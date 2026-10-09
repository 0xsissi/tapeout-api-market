import { baselineScenario } from './baseline.js';
import { dhtStaleScenario } from './dht-stale.js';
import { loadSpikeScenario } from './load-spike.js';
import { sellerFailoverScenario } from './seller-failover.js';
import { sessionStickinessScenario } from './session-stickiness.js';

export const SCENARIOS = {
  baseline: baselineScenario,
  'seller-failover': sellerFailoverScenario,
  'load-spike': loadSpikeScenario,
  'session-stickiness': sessionStickinessScenario,
  'dht-stale': dhtStaleScenario,
} as const;

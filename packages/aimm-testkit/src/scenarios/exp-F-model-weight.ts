import { Harness } from '../Harness.js';

export async function runExperimentF() {
  const opus = await new Harness({
    makers: [{ id: 'pro', p0: 2, alpha: 1, credits: 45, modelWeights: { opus: 5, sonnet: 1 } }],
    buyers: [{ id: 'B1', model: 'opus', requestCount: 9, totalTokens: 1000 }],
    routing: 'greedy',
  }).run(1_000);
  const sonnet = await new Harness({
    makers: [{ id: 'pro', p0: 2, alpha: 1, credits: 45, modelWeights: { opus: 5, sonnet: 1 } }],
    buyers: [{ id: 'B1', model: 'sonnet', requestCount: 9, totalTokens: 1000 }],
    routing: 'greedy',
  }).run(1_000);
  const opusU = opus.priceTimeline.at(-1)?.u ?? 0;
  const sonnetU = sonnet.priceTimeline.at(-1)?.u ?? 0;
  return { name: 'exp-F-model-weight', pass: opusU > 0.95 && Math.abs(sonnetU - 0.2) < 0.05, opusU, sonnetU };
}

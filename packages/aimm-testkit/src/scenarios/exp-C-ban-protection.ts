import { Harness } from '../Harness.js';

export async function runExperimentC() {
  const maker = { id: 'claude-pro', p0: 2, alpha: 1, credits: 45, modelWeights: { sonnet: 1 } };
  const buyers = [{ id: 'B1', model: 'sonnet', requestCount: 42, totalTokens: 1000 }];
  const result = await new Harness({ makers: [maker], buyers, routing: 'softmax', seed: 7 }).run(3_600_000);
  const peakU = Math.max(...result.priceTimeline.map((item) => item.u), 0);
  return {
    name: 'exp-C-ban-protection',
    pass: result.upstream429Count === 0 && peakU < 0.98,
    upstream429Count: result.upstream429Count,
    peakU,
    result,
  };
}

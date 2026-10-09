import { Harness } from '../Harness.js';

export async function runExperimentD() {
  const makers = [
    { id: 'M1', p0: 1, alpha: 1, credits: 20, modelWeights: { sonnet: 1 } },
    { id: 'M2', p0: 2, alpha: 1, credits: 20, modelWeights: { sonnet: 1 } },
    { id: 'M3', p0: 2, alpha: 1, credits: 20, modelWeights: { sonnet: 1 } },
    { id: 'M4', p0: 2, alpha: 1, credits: 20, modelWeights: { sonnet: 1 } },
    { id: 'M5', p0: 2, alpha: 1, credits: 20, modelWeights: { sonnet: 1 } },
  ];
  const buyers = Array.from({ length: 50 }, (_, index) => ({
    id: `B${index}`,
    model: 'sonnet',
    requestCount: 1,
    totalTokens: 1000,
  }));
  const result = await new Harness({ makers, buyers, routing: 'softmax', beta: 3, seed: 9 }).run(5_000);
  return { name: 'exp-D-thundering-herd', pass: result.completedRequests >= 45, result };
}

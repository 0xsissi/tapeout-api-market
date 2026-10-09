import { Harness } from '../Harness.js';
import { gini } from '../Metrics.js';

export async function runExperimentB() {
  const makers = Array.from({ length: 3 }, (_, index) => ({
    id: `M${index + 1}`,
    p0: 2,
    alpha: 1,
    credits: 10_000,
    modelWeights: { sonnet: 1 },
  }));
  const buyers = Array.from({ length: 100 }, (_, index) => ({
    id: `B${index}`,
    model: 'sonnet',
    requestCount: 100,
    totalTokens: 10,
  }));
  const result = await new Harness({ makers, buyers, routing: 'softmax', beta: 3, seed: 42 }).run(60_000);
  const hitGini = gini(Object.values(result.routingHits));
  return { name: 'exp-B-herd-dispersion', pass: hitGini < 0.2, hitGini, result };
}

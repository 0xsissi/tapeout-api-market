import { Harness } from '../Harness.js';

export async function runExperimentE() {
  const makers = [
    { id: 'cheap', p0: 1.5, alpha: 1, credits: 100, modelWeights: { sonnet: 1 } },
    { id: 'mid', p0: 2, alpha: 1, credits: 400, modelWeights: { sonnet: 1 } },
    { id: 'high', p0: 3, alpha: 1, credits: 800, modelWeights: { sonnet: 1 } },
  ];
  const buyers = [{ id: 'B1', model: 'sonnet', requestCount: 1000, totalTokens: 100 }];
  const result = await new Harness({ makers, buyers, routing: 'softmax', beta: 3, seed: 11 }).run(60_000);
  const hits = Object.values(result.routingHits);
  return { name: 'exp-E-price-discovery', pass: hits.every((hitsForMaker) => hitsForMaker > 100), result };
}

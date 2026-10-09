import { cucPrice } from '@clawmarket/shared';

import { maxDeviationPercent } from '../Metrics.js';

export async function runExperimentA() {
  const uValues = [0, 0.25, 0.5, 0.75, 0.9, 0.95];
  const actual = uValues.map((u) => cucPrice(2, u, 1));
  const expected = uValues.map((u) => 2 / (1 - u));
  const maxDeviation = maxDeviationPercent(actual, expected);
  return { name: 'exp-A-cuc-curve', pass: maxDeviation < 0.01, maxDeviation, actual, expected };
}

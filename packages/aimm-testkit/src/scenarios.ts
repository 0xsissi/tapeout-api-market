export { runExperimentA } from './scenarios/exp-A-cuc-curve.js';
export { runExperimentB } from './scenarios/exp-B-herd-dispersion.js';
export { runExperimentC } from './scenarios/exp-C-ban-protection.js';
export { runExperimentD } from './scenarios/exp-D-thundering-herd.js';
export { runExperimentE } from './scenarios/exp-E-price-discovery.js';
export { runExperimentF } from './scenarios/exp-F-model-weight.js';

import { runExperimentA } from './scenarios/exp-A-cuc-curve.js';
import { runExperimentB } from './scenarios/exp-B-herd-dispersion.js';
import { runExperimentC } from './scenarios/exp-C-ban-protection.js';
import { runExperimentD } from './scenarios/exp-D-thundering-herd.js';
import { runExperimentE } from './scenarios/exp-E-price-discovery.js';
import { runExperimentF } from './scenarios/exp-F-model-weight.js';

export async function runAllExperiments() {
  return await Promise.all([
    runExperimentA(),
    runExperimentB(),
    runExperimentC(),
    runExperimentD(),
    runExperimentE(),
    runExperimentF(),
  ]);
}

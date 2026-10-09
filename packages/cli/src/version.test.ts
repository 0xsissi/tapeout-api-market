import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { CLI_DISPLAY_VERSION, CLI_VERSION } from './version.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version?: string };

describe('cli version metadata', () => {
  it('matches the package version and display prefix', () => {
    expect(CLI_VERSION).toBe(packageJson.version);
    expect(CLI_DISPLAY_VERSION).toBe(`v${packageJson.version}`);
  });
});

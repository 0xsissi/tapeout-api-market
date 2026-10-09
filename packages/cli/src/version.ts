import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version?: string };

export const CLI_VERSION = packageJson.version ?? '0.0.0-dev';
export const CLI_DISPLAY_VERSION = `v${CLI_VERSION}`;

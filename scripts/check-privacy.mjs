import { fileURLToPath } from 'node:url';
import { auditTrackedPrivacy } from './lib/privacy-check.mjs';
try {
  console.log(JSON.stringify(auditTrackedPrivacy(fileURLToPath(new URL('../', import.meta.url)), { staged: process.argv.includes('--staged') })));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

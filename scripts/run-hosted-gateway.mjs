import './lib/bsc-testnet-only.mjs';
import { importDist, runBuild } from './lib/testnet-runtime.mjs';

async function main() {
  await runBuild();
  await importDist('packages/hosted-gateway/dist/main.js');
}

main().catch((error) => {
  console.error('HOSTED GATEWAY FAILED');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

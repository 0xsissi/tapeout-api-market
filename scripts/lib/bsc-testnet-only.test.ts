import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const moduleUrl = new URL('./bsc-testnet-only.mjs', import.meta.url).href;
const root = fileURLToPath(new URL('../../', import.meta.url));
function run(overrides: Record<string, string>) {
  const env = { ...process.env }; delete env.CLAWMARKET_PAYMENT_NETWORK; delete env.CHAIN_ID;
  delete env.CLAWMARKET_AUTH_NONCE_MODE;
  return execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)}); const runtime=await import('./scripts/lib/testnet-runtime.mjs'); const shared=await import('./packages/shared/dist/index.js'); console.log(JSON.stringify({ network:process.env.CLAWMARKET_PAYMENT_NETWORK, nonceMode:process.env.CLAWMARKET_AUTH_NONCE_MODE, chain:runtime.DEFAULT_CHAIN_ID, tokenChain:shared.PAYMENT_TOKEN.chainId, pool:runtime.DEFAULT_ESCROW_POOL_ADDRESS }));`], { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
describe('current BSC-only testnet launch', () => {
  it('initializes both runtime and token constants on chain 97 before importing their modules', () => {
    expect(JSON.parse(run({ CLAWMARKET_PAYMENT_TOKEN: 'USDC' }))).toMatchObject({ network: 'bsc-testnet', nonceMode: 'bitmap', chain: 97, tokenChain: 97, pool: '0x90D30bA5d3e72A029335D2B879786ba912EA6e5F' });
    expect(JSON.parse(run({ CLAWMARKET_PAYMENT_TOKEN: 'BEM' }))).toMatchObject({ chain: 97, tokenChain: 97, pool: '0xfd95F0cA22D6c2Ca8dE3Bd42f88c6b94ABf6724e' });
  });
  it('refuses other network overrides instead of silently launching the wrong payment profile', () => {
    expect(() => run({ CLAWMARKET_PAYMENT_NETWORK: 'default' })).toThrow();
    expect(() => run({ CHAIN_ID: '56' })).toThrow();
    expect(() => run({ CLAWMARKET_AUTH_NONCE_MODE: 'sequential' })).toThrow();
  });
});

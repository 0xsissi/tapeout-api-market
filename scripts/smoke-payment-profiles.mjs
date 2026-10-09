// Exercise the built launcher with isolated owner profiles; no chain transactions or upstream calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const home = mkdtempSync(path.join(os.tmpdir(), 'tam-profile-smoke-'));
const env = { ...process.env, HOME: home };
delete env.CLAWMARKET_PAYMENT_NETWORK;
for (const key of ['CLAWMARKET_PAYMENT_TOKEN', 'CLAWMARKET_CONFIG_PATH', 'ESCROW_POOL_ADDRESS', 'RPC_URL', 'CHAIN_ID', 'MAX_REQUEST_COST_TOKEN', 'MAX_UNCONFIRMED_CREDIT_TOKEN', 'DAILY_LIMIT_TOKEN', 'CLAWMARKET_INPUT_PRICE', 'CLAWMARKET_OUTPUT_PRICE', 'CLAWMARKET_SELLER_P0']) delete env[key];
const cli = path.join(root, 'packages/cli/dist/index.js');
async function command(args, extraEnv = {}, expectedCode = 0) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...env, ...extraEnv }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill(), 20_000);
  try { const [code] = await once(child, 'exit'); assert.equal(code, expectedCode, `CLI result mismatch: ${output}`); return output; }
  finally { clearTimeout(timer); }
}
try {
  assert.equal(JSON.parse(await command(['payment', 'list'])).selected, 'USDC');
  await command(['--payment-token', 'USDC', 'config', 'set', 'seller.pricing.p0', '7']);
  await command(['payment', 'use', 'BEM']);
  const bem = JSON.parse(await command(['config', 'get']));
  assert.equal(bem.settlement.symbol, 'BEM'); assert.equal(bem.seller.pricing.p0, 0); assert.equal(bem.settlement.dailyLimitToken, 0);
  assert.equal(JSON.parse(await command(['config', 'get'], { CLAWMARKET_PAYMENT_TOKEN: 'USDC' })).settlement.symbol, 'USDC');
  assert.equal(JSON.parse(await command(['--payment-token', 'BEM', 'config', 'get'], { CLAWMARKET_PAYMENT_TOKEN: 'USDC' })).settlement.symbol, 'BEM');
  await command(['--payment-token', 'BEM', 'config', 'set', 'seller.pricing.p0', '1000']);
  assert.equal((await command(['--payment-token=USDC', 'config', 'get', 'seller.pricing.p0'])).trim(), '7');
  assert.equal((await command(['config', 'get', 'seller.pricing.p0'])).trim(), '1000');
  assert.match(await command(['--payment-token', 'BEM', 'seller', 'up'], {}, 1), /请先设置卖家价格/);
  await command(['--payment-token', 'BEM', 'config', 'set', 'seller.pricing.input', '1000']);
  await command(['--payment-token', 'BEM', 'config', 'set', 'seller.pricing.output', '2000']);
  assert.match(await command(['--payment-token', 'BEM', 'seller', 'up'], {}, 1), /maxRequestCostToken/);
  await command(['payment', 'use', 'USDC']);
  assert.equal(JSON.parse(await command(['config', 'get'])).settlement.symbol, 'USDC');
  const usdcFile = JSON.parse(readFileSync(path.join(home, '.clawmarket', 'config.json'), 'utf8'));
  const bemFile = JSON.parse(readFileSync(path.join(home, '.clawmarket', 'config-bem.json'), 'utf8'));
  assert.equal(usdcFile.seller.pricing.p0, 7); assert.equal(bemFile.seller.pricing.p0, 1000);
  const testNetwork = { CLAWMARKET_PAYMENT_NETWORK: 'bsc-testnet' };
  const testUsdc = JSON.parse(await command(['--payment-token', 'USDC', 'config', 'get'], testNetwork));
  const testBem = JSON.parse(await command(['--payment-token', 'BEM', 'config', 'get'], testNetwork));
  assert.equal(testUsdc.settlement.network, 'bsc-testnet');
  assert.equal(testUsdc.settlement.escrowPoolAddress.toLowerCase(), '0x90d30ba5d3e72a029335d2b879786ba912ea6e5f');
  assert.equal(testBem.settlement.network, 'bsc-testnet');
  assert.equal(testBem.settlement.escrowPoolAddress.toLowerCase(), '0xfd95f0ca22d6c2ca8de3bd42f88c6b94abf6724e');
  assert.equal(testBem.seller.pricing.p0, 0);
  await command(['--payment-token', 'USDC', 'config', 'set', 'seller.pricing.p0', '9'], testNetwork);
  await command(['--payment-token', 'BEM', 'config', 'set', 'seller.pricing.p0', '0'], testNetwork);
  assert.equal((await command(['--payment-token', 'USDC', 'config', 'get', 'seller.pricing.p0'])).trim(), '7');
  assert.equal(JSON.parse(readFileSync(path.join(home, '.clawmarket', 'config-usdc-bsc-testnet.json'), 'utf8')).seller.pricing.p0, 9);
  assert.equal(JSON.parse(readFileSync(path.join(home, '.clawmarket', 'config-bem-bsc-testnet.json'), 'utf8')).seller.pricing.p0, 0);
  console.log(JSON.stringify({ compiledLauncher: 'passed', savedSelection: 'passed', priority: 'flag > environment > saved', independentPrices: 'passed', bscTestnetProfiles: 'passed', unconfiguredBemLaunch: 'blocked before wallet/auth/network startup', realTransactions: 0 }));
} finally {
  const resolved = path.resolve(home);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('tam-profile-smoke-')) rmSync(resolved, { recursive: true, force: true });
}

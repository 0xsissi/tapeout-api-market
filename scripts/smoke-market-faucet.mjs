// Uses a dedicated test recipient saved outside Git. Only test-token message signatures are sent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { TEST_ASSETS, faucetMessage, createFaucetChain } from './lib/market-faucet.mjs';
const directory = process.env.TAM_FAUCET_STATE_DIR;
if (!directory || !path.isAbsolute(directory)) throw new Error('Provide the protected faucet state directory.');
const relative = path.relative(fs.realpathSync(fileURLToPath(new URL('../', import.meta.url))), fs.realpathSync(directory));
if (!(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))) throw new Error('Private smoke state must stay outside Git.');
const base = new URL(process.env.TAM_MARKET_ORIGIN || 'http://127.0.0.1:18400').origin;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('This smoke is restricted to a local website.');
const file = path.join(directory, 'website-smoke-wallet.json');
const write = value => { const temp = file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); };
if (!fs.existsSync(file)) { const w = ethers.Wallet.createRandom(); write({ address: w.address, privateKey: w.privateKey, claims: {} }); }
const saved = JSON.parse(fs.readFileSync(file, 'utf8')), wallet = new ethers.Wallet(saved.privateKey);
assert.equal(wallet.address, saved.address);
async function request(route, body) {
  const response = await fetch(base + route, { ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45000) });
  return { status: response.status, body: await response.json() };
}
const chain = createFaucetChain(process.env.TAM_FAUCET_RPC_URL || 'https://bsc-testnet-dataseed.bnbchain.org');
const evidence = { verifiedAt: new Date().toISOString(), chainId: 97, recipient: wallet.address, cases: [] };
try {
  await chain.verifyAssets();
  const info = await request('/api/faucet'); assert.equal(info.body.enabled, true); assert.equal(info.body.chainId, 97);
  for (const currency of ['USDC', 'BEM']) {
    const asset = TEST_ASSETS[currency]; assert.equal(info.body.assets[currency].address, asset.address);
    let record = saved.claims[currency];
    if (!record) {
      const before = await chain.inventory(wallet.address);
      const response = await request('/api/faucet/challenge', { address: wallet.address, currency }); assert.equal(response.status, 200);
      const challenge = response.body; assert.equal(challenge.chainId, 97); assert.equal(challenge.currency, currency); assert.equal(challenge.amountToken, asset.amount);
      assert.equal(challenge.message, faucetMessage({ origin: base, address: wallet.address, currency, amount: asset.amount, nonce: challenge.id, expiresAt: challenge.expiresAt }));
      record = { before: before.balances[currency], id: challenge.id, signature: await wallet.signMessage(challenge.message) }; saved.claims[currency] = record; write(saved);
    }
    let result = await request('/api/faucet/claim', { id: record.id, signature: record.signature }); assert.ok([200, 202].includes(result.status));
    for (let i = 0; i < 30 && result.body.status === 'pending'; i++) { await new Promise(resolve => setTimeout(resolve, 1500)); result = await request(`/api/faucet/claims/${record.id}`); }
    assert.equal(result.body.status, 'confirmed'); assert.equal(result.body.address, wallet.address); assert.equal(result.body.amountToken, asset.amount);
    const receipt = await chain.receipt(result.body.txHash); assert.equal(receipt.status, 1);
    const after = await chain.inventory(wallet.address);
    assert.equal(ethers.parseUnits(after.balances[currency], asset.decimals) - ethers.parseUnits(record.before, asset.decimals), ethers.parseUnits(asset.amount, asset.decimals));
    const duplicate = await request('/api/faucet/claim', { id: record.id, signature: record.signature }); assert.equal(duplicate.body.txHash, result.body.txHash); assert.equal(duplicate.body.status, 'confirmed');
    assert.equal((await chain.inventory(wallet.address)).balances[currency], after.balances[currency]);
    const cooldown = await request('/api/faucet/challenge', { address: wallet.address, currency }); assert.equal(cooldown.status, 429); assert.equal(cooldown.body.error.code, 'wallet_cooldown');
    evidence.cases.push({ currency, amount: asset.amount, txHash: result.body.txHash, receipt: 'confirmed', balanceBefore: record.before, balanceAfter: after.balances[currency], retry: 'same hash, no second transfer', walletCooldown: '429', gasUsed: receipt.gasUsed.toString(), recipientNeededGas: false });
    console.log(JSON.stringify(evidence.cases.at(-1)));
  }
  const catalog = await request('/api/market'); evidence.market = { visibleSellers: catalog.body.stats.visibleSellers, onlineNodes: catalog.body.stats.onlineNodes, observedAt: catalog.body.observedAt };
  const output = path.resolve('report', `market-website-smoke-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.json`);
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n'); console.log(`Verified website faucet evidence: ${output}`);
} finally { chain.close(); }

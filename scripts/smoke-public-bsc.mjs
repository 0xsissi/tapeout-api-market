// One real local buyer -> public seller -> model -> BSC payment smoke.
import './lib/bsc-testnet-only.mjs';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { ethers } from 'ethers';
import * as p2p from '../packages/p2p-node/dist/index.js';
import * as consumer from '../packages/consumer-gateway/dist/index.js';
import * as shared from '../packages/shared/dist/index.js';

const directory = process.env.TAM_BSC_TESTNET_STATE_DIR, seedFile = process.env.TAM_MARKET_SEED_FILE;
if (!directory || !path.isAbsolute(directory) || !seedFile) throw new Error('Provide protected test state and public seller seed file.');
const relative = path.relative(fs.realpathSync(fileURLToPath(new URL('../', import.meta.url))), fs.realpathSync(directory));
if (!(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))) throw new Error('Private test state must stay outside Git.');
assert.equal(shared.PAYMENT_TOKEN.symbol, 'USDC'); assert.equal(shared.PAYMENT_TOKEN.chainId, 97);
const read = file => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
const save = (file, value) => { const temp = path.join(directory, file + '.tmp'); fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temp, path.join(directory, file)); };
const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8')), buyer = read('smoke-accounts.json').buyer;
const rpc = 'https://bsc-testnet-dataseed.bnbchain.org', request = new ethers.FetchRequest(rpc); request.timeout = 15_000;
const provider = new ethers.JsonRpcProvider(request, 97, { staticNetwork: true, cacheTimeout: -1 });
const owner = new ethers.Wallet(read('deployer-wallet.json').privateKey);
const pool = new ethers.Contract(shared.CONTRACTS.ESCROW_POOL, ['function getBalance(address) view returns(uint256)', 'function accruedProtocolFees() view returns(uint256)'], provider);
const token = new ethers.Contract(shared.PAYMENT_TOKEN.address, ['function balanceOf(address) view returns(uint256)', 'event Transfer(address indexed from,address indexed to,uint256 value)'], provider);
let node, gateway; const format = value => ethers.formatUnits(value, 6);
const report = { checkedAt: new Date().toISOString(), chainId: 97, currency: 'USDC', buyer: buyer.address, seller: seed.announcement.walletAddress, cases: [] };
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function snapshot() { const [credit, seller, fees] = await Promise.all([pool.getBalance(buyer.address), token.balanceOf(report.seller), pool.accruedProtocolFees()]); return { credit, seller, fees }; }
try {
  assert.equal(BigInt(await provider.send('eth_chainId', [])), 97n); await shared.verifyPaymentDeployment(shared.CONTRACTS.ESCROW_POOL, rpc, 97);
  const journal = fs.existsSync(path.join(directory, 'public-seller-funding.json')) ? read('public-seller-funding.json') : { chainId: 97, recipient: report.seller, transactions: [] };
  assert.equal(journal.chainId, 97); assert.equal(journal.recipient, report.seller);
  if (await provider.getBalance(report.seller) < ethers.parseEther('0.001') || journal.transactions.length) {
    let tx = journal.transactions[0];
    if (!tx) {
      const gasPrice = BigInt(await provider.send('eth_gasPrice', [])); assert.ok(gasPrice <= 1_000_000_000n);
      const raw = await owner.signTransaction({ to: report.seller, value: ethers.parseEther('0.005'), data: '0x', chainId: 97, type: 0, nonce: await provider.getTransactionCount(owner.address, 'pending'), gasLimit: 25200n, gasPrice });
      tx = { raw, hash: ethers.keccak256(raw) }; journal.transactions.push(tx); save('public-seller-funding.json', journal);
    }
    const parsed = ethers.Transaction.from(tx.raw); assert.equal(parsed.chainId, 97n); assert.equal(parsed.from, owner.address); assert.equal(parsed.to, report.seller); assert.equal(parsed.value, ethers.parseEther('0.005')); assert.equal(ethers.keccak256(tx.raw), tx.hash);
    let receipt = await provider.getTransactionReceipt(tx.hash);
    if (!receipt) { try { await provider.broadcastTransaction(tx.raw); } catch { /* unknown results retain the same journal */ } receipt = await provider.waitForTransaction(tx.hash, 1, 60_000); }
    assert.equal(receipt?.status, 1); report.sellerGasFundingTx = tx.hash;
  }
  const port = await freePort(); node = await p2p.createNode({ listenHost: '127.0.0.1', listenPort: port, bootstrapPeers: [] }); await node.start();
  const direct = seed.multiaddrs.find(addr => !addr.includes('/p2p-circuit/') && !addr.includes('/ws/')); assert.ok(direct);
  await p2p.dialPeerAddress(node.libp2p, direct);
  const announcement = await p2p.requestProviderAnnouncement(node.libp2p, seed.announcement.peerId);
  assert.ok(shared.matchesPaymentNetwork(announcement)); assert.equal(announcement.walletAddress, report.seller);
  const model = announcement.models[0].model;
  const discovery = new p2p.ConsumerRouter(node.libp2p, new p2p.ProviderRegistry(node.libp2p), { maxPriceInputPer1m: 2, maxPriceOutputPer1m: 2 });
  const found = await discovery.findProviders(model); assert.ok(found.some(p => p.announcement.peerId === announcement.peerId));
  report.discovery = { peerId: announcement.peerId, chainMatched: true, transport: 'public TCP P2P', model };
  const apiToken = randomBytes(32).toString('hex'), apiPort = await freePort(), router = new consumer.P2PRouter(discovery);
  process.env.CLAW_SCHEDULER_ADMIN_PORT = String(await freePort());
  gateway = new consumer.ConsumerGateway({ privateKey: buyer.privateKey, apiToken, port: apiPort, escrowPoolAddress: shared.CONTRACTS.ESCROW_POOL, rpcUrl: rpc, chainId: 97, maxRequestCostToken: 0.1, maxPriceInputPer1m: 2, maxPriceOutputPer1m: 2, bootstrapPeers: [], discoverableModels: [model] }, router, new consumer.WalletManager(rpc, 97), new p2p.StreamHandler(node.libp2p));
  await gateway.start(); const beforeBlock = await provider.getBlockNumber(), before = await snapshot(); assert.ok(before.credit >= ethers.parseUnits('0.1', 6), 'Existing test buyer credit insufficient');
  const response = await fetch(`http://127.0.0.1:${apiPort}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with only TAM_PUBLIC_BSC_OK.' }], max_tokens: 128 }), signal: AbortSignal.timeout(90000) });
  const reply = await response.json(); assert.equal(response.status, 200, JSON.stringify(reply));
  assert.equal(reply.choices[0].message.content.trim(), 'TAM_PUBLIC_BSC_OK');
  console.log(JSON.stringify({ delivered: true, model, chainId: 97, response: 'TAM_PUBLIC_BSC_OK', next: 'Flush seller claims using its authenticated local management API' }));
  const deadline = Date.now() + 180_000; let after = await snapshot();
  while (after.credit === before.credit && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 2000)); after = await snapshot(); }
  const paid = before.credit - after.credit; assert.ok(paid > 0n); assert.equal(paid, shared.tokenCost(reply.usage.prompt_tokens, reply.usage.completion_tokens, 1_000_000n, 1_000_000n));
  assert.equal(after.seller - before.seller, paid - paid / 100n); assert.equal(after.fees - before.fees, paid / 100n);
  const transfers = await provider.getLogs({ address: shared.PAYMENT_TOKEN.address, fromBlock: beforeBlock, toBlock: 'latest', topics: token.interface.encodeFilterTopics('Transfer', [shared.CONTRACTS.ESCROW_POOL, report.seller]) });
  const claim = transfers.find(log => token.interface.parseLog(log)?.args.value === paid - paid / 100n); assert.ok(claim, 'Seller transfer event missing');
  assert.equal((await provider.getTransactionReceipt(claim.transactionHash))?.status, 1);
  report.cases.push({ model, response: 'TAM_PUBLIC_BSC_OK', usage: reply.usage, paidToken: format(paid), sellerReceivedToken: format(after.seller - before.seller), feeToken: format(after.fees - before.fees), claimTx: claim.transactionHash, verifiedBalances: true });
  report.status = 'passed'; fs.writeFileSync('report/public-bsc-payment-20261007.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
} finally { await gateway?.stop(); await node?.stop(); provider.destroy(); }

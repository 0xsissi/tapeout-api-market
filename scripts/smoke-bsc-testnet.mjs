// Real BSC testnet receipts, real local P2P nodes and an optional authenticated AI upstream.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = process.env.TAM_BSC_TESTNET_STATE_DIR;
if (!stateDir || !path.isAbsolute(stateDir)) throw new Error('Provide an owner-protected TAM_BSC_TESTNET_STATE_DIR outside Git.');
const relative = path.relative(repoRoot, stateDir);
if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('Private smoke state must stay outside Git.');
if (process.env.CLAWMARKET_PAYMENT_NETWORK && process.env.CLAWMARKET_PAYMENT_NETWORK !== 'bsc-testnet') throw new Error('This smoke only supports bsc-testnet.');
process.env.CLAWMARKET_PAYMENT_NETWORK = 'bsc-testnet';
process.env.CLAWMARKET_PAYMENT_TOKEN ||= 'USDC';
process.env.CLAWMARKET_AUTH_NONCE_MODE = 'bitmap';
process.env.CLAW_SCHEDULER_ADMIN_PORT = '0';
const shared = await import('../packages/shared/dist/index.js');
const { PAYMENT_TOKEN: tokenInfo, CONTRACTS, DEFAULT_RPC_URL, parsePaymentAmount: units, formatPaymentAmount: amount } = shared;
assert.equal(tokenInfo.chainId, 97);
process.env.ESCROW_POOL_ADDRESS = CONTRACTS.ESCROW_POOL;
process.env.HOME = path.join(stateDir, 'smoke-home', tokenInfo.symbol.toLowerCase());
fs.mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
const rpcUrl = process.env.TAM_BSC_TESTNET_RPC_URL || DEFAULT_RPC_URL;
const provider = new ethers.JsonRpcProvider(rpcUrl, 97, { staticNetwork: true });
provider.pollingInterval = 500;
const cleanup = [];
const output = { chainId: 97, currency: tokenInfo.symbol, token: tokenInfo.address, pool: CONTRACTS.ESCROW_POOL, startedAt: new Date().toISOString(), cases: [] };
const write = (file, value) => fs.writeFileSync(path.join(stateDir, file), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const read = file => JSON.parse(fs.readFileSync(path.join(stateDir, file), 'utf8'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const reservedPorts = new Set();

async function chainCheck() { assert.equal(BigInt(await provider.send('eth_chainId', [])), 97n); }
async function freePort(pair = false) {
  for (let i = 0; i < 20; i++) {
    const first = net.createServer(), second = net.createServer();
    const listen = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    try {
      await listen(first, 0); const port = first.address().port;
      if (reservedPorts.has(port) || (pair && reservedPorts.has(port + 1))) throw new Error('Port already reserved for this smoke');
      if (pair) await listen(second, port + 1);
      reservedPorts.add(port); if (pair) reservedPorts.add(port + 1);
      return port;
    }
    catch { /* retry an adjacent port conflict */ }
    finally { for (const server of [first, second]) if (server.listening) await new Promise(resolve => server.close(resolve)); }
  }
  throw new Error('No local port available');
}
async function json(url, token, body) {
  const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(90_000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${data.error?.message || 'request rejected'}`);
  return data;
}
async function snapshot(token, pool, accounts) {
  const [buyer, seller, fees] = await Promise.all([pool.getBalance(accounts.buyer.address), token.balanceOf(accounts.seller.address), pool.accruedProtocolFees()]);
  return { buyer, seller, fees };
}

// Fixed transaction labels and persisted raw bytes make setup safe to resume after RPC timeouts.
async function sendSetup(label, signer, tx) {
  await chainCheck();
  const file = 'smoke-setup-transactions.json';
  const journal = fs.existsSync(path.join(stateDir, file)) ? read(file) : { chainId: 97, entries: [] };
  assert.equal(journal.chainId, 97);
  let entry = journal.entries.find(item => item.label === label);
  if (!entry) {
    const gasPrice = BigInt(await provider.send('eth_gasPrice', []));
    assert.ok(gasPrice <= ethers.parseUnits('1', 9), 'Testnet gas exceeds cap');
    const nonce = await provider.getTransactionCount(signer.address, 'pending');
    const gasLimit = (await provider.estimateGas({ ...tx, from: signer.address })) * 150n / 100n;
    const raw = await signer.signTransaction({ ...tx, nonce, chainId: 97, gasPrice, gasLimit, type: 0 });
    entry = { label, hash: ethers.keccak256(raw), raw }; journal.entries.push(entry); write(file, journal);
  }
  let receipt = await provider.getTransactionReceipt(entry.hash);
  if (!receipt) {
    const saved = ethers.Transaction.from(entry.raw);
    assert.equal(saved.chainId, 97n); assert.equal(saved.from, signer.address); assert.equal(saved.to?.toLowerCase(), tx.to.toLowerCase());
    assert.equal(saved.value, BigInt(tx.value || 0)); assert.equal(saved.data, tx.data || '0x');
    if (!await provider.getTransaction(entry.hash)) await provider.broadcastTransaction(entry.raw);
    receipt = await provider.waitForTransaction(entry.hash, 1, 60_000);
  }
  assert.equal(receipt?.status, 1, `Setup transaction pending or reverted: ${entry.hash}`);
  entry.status = 'confirmed'; write(file, journal);
  output.setupTransactions ||= []; output.setupTransactions.push({ label, hash: entry.hash });
  return receipt;
}

async function upstreamServer(config) {
  let goodCalls = 0, failedCalls = 0;
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (JSON.stringify(body.messages).includes('TAM_INJECT_FAILURE')) { failedCalls++; res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Injected test failure"}}'); return; }
      goodCalls++;
      if (config) {
        const upstream = await fetch(config.proxyUrl.replace(/\/$/, '') + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...config.proxyHeaders }, body: raw, signal: AbortSignal.timeout(60_000) });
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
        for await (const chunk of upstream.body) res.write(chunk);
        res.end(); return;
      }
      const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ id: 'tam-bsc-fixture', model: body.model, choices: [{ index: 0, delta: { content: 'TAM_BSC_OK' }, finish_reason: null }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ id: 'tam-bsc-fixture', model: body.model, choices: [], usage }) + '\n\n');
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'tam-bsc-fixture', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'TAM_BSC_OK' }, finish_reason: 'stop' }], usage }));
      }
    } catch { if (!res.headersSent) res.writeHead(502); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise(resolve => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, counts: () => ({ goodCalls, failedCalls }) };
}

async function main() {
  await chainCheck(); await shared.verifyPaymentDeployment(CONTRACTS.ESCROW_POOL, rpcUrl, 97);
  const accountsFile = 'smoke-accounts.json';
  if (!fs.existsSync(path.join(stateDir, accountsFile))) {
    const account = () => { const wallet = ethers.Wallet.createRandom(); return { address: wallet.address, privateKey: wallet.privateKey }; };
    write(accountsFile, { buyer: account(), seller: account() });
  }
  const accounts = read(accountsFile), owner = new ethers.Wallet(read('deployer-wallet.json').privateKey, provider);
  output.buyer = accounts.buyer.address; output.seller = accounts.seller.address;
  const token = new ethers.Contract(tokenInfo.address, ['function transfer(address,uint256) returns(bool)', 'function balanceOf(address) view returns(uint256)'], owner);
  const poolAbi = ['function getBalance(address) view returns(uint256)', 'function accruedProtocolFees() view returns(uint256)', 'function claim((address buyer,address seller,uint256 amount,uint256 nonce,uint256 expiresAt,bytes32 poolId,uint8 nonceMode)[],bytes[])', 'event Claimed(address indexed buyer,address indexed seller,uint256 amount,uint256 nonce)', 'event ClaimSkipped(address indexed buyer,address indexed seller,uint256 amount,uint256 nonce,uint8 reason)'];
  const pool = new ethers.Contract(CONTRACTS.ESCROW_POOL, poolAbi, provider);
  for (const role of ['buyer', 'seller']) if (await provider.getBalance(accounts[role].address) < ethers.parseEther('0.001')) await sendSetup(`gas-${role}`, owner, { to: accounts[role].address, value: ethers.parseEther('0.005') });
  if (await token.balanceOf(accounts.buyer.address) < units('5')) await sendSetup(`token-${tokenInfo.symbol}`, owner, await token.transfer.populateTransaction(accounts.buyer.address, units('10')));

  const consumer = await import('../packages/consumer-gateway/dist/index.js'), seller = await import('../packages/provider-gateway/dist/index.js');
  const p2p = await import('../packages/p2p-node/dist/index.js'), crypto = await import('../packages/crypto/dist/index.js');
  const hosted = await import('../packages/hosted-gateway/dist/index.js'), sdk = await import('../packages/agent-sdk/dist/index.js');
  const { createProviderNodeAdapter, createAnnounceAddresses } = await import('./lib/testnet-runtime.mjs');
  const upstreamConfig = process.env.TAM_SMOKE_UPSTREAM_FILE ? JSON.parse(fs.readFileSync(process.env.TAM_SMOKE_UPSTREAM_FILE, 'utf8')) : null;
  const upstream = await upstreamServer(upstreamConfig), model = upstreamConfig?.model || 'tam-fixture';
  output.upstream = upstreamConfig ? 'real authenticated model' : 'deterministic fixture'; output.model = model;
  const price = tokenInfo.symbol === 'USDC' ? 1 : 1000;
  const pricing = { model, inputPer1m: price, outputPer1m: price, p0: price, alpha: 0 };
  const sellerPort = await freePort(true), buyerPort = await freePort(true), apiPort = await freePort();
  const providerNode = await p2p.createNode({ listenHost: '127.0.0.1', listenPort: sellerPort, announceAddresses: createAnnounceAddresses('127.0.0.1', sellerPort), bootstrapPeers: [] });
  const gateway = new seller.ProviderGateway({ privateKey: accounts.seller.privateKey, proxyUrl: upstream.url, models: [pricing], escrowPoolAddress: CONTRACTS.ESCROW_POOL, rpcUrl, chainId: 97, bootstrapPeers: [], trustedBuyerAddresses: [accounts.buyer.address], maxRequestCostToken: 3, maxUnconfirmedCreditToken: 3, dailyLimitToken: 10, dailyLimitUsd: 10, maxConcurrent: 1, claimBatchMaxSize: 999, claimFlushIntervalMs: 3600000, claimFlushMinAmountBaseUnits: units('100') }, async () => createProviderNodeAdapter(providerNode));
  cleanup.push(() => gateway.stop()); await gateway.start();
  const registry = new p2p.ProviderRegistry(providerNode.libp2p);
  const announcement = { peerId: providerNode.peerId.toString(), walletAddress: accounts.seller.address, publicKey: gateway.publicKey, models: [pricing], region: 'local-bsc-testnet', maxConcurrent: 1, stakeAmount: 0n, reputation: { score: 100, totalTransactions: 0, successRate: 1, avgLatencyMs: 50 }, timestamp: Date.now(), signature: '0xsmoke', multiaddrs: providerNode.getMultiaddrs().map(String) };
  p2p.registerProviderDiscoveryHandler(providerNode.libp2p, () => registry.getCurrentAnnouncement());
  await registry.announce(announcement); registry.startHeartbeat(); cleanup.push(() => registry.stopHeartbeat());
  const buyerNode = await p2p.createNode({ listenHost: '127.0.0.1', listenPort: buyerPort, bootstrapPeers: [] });
  cleanup.push(() => buyerNode.stop()); await buyerNode.start();
  await buyerNode.libp2p.dial(providerNode.libp2p.getMultiaddrs()[0]);
  const discovery = new p2p.ConsumerRouter(buyerNode.libp2p, new p2p.ProviderRegistry(buyerNode.libp2p), { maxPriceInputPer1m: price * 2, maxPriceOutputPer1m: price * 2 });
  const found = await discovery.findProviders(model); assert.ok(found.some(p => p.announcement.walletAddress.toLowerCase() === accounts.seller.address.toLowerCase()), 'Real local P2P discovery did not find the seller');
  output.discovery = { sellerPeerId: providerNode.peerId.toString(), buyerPeerId: buyerNode.peerId.toString(), discoveredProviders: found.length, paymentMetadataMatched: true };
  const router = new consumer.P2PRouter(discovery), handler = new p2p.StreamHandler(buyerNode.libp2p), apiToken = randomBytes(32).toString('hex');
  const local = new consumer.ConsumerGateway({ privateKey: accounts.buyer.privateKey, port: apiPort, apiToken, maxPriceInputPer1m: price * 2, maxPriceOutputPer1m: price * 2, maxRequestCostToken: 3, routingStrategy: 'balanced', escrowPoolAddress: CONTRACTS.ESCROW_POOL, rpcUrl, chainId: 97, bootstrapPeers: [], discoverableModels: [model] }, router, new consumer.WalletManager(rpcUrl, 97), handler);
  cleanup.push(() => local.stop()); await local.start();
  const base = `http://127.0.0.1:${apiPort}`;
  assert.equal((await fetch(base + '/v1/wallet')).status, 401);
  const depositBefore = await pool.getBalance(accounts.buyer.address);
  if (depositBefore < units('5')) {
    const deposit = await json(base + '/v1/escrow/deposit', apiToken, { amountToken: 5 });
    assert.equal(await pool.getBalance(accounts.buyer.address), depositBefore + units('5'));
    output.deposit = { amountToken: '5', approvalTx: deposit.approvalTx, depositTx: deposit.depositTx };
  } else {
    const previousFile = `smoke-${tokenInfo.symbol.toLowerCase()}.json`;
    output.deposit = { amountToken: '0', existingCreditToken: amount(depositBefore), reusedCredit: true, previousDeposit: fs.existsSync(path.join(stateDir, previousFile)) ? read(previousFile).deposit : undefined };
  }

  async function claimCase(label, before, usage, text) {
    assert.equal(text.trim(), 'TAM_BSC_OK', 'Unexpected upstream response or protocol metadata in text');
    for (let i = 0; i < 50 && gateway.billing.getQueuedAuthorizationCount() === 0; i++) await pause(100);
    const authorizations = gateway.billing.getQueuedAuthorizations(); assert.equal(authorizations.length, 1, 'Exactly one delivered request should create one collectible authorization');
    const auth = authorizations[0], fee = auth.amount / 100n;
    assert.equal(auth.amount, shared.tokenCost(usage.prompt_tokens, usage.completion_tokens, units(String(price)), units(String(price))));
    assert.deepEqual(await snapshot(token, pool, accounts), before, 'No on-chain debit before seller claim');
    const hash = await gateway.claimBatcher.flush({ force: true }); assert.ok(hash);
    const after = await snapshot(token, pool, accounts);
    assert.equal(before.buyer - after.buyer, auth.amount); assert.equal(after.seller - before.seller, auth.amount - fee); assert.equal(after.fees - before.fees, fee);
    const receipt = await provider.getTransactionReceipt(hash); assert.equal(receipt?.status, 1);
    assert.ok(receipt.logs.some(log => { try { const event = pool.interface.parseLog(log); return event?.name === 'Claimed' && event.args.nonce === auth.nonce; } catch { return false; } }));
    output.cases.push({ label, usage, response: text, paidToken: amount(auth.amount), sellerReceivedToken: amount(auth.amount - fee), feeToken: amount(fee), claimTx: hash });
    write(`smoke-${tokenInfo.symbol.toLowerCase()}.json`, output);
    console.log(JSON.stringify({ case: label, currency: tokenInfo.symbol, paid: amount(auth.amount), claimTx: hash, passed: true }));
    return auth;
  }
  const request = { model, messages: [{ role: 'user', content: 'Reply with only TAM_BSC_OK, without any other text.' }], max_tokens: 512 };
  const callsBeforeBudgetCheck = upstream.counts().goodCalls;
  const budgetBefore = await snapshot(token, pool, accounts);
  const overBudget = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...request, max_cost_token: '0.000001' }), signal: AbortSignal.timeout(90_000) });
  const budgetError = await overBudget.json(); assert.ok(overBudget.status >= 400); assert.equal(budgetError.error.type, 'budget_exceeded');
  assert.equal(upstream.counts().goodCalls, callsBeforeBudgetCheck); assert.deepEqual(await snapshot(token, pool, accounts), budgetBefore);
  output.budgetLimit = { rejected: true, noUpstreamCall: true, noDebit: true };
  let before = await snapshot(token, pool, accounts);
  const reply = await json(base + '/v1/chat/completions', apiToken, request);
  const firstAuth = await claimCase('local buyer nonstream', before, reply.usage, reply.choices[0].message.content);

  before = await snapshot(token, pool, accounts);
  const streamResponse = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...request, stream: true }), signal: AbortSignal.timeout(90_000) });
  assert.equal(streamResponse.status, 200); const sse = await streamResponse.text();
  const events = sse.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)));
  const streamText = events.map(e => e.choices?.[0]?.delta?.content || '').join(''), usage = events.findLast(e => e.usage)?.usage;
  assert.ok(usage, 'Streaming final usage is required'); await claimCase('local buyer stream', before, usage, streamText);

  const hostedPort = await freePort(), hostedToken = randomBytes(32).toString('hex');
  const hostedGateway = new hosted.HostedGateway({ port: hostedPort, host: '127.0.0.1', apiToken: hostedToken, relayerPrivateKey: accounts.seller.privateKey, escrowPoolAddress: CONTRACTS.ESCROW_POOL, rpcUrl, chainId: 97, discoverableModels: [model] }, router, handler, crypto.generateKeyPair());
  cleanup.push(() => hostedGateway.stop()); await hostedGateway.start();
  const client = new sdk.TAM({ baseURL: `http://127.0.0.1:${hostedPort}`, gatewayToken: hostedToken, privateKey: accounts.buyer.privateKey, paymentToken: tokenInfo.symbol, paymentNetwork: 'bsc-testnet', escrowPoolAddress: CONTRACTS.ESCROW_POOL, rpcUrl, chainId: 97, maxRequestCostToken: 3 });
  if (tokenInfo.symbol === 'USDC') {
    const permitBefore = await pool.getBalance(accounts.buyer.address);
    const result = await client.depositWithPermit({ tokenAddress: tokenInfo.address, amount: units('1') });
    assert.equal(await pool.getBalance(accounts.buyer.address), permitBefore + units('1'));
    output.permitDeposit = { amountToken: '1', txHash: result.txHash };
  }
  before = await snapshot(token, pool, accounts);
  const sdkReply = await client.chat.completions.create(request);
  await claimCase('TypeScript SDK hosted nonstream', before, sdkReply.usage, sdkReply.choices[0].message.content);
  before = await snapshot(token, pool, accounts);
  let sdkText = '', sdkUsage;
  for await (const event of await client.chat.completions.create({ ...request, stream: true })) {
    sdkText += event.choices?.[0]?.delta?.content || ''; if (event.usage) sdkUsage = event.usage;
  }
  await claimCase('TypeScript SDK hosted stream', before, sdkUsage, sdkText);
  for (const stream of [false, true]) {
    before = await snapshot(token, pool, accounts);
    const python = await new Promise((resolve, reject) => {
      const child = spawn(process.env.PYTHON_BINARY || 'python', [path.join(repoRoot, 'scripts/smoke-bsc-python.py')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONPATH: path.join(repoRoot, 'packages/agent-sdk/python') + path.delimiter + (process.env.PYTHONPATH || '') } });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const timer = setTimeout(() => child.kill(), 90_000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`Python SDK smoke failed: ${stderr.slice(-2000)}`)); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } } });
      child.stdin.end(JSON.stringify({ baseURL: `http://127.0.0.1:${hostedPort}`, gatewayToken: hostedToken, privateKey: accounts.buyer.privateKey, currency: tokenInfo.symbol, pool: CONTRACTS.ESCROW_POOL, request: { ...request, stream } }));
    });
    await claimCase(`Python SDK hosted ${stream ? 'stream' : 'nonstream'}`, before, python.usage, python.text);
  }

  // Replay the actual first API payment authorization; the chain must skip it without another debit.
  const replayBefore = await snapshot(token, pool, accounts);
  const replayTx = await pool.connect(new ethers.Wallet(accounts.seller.privateKey, provider)).claim([{ ...firstAuth, nonceMode: 1 }], [firstAuth.signature]);
  const replayReceipt = await replayTx.wait(); assert.equal(replayReceipt.status, 1);
  assert.deepEqual(await snapshot(token, pool, accounts), replayBefore);
  assert.ok(replayReceipt.logs.some(log => { try { const event = pool.interface.parseLog(log); return event?.name === 'ClaimSkipped' && event.args.reason === 3n; } catch { return false; } }));
  output.replay = { txHash: replayTx.hash, skippedReason: 'BadNonce', noSecondDebit: true };

  before = await snapshot(token, pool, accounts);
  const failed = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...request, messages: [{ role: 'user', content: 'TAM_INJECT_FAILURE' }] }), signal: AbortSignal.timeout(90_000) });
  await failed.text(); assert.ok(failed.status >= 400, 'Injected upstream failure should fail the request');
  assert.equal(gateway.billing.getQueuedAuthorizationCount(), 0); assert.deepEqual(await snapshot(token, pool, accounts), before);
  output.failure = { httpStatus: failed.status, noCollectibleAuthorization: true, noDebit: true };
  output.upstreamCalls = upstream.counts(); output.finishedAt = new Date().toISOString(); output.status = 'passed';
  output.finalBalances = Object.fromEntries(Object.entries(before).map(([key, value]) => [key, amount(value)]));
  write(`smoke-${tokenInfo.symbol.toLowerCase()}.json`, output);
  console.log(JSON.stringify({ status: 'passed', currency: tokenInfo.symbol, cases: output.cases.length, replayRejected: true, failureUncharged: true, report: path.join(stateDir, `smoke-${tokenInfo.symbol.toLowerCase()}.json`) }));
}

try { await main(); }
catch (error) { output.status = 'failed'; output.error = error.shortMessage || error.message; write(`smoke-${tokenInfo.symbol.toLowerCase()}.json`, output); console.error(output.error); process.exitCode = 1; }
finally { for (const stop of cleanup.reverse()) { try { await stop(); } catch {} } provider.destroy(); }

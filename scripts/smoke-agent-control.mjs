// Exercises the compiled CLI and both SDKs against local mock gateways. No chain or upstream calls.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TAMAgentClient } from '../packages/agent-sdk/dist/index.js';
import { PAYMENT_TOKEN } from '../packages/shared/dist/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const home = mkdtempSync(path.join(os.tmpdir(), 'tam-agent-smoke-'));
const data = path.join(home, '.clawmarket');
mkdirSync(data);
const ownerToken = randomBytes(32).toString('hex');
writeFileSync(path.join(data, 'api-token'), ownerToken, { mode: 0o600 });
const symbol = process.env.CLAWMARKET_PAYMENT_TOKEN === 'BEM' ? 'BEM' : 'USDC';
const pool = process.env.ESCROW_POOL_ADDRESS || '0x1111111111111111111111111111111111111111';
const counters = { invoke: 0, deposit: 0, collect: 0, price: 0 };
let currentPrice = 5;
const mock = http.createServer(async (request, response) => {
  const send = value => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
  if (request.headers.authorization !== `Bearer ${ownerToken}`) { response.statusCode = 401; send({ error: 'local_token_required' }); return; }
  if (request.method === 'GET') {
    send({ paymentToken: PAYMENT_TOKEN, escrowPool: pool, ...(request.url === '/v1/seller/status' ? { escrow: { poolAddress: pool, chainId: PAYMENT_TOKEN.chainId }, backend: { models: [{ model: 'model-a', p0: currentPrice }] }, claims: { queuedCount: 0 } } : request.url === '/v1/credits' ? { address: '0xbuyer', availableToken: '10' } : { providers: [], settlementPool: pool }) });
    return;
  }
  let text = ''; for await (const chunk of request) text += chunk.toString();
  const body = JSON.parse(text);
  switch (request.url) {
    case '/v1/chat/completions':
      ++counters.invoke;
      assert.equal(body.max_cost_token, '1');
      send(body.messages[0].content === 'unknown-result' ? { id: 'missing-fee' } : { id: 'mock-request', choices: [{ message: { content: 'local mock response' } }], tamSettlement: { amountToken: '0.25', seller: '0xseller' } });
      break;
    case '/v1/credits/purchase': ++counters.deposit; send({ approvalTx: '0xmockapproval', depositTx: '0xmockdeposit' }); break;
    case '/v1/seller/claims/flush': ++counters.collect; send({ flushed: true, txHash: '0xmockclaim', claims: { queuedCount: 0 } }); break;
    case '/v1/seller/pricing': ++counters.price; assert.equal(body.maximum, 10); currentPrice = body.p0; send({ updated: true, ...body }); break;
    default: response.statusCode = 404; send({ error: 'not_found' });
  }
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const mockUrl = `http://127.0.0.1:${mock.address().port}`;
const environment = { ...process.env, HOME: home, CLAWMARKET_API_TOKEN: ownerToken, CLAWMARKET_BUYER_URL: mockUrl, CLAWMARKET_SELLER_URL: mockUrl, ESCROW_POOL_ADDRESS: pool };
writeFileSync(path.join(data, symbol === 'BEM' ? 'config-bem.json' : 'config.json'), JSON.stringify({ settlement: { symbol, escrowPoolAddress: pool }, buyer: { url: mockUrl }, seller: { url: mockUrl } }));
const cli = path.join(root, 'packages/cli/dist/index.js');
async function command(executable, args, env = environment) {
  const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const timeout = setTimeout(() => child.kill(), 20_000);
  try { const [code] = await once(child, 'exit'); assert.equal(code, 0, `Local command failed: ${output.replaceAll(ownerToken, '[credential]').replace(/[a-f0-9]{64}/gi, '[credential]')}`); return output; }
  finally { clearTimeout(timeout); }
}
const probe = http.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
let controller;
try {
  controller = spawn(process.execPath, [cli, '--buyer-url', mockUrl, '--seller-url', mockUrl, 'agent', 'serve', '--port', String(port)], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Controller startup timed out')), 15_000);
    controller.stdout.on('data', data => { output += data; if (output.includes('AI 接入地址：')) { clearTimeout(timeout); resolve(); } });
    controller.on('error', error => { clearTimeout(timeout); reject(error); });
    controller.once('exit', () => { clearTimeout(timeout); reject(new Error('Controller exited during startup')); });
  });
  const tokenFile = path.join(data, 'tam-agent-token');
  const client = new TAMAgentClient({ baseURL: `http://127.0.0.1:${port}`, token: readFileSync(tokenFile, 'utf8').trim() });
  assert.equal((await client.status()).policy.paused, true);
  assert.equal((await client.tools()).functionTools.length, 4);
  await assert.rejects(client.deposit('not-authorized', '1'));
  const policyFile = path.join(home, 'owner-policy.json');
  writeFileSync(policyFile, JSON.stringify({ version: 1, paymentSymbol: symbol, paused: false, allowedActions: ['invoke', 'deposit', 'collect', 'price'], dailySpendToken: '2', maxCallToken: '1', dailyDepositToken: '5', models: ['model-a'], sellerPrice: { minimum: 1, maximum: 10, maxChangePercent: 10, minIntervalSeconds: 60 } }));
  await command(process.execPath, [cli, 'agent', 'policy', '--file', policyFile]);
  const params = { model: 'model-a', messages: [{ role: 'user', content: 'typescript-test' }], max_tokens: 50 };
  assert.equal((await client.invoke('ts-call', params)).operation.status, 'succeeded');
  assert.equal((await client.invoke('ts-call', params)).replay, true);
  assert.equal((await client.deposit('deposit-once', '1.5')).operation.status, 'succeeded');
  assert.equal((await client.collect('collect-once')).operation.status, 'succeeded');
  assert.equal((await client.price('price-once', 'model-a', 5.25)).operation.status, 'succeeded');
  assert.deepEqual(counters, { invoke: 1, deposit: 1, collect: 1, price: 1 });
  const python = process.env.TAM_TEST_PYTHON;
  if (python) {
    const result = await command(python, ['-c', `import os, json
from pathlib import Path
from clawmarket_agent_sdk import TAMAgentClient
ai = TAMAgentClient(token=Path(os.environ['TAM_AGENT_TOKEN_FILE']).read_text().strip(), base_url=os.environ['TAM_AGENT_URL'])
assert ai.status()['payment']['symbol'] == '${symbol}'
assert len(ai.tools()['functionTools']) == 4
assert ai.invoke('python-call', {'model':'model-a','messages':[{'role':'user','content':'python-test'}]})['operation']['status'] == 'succeeded'
print(json.dumps({'spent': ai.status()['budget']['spentToken']}))
ai.close()`], { ...environment, PYTHONPATH: path.join(root, 'packages/agent-sdk/python'), TAM_AGENT_TOKEN_FILE: tokenFile, TAM_AGENT_URL: `http://127.0.0.1:${port}` });
    assert.equal(JSON.parse(result.trim()).spent, '0.5');
  }
  const uncertain = await client.invoke('unknown-call', { model: 'model-a', messages: [{ role: 'user', content: 'unknown-result' }] });
  assert.equal(uncertain.operation.status, 'uncertain');
  assert.equal((await client.status()).budget.reservedToken, '1');
  await assert.rejects(client.invoke('new-id-for-unknown', { messages: [{ content: 'unknown-result', role: 'user' }], model: 'model-a' }));
  await command(process.execPath, [cli, 'agent', 'pause']);
  assert.equal((await client.status()).policy.paused, true);
  await assert.rejects(client.collect('paused-collect'));
  const journal = readFileSync(path.join(data, `tam-agent-state-${symbol.toLowerCase()}.json`), 'utf8');
  assert.ok(!journal.includes('typescript-test') && !journal.includes('local mock response') && !journal.includes(ownerToken));
  console.log(JSON.stringify({ currency: symbol, compiledCli: 'passed', typescriptSdk: 'passed', pythonSdk: python ? 'passed' : 'not requested', scopedActions: 'passed', replay: 'passed', uncertainHold: 'passed', ownerPause: 'passed', gateways: 'local mocks', realTransactions: 0 }));
} finally {
  if (controller && controller.exitCode === null) { const exit = once(controller, 'exit'); controller.kill(); await exit; }
  await new Promise(resolve => mock.close(resolve));
  // Only remove this script's newly created temporary directory.
  if (path.dirname(home) === path.resolve(os.tmpdir()) && path.basename(home).startsWith('tam-agent-smoke-')) rmSync(home, { recursive: true, force: true });
}

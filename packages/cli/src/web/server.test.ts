import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { startClientServer, type ClientBackend } from './server.js';

const directories: string[] = [], servers: Awaited<ReturnType<typeof startClientServer>>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(); for (const directory of directories.splice(0)) { if (!path.resolve(directory).startsWith(path.join(os.tmpdir(), 'tam-ui-test-'))) throw new Error('Unexpected test directory'); fs.rmSync(directory, { recursive: true, force: true }); } });
function makeBackend(): ClientBackend & { chat: any; transaction: any } {
  return { profileId: 'test-profile', currencyDecimals: 6, status: vi.fn(async () => ({ buyer: { online: true }, privateKey: undefined })),
    chat: vi.fn(async (_input, onDelta) => { onDelta('你好'); return { id: 'test-response', object: 'chat.completion', created: 1, model: 'test-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '你好' } }] }; }),
    transaction: vi.fn(async () => ({ depositTx: 'test-transaction' })), startBuyer: vi.fn(async () => {}), policy: vi.fn() };
}
async function setup(backend = makeBackend(), directory?: string) {
  if (!directory) { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-ui-test-')); directories.push(directory); }
  const server = await startClientServer({ backend, directory, port: 0 }); servers.push(server);
  const root = await fetch(server.url); const cookie = root.headers.get('set-cookie')!.split(';')[0]; await root.text();
  const get = (route: string, headers = {}) => fetch(server.url + route, { headers: { cookie, ...headers } });
  const post = (route: string, data: unknown, headers = {}) => fetch(server.url + route, { method: 'POST', headers: { cookie, origin: server.url, 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });
  return { server, backend, directory, get, post };
}
const input = { id: 'request-1234567890', model: 'test-model', messages: [{ role: 'user', content: '记住：青色' }, { role: 'assistant', content: '记住了' }, { role: 'user', content: '刚才是什么颜色？' }] };
describe('local browser client', () => {
  it('protects private reads and rejects cross-site, forged-host and unauthenticated owner actions', async () => {
    const client = await setup();
    expect((await fetch(client.server.url + '/api/status')).status).toBe(401);
    expect((await client.get('/api/status')).status).toBe(200);
    expect((await client.get('/api/status', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    const forgedHostStatus = await new Promise<number>(resolve => {
      http.get(client.server.url + '/api/status', { headers: { host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode!); });
    });
    expect(forgedHostStatus).toBe(403);
    expect((await client.post('/api/transaction', { id: input.id, action: 'deposit', amount: '1' }, { origin: 'https://attacker.invalid' })).status).toBe(403);
    expect(client.backend.transaction).not.toHaveBeenCalled();
    expect((await client.get('/api/status')).headers.get('content-security-policy')).toContain("script-src 'self'");
  });
  it('carries conversation context and replays one completed request without invoking the model twice', async () => {
    const client = await setup();
    expect(await (await client.post('/api/chat', input)).text()).toContain('"state":"complete"');
    expect(client.backend.chat.mock.calls[0][0].messages).toEqual(input.messages);
    expect(await (await client.post('/api/chat', input)).text()).toContain('你好');
    expect(client.backend.chat).toHaveBeenCalledTimes(1);
    expect((await client.post('/api/chat', { ...input, messages: [{ role: 'user', content: 'different' }] })).status).toBe(409);
    await client.server.stop(); servers.splice(servers.indexOf(client.server), 1);
    const restarted = await setup(client.backend, client.directory);
    expect(await (await restarted.post('/api/chat', input)).text()).toContain('"state":"complete"');
    expect(client.backend.chat).toHaveBeenCalledTimes(1);
  });
  it('allows only one journal writer even when another UI port is selected', async () => {
    const client = await setup();
    await expect(startClientServer({ backend: client.backend, directory: client.directory, port: 0 })).rejects.toThrow('已在运行');
    await client.server.stop(); servers.splice(servers.indexOf(client.server), 1);
    const restarted = await setup(client.backend, client.directory);
    expect((await restarted.get('/api/status')).status).toBe(200);
  });
  it('continues the original operation when the browser closes its stream', async () => {
    const backend = makeBackend(); let finish!: () => void;
    backend.chat = vi.fn(async (_input, onDelta) => { await new Promise<void>(resolve => { finish = resolve; }); onDelta('完成'); return { id: 'x', object: 'chat.completion', created: 1, model: 'test-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '完成' } }] }; });
    const client = await setup(backend), first = await client.post('/api/chat', input);
    await first.body!.cancel(); finish();
    await vi.waitFor(async () => expect((await (await client.get('/api/operations/' + input.id)).json()).state).toBe('complete'));
    expect(await (await client.post('/api/chat', input)).text()).toContain('完成');
    expect(backend.chat).toHaveBeenCalledTimes(1);
  });
  it('does not retry uncertain funding and refuses excess precision before a financial call', async () => {
    const backend = makeBackend(); backend.transaction.mockRejectedValue(new Error('RPC response lost'));
    const client = await setup(backend), value = { id: input.id, action: 'deposit', amount: '1.000001' };
    expect((await client.post('/api/transaction', { ...value, amount: '0.0000001' })).status).toBe(400);
    expect(backend.transaction).not.toHaveBeenCalled();
    expect((await client.post('/api/transaction', value)).status).toBe(202);
    await vi.waitFor(async () => expect((await (await client.get('/api/operations/' + input.id)).json()).state).toBe('unknown'));
    expect((await (await client.post('/api/transaction', value)).json()).state).toBe('unknown');
    expect(backend.transaction).toHaveBeenCalledTimes(1);
  });
  it('restores interrupted operations as unknown and never resubmits them on restart', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-ui-test-')); directories.push(directory);
    fs.writeFileSync(path.join(directory, 'operations.json'), JSON.stringify({ version: 1, profileId: 'test-profile', operations: [{ id: input.id, kind: 'chat', hash: createHash('sha256').update(JSON.stringify(input)).digest('hex'), state: 'running', content: 'partial', startedAt: 1 }] }));
    const client = await setup(makeBackend(), directory);
    expect(await (await client.post('/api/chat', input)).text()).toContain('"state":"unknown"');
    expect(client.backend.chat).not.toHaveBeenCalled();
  });
  it('rejects incomplete or oversized conversations without invoking a paid service', async () => {
    const client = await setup();
    for (const messages of [[], [{ role: 'assistant', content: 'unfinished' }], [{ role: 'user', content: 'x'.repeat(16001) }]]) expect((await client.post('/api/chat', { ...input, messages })).status).toBe(400);
    expect(client.backend.chat).not.toHaveBeenCalled();
  });
});

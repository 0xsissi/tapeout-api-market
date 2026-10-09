import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ChatResponse } from '../types.js';

export interface ClientChat { id: string; model: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> }
export interface ClientBackend {
  profileId: string;
  currencyDecimals?: number;
  status(): Promise<Record<string, unknown>>;
  chat(input: ClientChat, onDelta: (delta: string) => void): Promise<ChatResponse>;
  transaction(action: string, amount?: string): Promise<unknown>;
  startBuyer(): Promise<void>;
  policy(value: unknown): void;
}
interface Operation {
  id: string; kind: 'chat' | 'transaction'; hash: string; state: 'running' | 'complete' | 'unknown';
  content: string; startedAt: number; endedAt?: number; usage?: ChatResponse['usage']; result?: unknown; error?: string;
}
class ClientError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function json(res: http.ServerResponse, status: number, value: unknown) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
async function body(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 262144) throw new ClientError(413, '输入内容过长。'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { throw new ClientError(400, '请求格式不正确。'); }
}
function validateId(id: unknown): asserts id is string { if (typeof id !== 'string' || !/^[a-z0-9_-]{16,80}$/i.test(id)) throw new ClientError(400, '操作编号无效。'); }
function validateChat(value: any): ClientChat {
  validateId(value.id);
  if (typeof value.model !== 'string' || !/^[a-z0-9._:/-]{1,160}$/i.test(value.model) || !Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 40) throw new ClientError(400, '请选择模型并填写消息。');
  const messages = value.messages.map((m: any) => {
    if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 16000) throw new ClientError(400, '消息格式或长度不正确。');
    return { role: m.role, content: m.content };
  });
  if (messages.at(-1).role !== 'user' || messages.reduce((sum: number, m: any) => sum + m.content.length, 0) > 64000) throw new ClientError(400, '对话过长，请开始一个新对话。');
  return { id: value.id, model: value.model, messages };
}

export async function startClientServer({ backend, directory, assets = path.resolve('apps/client/public'), port = 18500 }: {
  backend: ClientBackend; directory: string; assets?: string; port?: number;
}) {
  if (!path.isAbsolute(directory)) throw new Error('A private absolute client state directory is required');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // A kernel listener protects the journal even when callers choose different UI ports.
  const leasePath = process.platform === 'win32' ? '\\\\.\\pipe\\tam-client-' + createHash('sha256').update(path.resolve(directory).toLowerCase()).digest('hex').slice(0, 32) : path.join(directory, '.client.sock');
  const lease = net.createServer(socket => socket.end());
  const listen = () => new Promise<void>((resolve, reject) => { lease.once('error', reject); lease.listen(leasePath, () => { lease.removeListener('error', reject); resolve(); }); });
  try { await listen(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    if (process.platform === 'win32') throw new Error('此付款配置的客户端已在运行，请打开原来的界面。');
    const alive = await new Promise<boolean>(resolve => { const probe = net.connect(leasePath); probe.once('connect', () => { probe.destroy(); resolve(true); }); probe.once('error', () => resolve(false)); });
    if (alive || !fs.statSync(leasePath).isSocket()) throw new Error('此付款配置的客户端已在运行，请打开原来的界面。');
    fs.unlinkSync(leasePath); await listen();
  }
  try { return await startLockedClientServer({ backend, directory, assets, port }, async () => { await new Promise<void>(resolve => lease.close(() => resolve())); }); }
  catch (error) { await new Promise<void>(resolve => lease.close(() => resolve())); throw error; }
}

async function startLockedClientServer({ backend, directory, assets, port }: { backend: ClientBackend; directory: string; assets: string; port: number }, release: () => Promise<void>) {
  const file = path.join(directory, 'operations.json');
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, profileId: backend.profileId, operations: [] };
  if (saved.version !== 1 || saved.profileId !== backend.profileId || !Array.isArray(saved.operations)) throw new Error('Client journal does not match this payment profile');
  const operations: Operation[] = saved.operations;
  for (const op of operations) if (op.state === 'running') { op.state = 'unknown'; op.error = '客户端重启前的结果尚未确认，请核对余额和交易记录。不会自动重复执行。'; }
  function save() {
    const temp = file + '.tmp'; const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ version: 1, profileId: backend.profileId, operations })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  }
  save();
  const subscribers = new Map<string, Set<http.ServerResponse>>();
  const jobs = new Set<Promise<void>>();
  const session = randomBytes(32).toString('hex'); let actualPort = port;
  const cookieName = () => `tam_client_${actualPort}`;
  let snapshot: Record<string, unknown> | null = null, checkedAt = 0, refreshing: Promise<Record<string, unknown>> | null = null;
  function publicOperation(op: Operation) { const { hash, ...value } = op; return value; }
  function publish(op: Operation) {
    for (const response of subscribers.get(op.id) ?? []) if (!response.destroyed) response.write(`data: ${JSON.stringify(publicOperation(op))}\n\n`);
    if (op.state !== 'running') { for (const response of subscribers.get(op.id) ?? []) response.end(); subscribers.delete(op.id); }
  }
  function reserve(id: string, kind: Operation['kind'], input: unknown) {
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const previous = operations.find(op => op.id === id);
    if (previous) { if (previous.hash !== hash || previous.kind !== kind) throw new ClientError(409, '同一操作编号不能用于不同请求。'); return { op: previous, fresh: false }; }
    if (operations.some(op => op.state === 'running')) throw new ClientError(409, '上一项操作还在进行，请等待结果。');
    if (operations.length >= 200) {
      const removable = operations.findIndex(op => op.state === 'complete');
      if (removable < 0) throw new ClientError(409, '有过多待核对操作，请先检查交易记录。');
      operations.splice(removable, 1);
    }
    const op: Operation = { id, kind, hash, state: 'running', content: '', startedAt: Date.now() };
    operations.push(op); save(); return { op, fresh: true };
  }
  function execute(op: Operation, run: () => Promise<void>) {
    const job = run().then(() => { op.state = 'complete'; }).catch(error => {
      op.state = 'unknown'; op.error = error instanceof Error ? error.message : '操作未完成，请核对结果，不要重复发送。';
    }).finally(() => {
      op.endedAt = Date.now(); checkedAt = 0;
      try { save(); } catch { op.state = 'unknown'; op.error = '操作结果未能保存，请核对余额和交易记录。不会自动重复执行。'; }
      publish(op);
    });
    jobs.add(job); void job.finally(() => jobs.delete(job));
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const allowedHost = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(req.headers.host ?? '');
      if (!allowedHost) throw new ClientError(403, '本机客户端不接受这个站点的请求。');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/health') { json(res, 200, { product: 'Tapeout API Market Client', profileId: backend.profileId }); return; }
      const files: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/ui-lib.js': ['ui-lib.js', 'text/javascript'] };
      if (req.method === 'GET' && files[url.pathname]) {
        if (req.headers['sec-fetch-site'] === 'cross-site' && !(url.pathname === '/' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document')) throw new ClientError(403, '请直接打开本机客户端。');
        if (url.pathname === '/') res.setHeader('Set-Cookie', `${cookieName()}=${session}; HttpOnly; SameSite=Strict; Path=/`);
        const [name, type] = files[url.pathname]; res.writeHead(200, { 'content-type': type + '; charset=utf-8' }); res.end(fs.readFileSync(path.join(assets, name))); return;
      }
      const cookie = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(cookieName() + '='))?.slice(cookieName().length + 1) ?? '';
      if (Buffer.byteLength(cookie) !== Buffer.byteLength(session) || !timingSafeEqual(Buffer.from(cookie), Buffer.from(session))) throw new ClientError(401, '请重新打开客户端页面。');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new ClientError(403, '跨站请求已拒绝。');
      if (req.method === 'POST' && (req.headers.origin !== `http://${req.headers.host}` || !(req.headers['content-type'] ?? '').startsWith('application/json'))) throw new ClientError(403, '操作必须来自当前客户端页面。');
      if (req.method === 'GET' && url.pathname === '/api/status') {
        if (!snapshot || Date.now() - checkedAt > 5000) {
          refreshing ??= backend.status().then(value => { snapshot = value; checkedAt = Date.now(); return value; }).finally(() => { refreshing = null; });
          await refreshing;
        }
        json(res, 200, { ...snapshot, operations: operations.slice(-20).reverse().map(publicOperation) }); return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/operations/')) {
        const op = operations.find(value => value.id === url.pathname.slice('/api/operations/'.length));
        if (!op) throw new ClientError(404, '找不到操作记录。');
        json(res, 200, publicOperation(op)); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        const input = validateChat(await body(req)); const { op, fresh } = reserve(input.id, 'chat', input);
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
        res.write(`data: ${JSON.stringify(publicOperation(op))}\n\n`);
        if (op.state !== 'running') { res.end(); return; }
        const listeners = subscribers.get(op.id) ?? new Set(); listeners.add(res); subscribers.set(op.id, listeners);
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, 10000);
        res.once('close', () => { clearInterval(heartbeat); listeners.delete(res); });
        if (fresh) execute(op, async () => {
          let lastSave = Date.now();
          const response = await backend.chat(input, delta => { op.content += delta; publish(op); if (Date.now() - lastSave > 1000) { save(); lastSave = Date.now(); } });
          op.content = response.choices?.[0]?.message?.content ?? op.content; op.usage = response.usage;
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/transaction') {
        const input = await body(req); validateId(input.id);
        const amountPattern = new RegExp(`^\\d{1,12}(\\.\\d{1,${backend.currencyDecimals ?? 6}})?$`);
        if (!['deposit', 'withdraw-request', 'withdraw-cancel', 'withdraw-complete'].includes(input.action) || (['deposit', 'withdraw-request'].includes(input.action) && (typeof input.amount !== 'string' || !amountPattern.test(input.amount) || Number(input.amount) <= 0))) throw new ClientError(400, '请输入有效的代币数量。');
        const clean = { id: input.id, action: input.action, amount: input.amount ?? null }; const { op, fresh } = reserve(input.id, 'transaction', clean);
        json(res, op.state === 'complete' ? 200 : 202, publicOperation(op));
        if (fresh) execute(op, async () => { op.result = await backend.transaction(clean.action, clean.amount ?? undefined); });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/buyer/start') { await body(req); await backend.startBuyer(); checkedAt = 0; json(res, 200, { started: true }); return; }
      if (req.method === 'POST' && url.pathname === '/api/policy') { backend.policy(await body(req)); checkedAt = 0; json(res, 200, { saved: true }); return; }
      throw new ClientError(404, '页面或接口不存在。');
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof ClientError ? error.status : 503, { error: error instanceof Error ? error.message : '服务暂不可用。' });
      else res.end();
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  actualPort = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${actualPort}`, async stop() { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); await Promise.allSettled(jobs); await release(); } };
}

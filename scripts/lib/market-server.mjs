import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { TEST_ASSETS, FaucetError } from './market-faucet.mjs';

const publicDir = fileURLToPath(new URL('../../apps/marketplace/public/', import.meta.url));
const staticFiles = {
  '/project-brief.css': ['project-brief.css', 'text/css; charset=utf-8'],
  '/project-brief.js': ['project-brief.js', 'text/javascript; charset=utf-8'],
  '/brief-demo-core.js': ['brief-demo-core.js', 'text/javascript; charset=utf-8'],
  '/market-network.js': ['market-network.js', 'text/javascript; charset=utf-8'], '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'], '/i18n-core.js': ['i18n-core.js', 'text/javascript; charset=utf-8'], '/locales/en.json': ['locales/en.json', 'application/json; charset=utf-8'], '/skill.en.md': ['skill.en.md', 'text/plain; charset=utf-8'], '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/skill.md': ['skill.md', 'text/plain; charset=utf-8'], '/llms.txt': ['llms.txt', 'text/plain; charset=utf-8'], '/install.mjs': ['install.mjs', 'text/javascript; charset=utf-8'],
};
function json(res, status, data) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
async function readJson(req) {
  let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 8192) throw new FaucetError(413, 'body_limit', '请求过大。'); }
  try { return JSON.parse(text); } catch { throw new FaucetError(400, 'invalid_json', '请求格式不正确。'); }
}
export function marketClientAddress(req, trustLoopbackProxy = false) {
  const remote = req.socket.remoteAddress ?? 'unknown';
  if (!trustLoopbackProxy || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return remote;
  const forwarded = req.headers['x-forwarded-for'];
  return typeof forwarded === 'string' && isIP(forwarded.trim()) ? forwarded.trim() : remote;
}
export async function startMarketServer({ host = '127.0.0.1', port = 18400, origin, getCatalog, getBootstrapPeers = () => [], faucet, admission, distributionDirectory, trustLoopbackProxy = false }) {
  const clients = new Map(); let inventory, checkedAt = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    try {
      const url = new URL(req.url, 'http://localhost');
      const ip = marketClientAddress(req, trustLoopbackProxy);
      if (url.pathname.startsWith('/api/')) {
        const now = Date.now();
        for (const [key, window] of clients) if (now - window.start > 60_000) clients.delete(key);
        const window = clients.get(ip) ?? { start: now, count: 0 }; clients.set(ip, window);
        if (++window.count > 80 || clients.size > 1000) throw new FaucetError(429, 'rate_limit', '请求过于频繁，请稍后再试。');
      }
      if (req.method === 'GET' && staticFiles[url.pathname]) {
        const [file, type] = staticFiles[url.pathname]; res.writeHead(200, { 'content-type': type }); res.end(fs.readFileSync(path.join(publicDir, file))); return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/downloads/') && distributionDirectory) {
        const name = url.pathname.slice('/downloads/'.length);
        if (!/^(?:latest\.json|tam-client-[a-z0-9.-]{1,60}\.tar\.gz)$/.test(name)) { json(res, 404, { error: { code: 'not_found', message: '文件不存在。' } }); return; }
        const file = path.join(distributionDirectory, name);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { json(res, 404, { error: { code: 'not_found', message: '安装包尚未发布。' } }); return; }
        res.writeHead(200, { 'content-type': name.endsWith('.json') ? 'application/json' : 'application/gzip', 'content-length': fs.statSync(file).size }); const stream = fs.createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res); return;
      }
      if (req.method === 'GET' && url.pathname === '/health') { json(res, 200, { status: 'ok', role: 'market-website' }); return; }
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') { json(res, 200, { version: 1, peers: getBootstrapPeers() }); return; }
      if (req.method === 'GET' && url.pathname === '/api/market') { json(res, 200, getCatalog()); return; }
      if (req.method === 'GET' && url.pathname === '/api/faucet') {
        if (faucet && Date.now() - checkedAt > 30_000) {
          try { inventory = await faucet.chain.inventory(faucet.wallet.address); checkedAt = Date.now(); } catch { inventory = null; }
        }
        json(res, 200, { enabled: !!faucet && !!inventory, chainId: 97, network: 'BSC 测试网', assets: TEST_ASSETS, cooldownHours: 24, dailyLimit: faucet?.dailyLimit ?? 100,
          walletAddress: faucet?.wallet.address, inventory, gasFaucetUrl: 'https://www.bnbchain.org/en/testnet-faucet', testCurrencyOnly: true }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/agent.json') {
        json(res, 200, { name: 'Tapeout API Market', version: 2, testCurrencyOnly: true, chainId: 97, baseURL: origin,
          onboarding: { guide: origin + '/skill.md', guides: { zh: origin + '/skill.md', en: origin + '/skill.en.md' }, supportedLanguages: ['zh', 'en'], discovery: origin + '/llms.txt', installer: origin + '/install.mjs', releaseManifest: origin + '/downloads/latest.json', minimumNodeMajor: 22, admission: admission ? 'seller-review-required' : 'unavailable', automaticAccess: false },
          tools: [
            { name: 'market_list', method: 'GET', path: '/api/market', description: 'Read visible sellers, announcement prices, network and bootstrap health.' },
            { name: 'faucet_info', method: 'GET', path: '/api/faucet', description: 'Read test-token addresses and fixed claim amounts.' },
            { name: 'faucet_challenge', method: 'POST', path: '/api/faucet/challenge', input: { address: 'Ethereum wallet address', currency: ['USDC', 'BEM'] }, description: 'Get a short-lived wallet-ownership message. Sign it locally with the recipient wallet.' },
            { name: 'faucet_claim', method: 'POST', path: '/api/faucet/claim', input: { id: 'challenge id', signature: 'EIP-191 personal signature' }, description: 'Transfer test tokens. Pending results are not confirmed payments. Retry the same id and signature, never a new request while uncertain.' },
            { name: 'faucet_status', method: 'GET', path: '/api/faucet/claims/{id}', description: 'Poll a claim receipt. confirmed means tokens arrived; pending means unknown/unconfirmed.' },
            { name: 'buyer_access_challenge', method: 'POST', path: '/api/admission/challenge', input: { address: 'buyer wallet', sellerAddress: 'seller wallet', currency: ['USDC', 'BEM'] }, description: 'Get an access-application message. It does not grant access or spend funds.' },
            { name: 'buyer_access_apply', method: 'POST', path: '/api/admission/apply', input: { id: 'challenge id', signature: 'EIP-191 ownership signature' }, description: 'Submit for seller review. Never interpret pending as approved.' },
            { name: 'buyer_access_status', method: 'GET', path: '/api/admission/requests/{id}', description: 'Check pending/approved/rejected/expired. Approval is scoped to seller, chain, pool, currency and expiry.' },
          ] }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/admission/approved') {
        if (!admission) throw new FaucetError(503, 'admission_disabled', '申请服务尚未启用。');
        json(res, 200, admission.approved()); return;
      }
      if (req.method === 'GET' && /^\/api\/admission\/requests\/[a-f0-9]{48}$/.test(url.pathname)) {
        if (!admission) throw new FaucetError(503, 'admission_disabled', '申请服务尚未启用。');
        json(res, 200, admission.status(url.pathname.split('/').at(-1))); return;
      }
      if (req.method === 'POST' && ['/api/admission/challenge', '/api/admission/apply'].includes(url.pathname)) {
        if (req.headers.origin && req.headers.origin !== origin) throw new FaucetError(403, 'origin_mismatch', '请在正确的网站上申请。');
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new FaucetError(415, 'content_type', '需要 JSON 请求。');
        if (!admission) throw new FaucetError(503, 'admission_disabled', '申请服务尚未启用。');
        const input = await readJson(req); if (!input || typeof input !== 'object' || Array.isArray(input)) throw new FaucetError(400, 'invalid_request', '需要 JSON 对象。');
        json(res, 200, url.pathname.endsWith('/challenge') ? admission.challenge(input, ip) : admission.submit(input, ip)); return;
      }
      if (req.method === 'POST' && ['/api/faucet/challenge', '/api/faucet/claim'].includes(url.pathname)) {
        if (req.headers.origin && req.headers.origin !== origin) throw new FaucetError(403, 'origin_mismatch', '请在正确的网站上领取。');
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new FaucetError(415, 'content_type', '需要 JSON 请求。');
        if (!faucet) throw new FaucetError(503, 'faucet_disabled', '领币服务尚未启用。');
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new FaucetError(400, 'invalid_request', '需要 JSON 对象。');
        if (url.pathname.endsWith('/challenge')) json(res, 200, faucet.challenge(body, ip));
        else { const result = await faucet.claim(body, ip); checkedAt = 0; json(res, result.status === 'pending' ? 202 : 200, result); }
        return;
      }
      if (req.method === 'GET' && /^\/api\/faucet\/claims\/[a-f0-9]{48}$/.test(url.pathname)) {
        if (!faucet) throw new FaucetError(503, 'faucet_disabled', '领币服务尚未启用。');
        json(res, 200, await faucet.status(url.pathname.split('/').at(-1))); return;
      }
      json(res, 404, { error: { code: 'not_found', message: '页面或接口不存在。' } });
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof FaucetError ? error.status : 503, { error: { code: error instanceof FaucetError ? error.code : 'temporarily_unavailable', message: error instanceof FaucetError ? error.message : '服务暂时不可用，请稍后再试。' } });
      else res.end();
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxConnections = 128;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { port: server.address().port, async stop() { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); } };
}

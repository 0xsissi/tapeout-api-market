import { afterEach, describe, expect, it } from 'vitest';
import { startMarketServer, marketClientAddress } from './market-server.mjs';
const servers: { stop(): Promise<void> }[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(); });
async function setup(faucet?: object) {
  const server = await startMarketServer({ port: 0, origin: 'http://127.0.0.1:18400', getCatalog: () => ({ sellers: [], nodes: [] }), faucet }); servers.push(server);
  const url = `http://127.0.0.1:${server.port}`;
  return { get: (path: string) => fetch(url + path), post: (body: unknown, origin = 'http://127.0.0.1:18400') => fetch(url + '/api/faucet/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) }) };
}
describe('market website HTTP API', () => {
  it('serves configured bootstrap addresses without exposing operator configuration', async () => {
    const peers = ['/dns4/bootstrap.example.com/tcp/9090/p2p/TEST'];
    const server = await startMarketServer({ port: 0, origin: 'http://127.0.0.1:18400', getCatalog: () => ({}), getBootstrapPeers: () => peers }); servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/bootstrap`);
    expect(await response.json()).toEqual({ version: 1, peers });
    expect((await fetch(`http://127.0.0.1:${server.port}/.env`)).status).toBe(404);
  });
  it('accepts one real client IP only from an explicitly trusted local proxy', () => {
    const request = (remote: string, forwarded: string) => ({ socket: { remoteAddress: remote }, headers: { 'x-forwarded-for': forwarded } });
    expect(marketClientAddress(request('127.0.0.1', '198.51.100.1'))).toBe('127.0.0.1');
    expect(marketClientAddress(request('127.0.0.1', '198.51.100.1'), true)).toBe('198.51.100.1');
    expect(marketClientAddress(request('203.0.113.1', '198.51.100.1'), true)).toBe('203.0.113.1');
    expect(marketClientAddress(request('127.0.0.1', '198.51.100.1, 203.0.113.1'), true)).toBe('127.0.0.1');
    expect(marketClientAddress(request('::1', '2001:db8::1'), true)).toBe('2001:db8::1');
  });
  it('serves real source assets with restrictive script policy and truthful disabled faucet', async () => {
    const s = await setup();
    for (const path of ['/', '/app.js', '/project-brief.js', '/brief-demo-core.js', '/market-network.js', '/style.css', '/project-brief.css', '/i18n.js', '/i18n-core.js', '/locales/en.json', '/skill.en.md', '/api/agent.json']) expect((await s.get(path)).status).toBe(200);
    const agent = await (await s.get('/api/agent.json')).json();
    expect(agent.onboarding.supportedLanguages).toEqual(['zh', 'en']);
    expect(agent.onboarding.guides.en).toBe('http://127.0.0.1:18400/skill.en.md');
    const page = await s.get('/'); expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect((await (await s.get('/api/faucet')).json()).enabled).toBe(false); expect((await s.post({ address: '0x1111111111111111111111111111111111111111', currency: 'USDC' })).status).toBe(503);
  });
  it('rejects cross-origin requests, malformed JSON values, oversized bodies, and unknown paths', async () => {
    const s = await setup({ challenge: () => ({ id: 'test' }) });
    expect((await s.post({}, 'https://unrelated.example')).status).toBe(403); expect((await s.post(null)).status).toBe(400);
    expect((await s.post({ extra: 'x'.repeat(9000) })).status).toBe(413); expect((await s.get('/../package.json')).status).toBe(404);
  });
});

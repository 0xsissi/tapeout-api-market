import { TEST_ASSETS } from './market-faucet.mjs';
import { normalizeModelPricing } from '../../packages/shared/dist/index.js';

export function configuredBootstrapSources(raw = process.env.TAM_MARKET_BOOTSTRAP_SOURCES) {
  if (!raw) return [];
  let sources;
  try { sources = JSON.parse(raw); } catch { throw new Error('Invalid TAM_MARKET_BOOTSTRAP_SOURCES'); }
  if (!Array.isArray(sources) || sources.length > 20) throw new Error('Invalid TAM_MARKET_BOOTSTRAP_SOURCES');
  return sources.map((source, index) => {
    let parsed;
    try { parsed = new URL(source?.url); } catch { throw new Error('Invalid bootstrap source URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('Invalid bootstrap source URL');
    const id = source.id ?? `node-${index + 1}`, name = source.name ?? `Bootstrap ${index + 1}`;
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(id) || typeof name !== 'string' || name.length > 100 || /[\x00-\x1f]/.test(name)) throw new Error('Invalid bootstrap source identity');
    return { id, name, host: parsed.hostname.replace(/^\[|\]$/g, ''), url: parsed.origin };
  });
}
export const BOOTSTRAP_SOURCES = configuredBootstrapSources();
const POOLS = { USDC: '0x90D30bA5d3e72A029335D2B879786ba912EA6e5F', BEM: '0xfd95F0cA22D6c2Ca8dE3Bd42f88c6b94ABf6724e' };
const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
const bounded = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);
const price = value => Number.isFinite(value) && value >= 0 && value <= 1_000_000;
export function publicAnnouncement(announcement, observedAt = Date.now()) {
  if (!announcement || !bounded(announcement.peerId, 128) || !/^[a-zA-Z0-9]+$/.test(announcement.peerId) || !address(announcement.walletAddress) || !Array.isArray(announcement.models)) return null;
  const t = announcement.paymentToken;
  if (!t || !address(t.address) || !address(announcement.settlementPool) || !Number.isFinite(announcement.timestamp) || announcement.timestamp > observedAt + 30_000) return null;
  let networkName, asset, pool;
  if (t.chainId === 97 && Object.hasOwn(TEST_ASSETS, t.symbol)) { networkName = 'BSC 测试网'; asset = TEST_ASSETS[t.symbol]; pool = POOLS[t.symbol]; }
  else return null;
  if (t.address.toLowerCase() !== asset.address.toLowerCase() || announcement.settlementPool.toLowerCase() !== pool.toLowerCase() || t.decimals !== asset.decimals) return null;
  const models = announcement.models.slice(0, 100).filter(m => bounded(m?.model, 160) && price(m.inputPer1m) && price(m.outputPer1m) && (m.p0 == null || price(m.p0)) && (m.inputPer1m + m.outputPer1m > 0 || !m.p0)).map(m => normalizeModelPricing(m)).map(m => ({
    model: m.model, inputPer1m: m.inputPer1m, outputPer1m: m.outputPer1m, p0: m.p0,
    dynamic: price(m.p0) && typeof m.alpha === 'number' && m.alpha > 0,
  })).filter(m => price(m.inputPer1m) && price(m.outputPer1m));
  if (!models.length) return null;
  return { peerId: announcement.peerId, walletAddress: announcement.walletAddress, chainId: t.chainId, networkName, currency: t.symbol, tokenSymbol: asset.symbol,
    tokenAddress: asset.address, poolAddress: pool, models, maxConcurrent: Number.isSafeInteger(announcement.maxConcurrent) && announcement.maxConcurrent > 0 ? Math.min(announcement.maxConcurrent, 10_000) : null,
    announcementAt: announcement.timestamp, observedAt, status: observedAt - announcement.timestamp <= 120_000 ? 'reachable' : 'stale',
    multiaddrs: (Array.isArray(announcement.multiaddrs) ? announcement.multiaddrs : []).filter(v => bounded(v, 512) && v.startsWith('/')).slice(0, 10),
    informationSource: 'seller-announcement', authenticityProof: false };
}
export async function probeBootstrap(source, fetchImpl = fetch) {
  const started = Date.now();
  try {
    const response = await fetchImpl(source.url + '/health', { signal: AbortSignal.timeout(4000), redirect: 'error' });
    if (!response.ok) throw new Error('offline');
    const text = await response.text(); if (text.length > 8192) throw new Error('Invalid response');
    const value = JSON.parse(text);
    if (value.status !== 'ok' || value.role !== 'bootstrap-relay' || !bounded(value.peerId, 128)) throw new Error('Invalid health');
    return { id: source.id, name: source.name, host: source.host, role: 'bootstrap-relay', status: 'online', peerId: value.peerId,
      latencyMs: Date.now() - started, connections: Number.isSafeInteger(value.connections) ? Math.max(0, value.connections) : null, checkedAt: Date.now() };
  } catch { return { id: source.id, name: source.name, host: source.host, role: 'bootstrap-relay', status: 'unavailable', checkedAt: Date.now() }; }
}
export function catalogSnapshot({ nodes, sellers, observedAt, now = Date.now() }) {
  const visible = sellers.filter(s => s.chainId === 97 && now - s.observedAt < 600_000).map(s => ({ ...s, status: now - s.observedAt <= 90_000 && now - s.announcementAt <= 120_000 ? 'reachable' : 'stale' }));
  return { name: 'Tapeout API Market', mode: 'live', chainId: 97, networkName: 'BSC 测试网', observedAt, refreshedAt: now, nodes,
    sellers: visible, stats: { onlineNodes: nodes.filter(n => n.status === 'online').length, visibleSellers: visible.filter(s => s.status === 'reachable').length,
      models: new Set(visible.filter(s => s.status === 'reachable').flatMap(s => s.models.map(m => m.model))).size },
    discoveryScope: '当前观察节点可见的卖家，不代表全网完整名单。', pricingNote: '卖家公告价，单位为结算币 / 百万 Token；实际成交前由买家节点重新报价。' };
}

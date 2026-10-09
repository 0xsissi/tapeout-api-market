// A read-only P2P observer; it holds no payment wallet and executes no model requests.
import fs from 'node:fs';
import net from 'node:net';
import { createNode, requestProviderAnnouncement, dialPeerAddress } from '../packages/p2p-node/dist/index.js';
import { DEFAULT_BOOTSTRAP_PEERS } from '../packages/shared/dist/index.js';
import { BOOTSTRAP_SOURCES, publicAnnouncement } from './lib/market-catalog.mjs';
import { planObserverPeers, observerTimeout } from './lib/market-observer-peers.mjs';

const seed = process.env.TAM_MARKET_SEED_FILE ? JSON.parse(fs.readFileSync(process.env.TAM_MARKET_SEED_FILE, 'utf8')) : null;
const seeds = [...DEFAULT_BOOTSTRAP_PEERS, ...(seed?.multiaddrs ?? []), ...(process.env.TAM_MARKET_SELLER_PEERS || '').split(',').filter(Boolean)];
async function freePair() {
  for (let i = 0; i < 20; i++) {
    const a = net.createServer(), b = net.createServer();
    const listen = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    try { await listen(a, 0); const port = a.address().port; await listen(b, port + 1); return port; }
    catch { /* retry a pair */ }
    finally { for (const server of [a, b]) if (server.listening) await new Promise(resolve => server.close(resolve)); }
  }
  throw new Error('No P2P port available');
}
const node = await createNode({ listenHost: '127.0.0.1', listenPort: await freePair(), bootstrapPeers: [] });
await node.start();
const known = new Map(); let running = false, stopping = false, peerCursor = 0;
async function refresh() {
  if (running || stopping) return; running = true;
  try {
    const discovered = await Promise.all(BOOTSTRAP_SOURCES.map(async source => {
      try { const response = await fetch(source.url + '/bootstrap.json', { signal: AbortSignal.timeout(4000), redirect: 'error' }); const text = await response.text(); if (!response.ok || text.length > 100_000) return []; return JSON.parse(text).peers ?? []; } catch { return []; }
    }));
    const plan = planObserverPeers([...seeds, ...discovered.flat(), ...[...known.values()].flatMap(seller => seller.multiaddrs)], peerCursor);
    peerCursor = plan.nextCursor;
    const connected = () => new Set(node.libp2p.getConnections().map(connection => connection.remotePeer.toString()));
    for (let i = 0; i < plan.peers.length; i += 4) await Promise.allSettled(plan.peers.slice(i, i + 4).map(async ({ peerId, addresses }) => {
      if (!connected().has(peerId)) {
        for (const address of addresses) {
          try { await observerTimeout(dialPeerAddress(node.libp2p, address), 5000); break; }
          catch { /* Try another advertised route for this peer. */ }
        }
      }
      if (!connected().has(peerId)) return;
      const raw = await observerTimeout(requestProviderAnnouncement(node.libp2p, peerId), 6000);
      if (raw?.peerId !== peerId) return;
      const safe = publicAnnouncement(raw); if (safe) known.set(`${safe.peerId}:${safe.chainId}:${safe.currency}`, safe);
    }));
    for (const [key, value] of known) if (Date.now() - value.observedAt > 600_000) known.delete(key);
    process.send?.({ type: 'catalog', sellers: [...known.values()], observedAt: Date.now(), connectedPeers: connected().size });
  } catch { process.send?.({ type: 'observer-error' }); }
  finally { running = false; }
}
await refresh();
const timer = setInterval(refresh, 30_000);
async function stop() { if (stopping) return; stopping = true; clearInterval(timer); await node.stop(); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('disconnect', stop);

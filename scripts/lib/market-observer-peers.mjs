// One peer may advertise TCP, WebSocket and multiple relay routes. Limit peers,
// not raw addresses, and rotate rounds so later arrivals cannot be starved.
export function planObserverPeers(addresses, cursor = 0, limit = 24) {
  const grouped = new Map();
  for (const address of addresses) {
    if (typeof address !== 'string' || address.length >= 512 || !/^\/(ip4|ip6|dns4|dns6)\//.test(address)) continue;
    const peerId = address.match(/\/p2p\/([a-zA-Z0-9]{1,128})$/)?.[1];
    if (!peerId) continue;
    const routes = grouped.get(peerId) ?? [];
    if (routes.length < 4 && !routes.includes(address)) routes.push(address);
    grouped.set(peerId, routes);
  }
  const peers = [...grouped].map(([peerId, addresses]) => ({ peerId, addresses }));
  if (!peers.length) return { peers: [], nextCursor: 0 };
  const start = (Math.max(0, Math.trunc(cursor)) || 0) % peers.length;
  const count = Math.min(Math.max(1, Math.trunc(limit)) || 24, peers.length);
  return { peers: Array.from({ length: count }, (_, index) => peers[(start + index) % peers.length]), nextCursor: (start + count) % peers.length };
}

export async function observerTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Observer timeout')), ms);
      timer.unref?.();
    })]);
  } finally { clearTimeout(timer); }
}

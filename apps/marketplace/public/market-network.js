// Expire online labels even if the website cannot fetch another snapshot.
export function networkSnapshot(catalog, now = Date.now()) {
  const nodes = (catalog?.nodes ?? []).map(node => ({ ...node,
    status: node.status === 'online' && now - node.checkedAt > 90_000 ? 'stale' : node.status,
  }));
  const sellers = (catalog?.sellers ?? []).filter(seller => seller.chainId === 97 && now - seller.observedAt < 600_000).map(seller => ({ ...seller,
    status: seller.status === 'reachable' && now - seller.observedAt <= 90_000 && now - seller.announcementAt <= 120_000 ? 'reachable' : 'stale',
  })).sort((a, b) => b.observedAt - a.observedAt);
  return { nodes, sellers };
}

// Timer, manual refresh and tab activation share one request. Older responses
// cannot overwrite a newer catalog, and repeated clicks do not duplicate traffic.
export function createCatalogRefresher({ read, onCatalog, onError, onBusy = () => {} }) {
  let pending;
  return function refresh() {
    if (pending) return pending;
    onBusy(true);
    pending = Promise.resolve().then(read).then(onCatalog).catch(onError).finally(() => {
      pending = undefined;
      onBusy(false);
    });
    return pending;
  };
}

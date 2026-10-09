# Network discovery and relay configuration

TAM publishes no operator IPs, SSH credentials or deployed node IDs in source. Nodes discover services through P2P; bootstrap and relay servers help establish connections, while the buyer chooses the seller.

Buyer and seller launch scripts use `https://shenjige.xyz/api/bootstrap` for the pilot's read-only bootstrap manifest. Operators may replace it or provide explicit peers:

```sh
BOOTSTRAP_MANIFEST_URLS=https://bootstrap.example.com/bootstrap.json
BOOTSTRAP_PEERS="<operator-provided multiaddr>"
```

Set `BOOTSTRAP_MANIFEST_URLS` to an empty value to disable the default manifest. `BOOTSTRAP_MANIFEST_FILES`, `BOOTSTRAP_CACHE_PATH` and `BOOTSTRAP_PEER_CACHE_PATH` can provide local manifests and recovery caches. These files are private runtime data, outside the checkout.

The CLI also accepts `CLAWMARKET_BOOTSTRAP_PEERS`. `TAM_RETIRED_BOOTSTRAP_PEERS` can identify operator-specified addresses to remove from old saved configurations; there is no embedded list of past operators.

Bootstrap deployment uses `ANNOUNCE_HOST`, `P2P_LISTEN_PORT` and a persistent `P2P_IDENTITY_PATH`. Never commit the identity key. Each operator chooses its own host, service user, protected data directory and firewall rules. Generic templates are in `deploy/`.

A market website operator supplies `TAM_MARKET_BOOTSTRAP_SOURCES` as a JSON array of objects with `id`, optional `name` and a public read-only HTTP(S) origin in `url`. Sources do not permit embedded credentials. The website's `/api/bootstrap` exposes online bootstrap multiaddrs, never SSH access or private configuration. If no sources are configured, the public list is empty.

Seller review additionally uses `TAM_ADMISSION_SELLERS`, a comma-separated list of wallets accepted by that operator. No deployed seller is enabled implicitly. Other sellers manage buyer access themselves.

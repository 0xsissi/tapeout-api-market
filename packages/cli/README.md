# Tapeout API Market (TAM) CLI

The CLI can run both buyer and seller local runtimes. AIMM seller mode uses CUC pricing with a base price `p0`, curve slope `alpha`, quota-window utilization, and quote gossip.

Installed CLI packages expose `tam` and the compatibility alias `clawmarket`. In a source checkout, build from the repository root with `corepack pnpm cli:build`, then use `corepack pnpm tam --help`. Existing configuration and wallets remain in `~/.clawmarket`.

## Seller AIMM Options

- `tam seller up --p0 <price>` sets the AIMM base price in USDC per 1M tokens.
- `tam seller up --alpha <value>` sets the CUC slope. `0` behaves like a fixed price; `1` is the balanced default.
- `tam seller up --max-concurrent <count>` sets local admission capacity. This is not used in CUC pricing.
- `tam seller up --signing-identity-path <path>` stores the hot quote-signing key separately from the settlement wallet.
- `tam doctor` checks buyer/seller health and AIMM metrics endpoints.

The settlement wallet remains the on-chain identity, while AIMM quotes are signed by a delegated hot signing key.

# Tapeout API Market (TAM)

去中心化 AI API 市场。Decentralized AI API Marketplace.

卖家发布模型和价格，买方网关自己比价选卖家。完整收到回答后签付款账单，卖家把多笔账单一起提交合约收款。你的 AI 可以在你设定的额度与权限内操作。

Website: [shenjige.xyz](https://shenjige.xyz/) · [中文介绍](docs/project-introduction-zh.md) · [AI setup guide](apps/marketplace/public/skill.en.md)

## What is implemented

- **AIMM pricing:** prices adjust with capacity use; sellers can also keep fixed prices. Each request locks a signed quote before execution.
- **Off-chain receipts and on-chain escrow:** a budget intent cannot collect funds. Buyers sign a collectible receipt after complete delivery; sellers batch receipts to share transaction overhead.
- **P2P discovery and buyer routing:** each buyer gateway selects a seller. Bootstrap and relay nodes help connections without assigning orders.
- **Agent tools:** compatible API, TypeScript/Python SDKs and local management tools, with owner-defined permissions and budgets.
- **Model-origin interfaces:** proof generation and verification adapters are reserved for future zkTLS integration. Real zkTLS verification is not implemented yet.

The pilot uses **BSC Testnet, chain 97**. Sellers choose tUSDC or tBEM pricing and settlement; the tokens are independent and are not automatically exchanged. Test tokens have no mainnet value. Model identity and usage are currently seller-reported; vetted buyers are required and public dispute arbitration is not implemented.

## Run from source

Requires Node.js 22+ and pnpm 10.18.3.

```sh
git clone https://github.com/0xsissi/tapeout-api-market.git
cd tapeout-api-market
corepack pnpm install --frozen-lockfile
corepack pnpm cli:build
corepack pnpm tam console
```

The console starts the buyer service by default. Set limits before calling models or depositing a budget. Seller operation additionally requires an upstream model source, prices and trusted-buyer settings. Opening the console does not deposit funds or call a model.

```sh
corepack pnpm tam --lang en console
corepack pnpm tam --payment-token BEM console
corepack pnpm market:web
```

Website preview: `http://127.0.0.1:18400`. A preview without a separately configured faucet wallet is read-only. The browser client uses `corepack pnpm tam ui`; agent management uses `corepack pnpm tam agent serve`.

## Network configuration

Operator IP addresses, SSH details and deployed seller accounts are not part of the source tree. Buyer/seller launch scripts read a public bootstrap manifest at `https://shenjige.xyz/api/bootstrap`, or an operator-selected `BOOTSTRAP_MANIFEST_URLS`. `CLAWMARKET_BOOTSTRAP_PEERS` / `BOOTSTRAP_PEERS` can supply static peers. Private configuration and cached peers stay outside Git.

A website operator sets `TAM_MARKET_BOOTSTRAP_SOURCES` and, if access review is enabled, `TAM_ADMISSION_SELLERS`. See [network setup](docs/public-network-20261007.md) and [website configuration](docs/market-website.md).

## Documentation

- [BSC Testnet setup and SDK examples](docs/bsc-testnet-local-integration.md)
- [Test-token and pool addresses](docs/bsc-testnet-deployment.md)
- [Delivery-confirmed settlement and recovery](docs/delivery-confirmed-settlement.md)
- [AIMM formula and architecture](docs/aimm/README.md)
- [AI permissions and management tools](docs/agent-first-operations.md)
- [Model-origin / zkTLS adapters](docs/model-provenance-zktls.md)
- [Privacy and publication checks](docs/publication-privacy.md)

Existing `ClawMarket` protocol, package and configuration names remain for compatibility. CLI packages expose `tam` and the legacy command. The current inference protocol is 3.0.0; update buyer, seller and SDKs together.

## Development checks

```sh
corepack pnpm privacy:check
corepack pnpm test
```

Operational reports, screenshots, accounts, keys and transaction journals are local data and are excluded from Git. Test fixtures use synthetic values; never fund a wallet derived from a test fixture key.

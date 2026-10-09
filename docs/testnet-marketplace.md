# Base Sepolia Marketplace Runbook

目标是让 seller 真正挂到 Base Sepolia 上，buyer 在另一台机器本地跑自己的 gateway，通过 P2P 发现 seller，并用 USDC 从 `EscrowPool` 支付算力。

## 当前 Base Sepolia 部署

- `chainId`: `84532`
- `rpcUrl`: `https://sepolia.base.org`
- `EscrowPool`: `0x8A392a77eb88f477FeF060033937a2e4692Eb56E`
- `绑定的 USDC`: `0xcF0819eb156D6c6c1c5d9A515E351D2D1aefff7D`
- `MiningRewards`: `0x6f090F5Af7d53773E7a834F83C18A785Bec06C82`
- `部署者 / treasury`: `0xAc67b6cC14AF9BEd4EF10162A0D1Ce3959879295`
- `部署脚本`: `packages/contracts/script/DeployEscrowPoolOnly.s.sol`
- `部署时间记录`: `2026-04-24 11:20`

2026-04-24 已通过 Base Sepolia RPC 核对：新 `EscrowPool` 地址有合约代码，`usdc()` 返回上述项目 USDC，`miningRewards()` 返回上述 MiningRewards，`getClaimableBalance()` / `getWithdrawableBalance()` 可调用，`protocolFeeBps()` 为 `100`，且 `MiningRewards.authorisedCallers(newPool)=true`。

同日还完成了真实链路验证：

- 本机 buyer -> `203.0.113.30` seller 的 `gpt-5.4` 非流式请求，已返回真实正文 `ok`
- 同一链路的流式请求，已返回真实 `stream_chunk` 和 `stream_end`
- seller 侧 `cliproxy` 返回 `HTTP 200`，并完成了一笔真实 `claim`

这轮最后定位出的根因是 buyer 节点的 libp2p `AutoNAT`。它会在可达性探测里关闭复用到的业务连接，导致 seller 写正文前就看到 stream closed。当前仓库已改成默认不启用 `autoNAT`，避免再次打断业务流。

## 1. 启动公网 bootstrap 节点

在一台有公网 IP 或 DNS 的机器上运行：

```bash
ANNOUNCE_HOST=your.public.ip.or.dns \
P2P_LISTEN_PORT=9090 \
P2P_IDENTITY_PATH=/var/lib/clawmarket/bootstrap.key \
BOOTSTRAP_MANIFEST_OUT=/var/www/clawmarket/bootstrap.json \
npm run bootstrap:testnet
```

启动后会打印两条 `bootstrap peer` multiaddr，把它们原样复制给 seller 和 buyer 的 `BOOTSTRAP_PEERS`。
当前代码内置的冷启动公网入口是：

```text
/ip4/203.0.113.30/tcp/9090/p2p/12D3KooWQAkEhTBji6Q7dQCMYyhxGCbamo8G46JVnLo2LM2xG5VA
/ip4/203.0.113.30/tcp/9091/ws/p2p/12D3KooWQAkEhTBji6Q7dQCMYyhxGCbamo8G46JVnLo2LM2xG5VA
```

如果 buyer / seller 已经加入过网络，建议再配一个 `BOOTSTRAP_PEER_CACHE_PATH`。
节点会把最近成功连通过的公网 peers 记到本地；以后某台 bootstrap 下线时，重启后的节点会先试这些“已知好入口”。

## 2. 启动 seller

seller 机器现在支持三种后端来源，都会走同一条卖家结算 / claim / 挖矿链路：

- 内嵌 `CLIProxyAPI`，直接把本机 Codex 月订阅额度变成 API：`EMBED_CLIPROXY=true`
- 直接配置 OpenAI 兼容上游，例如 Codex 反代：`UPSTREAM_BASE_URL` + `UPSTREAM_API_KEY`
- 复用旧的代理入口：`PROXY_URL` + `PROXY_HEADERS_JSON`
- 读取本机卖家档案：`SELLER_PROFILE_PATH`，默认会找 `~/.clawmarket/seller.json`

只要后端能处理 `/v1/chat/completions`，buyer 通过市场买到的请求都会记到这个 seller 身上。

如果 seller 走的是 OpenAI 兼容反代，而且没有显式传 `MODELS_JSON`，当前代码会优先尝试读取该后端的 `/v1/models` 来自动生成 seller 对外公告的模型列表。
buyer 侧的 `/v1/models` 也不再只依赖固定白名单，而会动态汇总已经发现/已经连接到的 seller announcement 里的模型名。
`REFRESH_MODELS` 仍然建议保留，用来做冷启动提示和加速首轮发现，但不再是买家看见新模型的唯一来源。

### 2.1 内嵌 CLIProxyAPI，直接卖 Codex 月订阅额度

先登录一次，把 Codex OAuth 凭据写进卖家自己的工作目录：

```bash
EMBED_CLIPROXY=true \
CLIPROXY_SOURCE_DIR=/absolute/path/to/CLIProxyAPI \
CLIPROXY_WORK_DIR=~/.clawmarket/embedded-cliproxy \
corepack pnpm seller:codex-login
```

如果你更适合设备码登录：

```bash
EMBED_CLIPROXY=true \
CLIPROXY_SOURCE_DIR=/absolute/path/to/CLIProxyAPI \
CLIPROXY_WORK_DIR=~/.clawmarket/embedded-cliproxy \
corepack pnpm seller:codex-device-login
```

登录完成后，直接启动 seller。脚本会自动：

- 生成最小 `config.yaml`
- 启动本地 `CLIProxyAPI`
- 从本地 `cliproxy` 的 `/v1/models` 读取可卖模型
- 把这些请求继续走 Tapeout API Market 的授权、结算、claim 与挖矿流程

```bash
PROVIDER_PRIVATE_KEY=0x... \
EMBED_CLIPROXY=true \
CLIPROXY_SOURCE_DIR=/absolute/path/to/CLIProxyAPI \
CLIPROXY_WORK_DIR=~/.clawmarket/embedded-cliproxy \
CLIPROXY_EXPOSE_MODELS=gpt-5.4,gpt-5.4-mini \
CLIPROXY_INPUT_PER_1M=10000 \
CLIPROXY_OUTPUT_PER_1M=10000 \
ANNOUNCE_HOST=seller.public.ip.or.dns \
BOOTSTRAP_PEERS="/dns4/bootstrap.example.com/tcp/9090/p2p/...,/dns4/bootstrap.example.com/tcp/9091/ws/p2p/..." \
BOOTSTRAP_PEER_CACHE_PATH=/var/lib/clawmarket/known-public-peers.seller.json \
ESCROW_POOL_ADDRESS=0x8A392a77eb88f477FeF060033937a2e4692Eb56E \
MINING_REWARDS_ADDRESS=0x6f090F5Af7d53773E7a834F83C18A785Bec06C82 \
SELLER_STATUS_PORT=8787 \
npm run seller:testnet
```

### 2.2 直连 OpenAI 兼容上游（推荐给已有反代）

```bash
PROVIDER_PRIVATE_KEY=0x... \
UPSTREAM_BASE_URL=https://codex-proxy.example.com \
UPSTREAM_API_KEY=your-token \
UPSTREAM_MODEL=gpt-5.4 \
UPSTREAM_INPUT_PER_1M=10000 \
UPSTREAM_OUTPUT_PER_1M=10000 \
ANNOUNCE_HOST=seller.public.ip.or.dns \
BOOTSTRAP_PEERS="/dns4/bootstrap.example.com/tcp/9090/p2p/...,/dns4/bootstrap.example.com/tcp/9091/ws/p2p/..." \
BOOTSTRAP_MANIFEST_URLS="https://bootstrap.example.com/bootstrap.json" \
BOOTSTRAP_CACHE_PATH=/var/lib/clawmarket/bootstrap-cache.json \
BOOTSTRAP_PEER_CACHE_PATH=/var/lib/clawmarket/known-public-peers.seller.json \
ESCROW_POOL_ADDRESS=0x8A392a77eb88f477FeF060033937a2e4692Eb56E \
P2P_IDENTITY_PATH=/var/lib/clawmarket/seller.key \
npm run seller:testnet
```

### 2.3 继续走旧的代理入口

```bash
PROVIDER_PRIVATE_KEY=0x... \
PROXY_URL=http://127.0.0.1:4000 \
PROXY_HEADERS_JSON='{"Authorization":"Bearer ..."}' \
MODELS_JSON='[{"model":"gpt-4o-mini","inputPer1m":80,"outputPer1m":80}]' \
ANNOUNCE_HOST=seller.public.ip.or.dns \
BOOTSTRAP_PEERS="/dns4/bootstrap.example.com/tcp/9090/p2p/...,/dns4/bootstrap.example.com/tcp/9091/ws/p2p/..." \
BOOTSTRAP_MANIFEST_URLS="https://bootstrap.example.com/bootstrap.json" \
BOOTSTRAP_CACHE_PATH=/var/lib/clawmarket/bootstrap-cache.json \
BOOTSTRAP_PEER_CACHE_PATH=/var/lib/clawmarket/known-public-peers.seller.json \
ESCROW_POOL_ADDRESS=0x8A392a77eb88f477FeF060033937a2e4692Eb56E \
P2P_IDENTITY_PATH=/var/lib/clawmarket/seller.key \
npm run seller:testnet
```

### 2.4 读取 `~/.clawmarket/seller.json`

如果本机已经有卖家档案，也可以不传 `UPSTREAM_*` / `PROXY_*`，脚本会默认读取：

```bash
SELLER_PROFILE_PATH=~/.clawmarket/seller.json \
PROVIDER_PRIVATE_KEY=0x... \
ANNOUNCE_HOST=seller.public.ip.or.dns \
BOOTSTRAP_PEERS="/dns4/bootstrap.example.com/tcp/9090/p2p/...,/dns4/bootstrap.example.com/tcp/9091/ws/p2p/..." \
ESCROW_POOL_ADDRESS=0x8A392a77eb88f477FeF060033937a2e4692Eb56E \
npm run seller:testnet
```

seller 上线成功后，会打印自己的 `Peer ID` 和可达 multiaddr。
同时会打印一段 `Seed bundle for buyers` JSON；如果你想先跳过 DHT 自动发现，直接把这段 JSON 发给 buyer 即可。
如果上游需要额外鉴权头，可以通过 `UPSTREAM_HEADERS_JSON` 传进去；旧模式仍然支持 `PROXY_HEADERS_JSON`。
`UPSTREAM_BASE_URL` 和 `PROXY_URL` 都支持带路径前缀，例如 `https://api.example.com/cliproxy`。

如果设置了 `SELLER_STATUS_PORT`，seller 还会在本机暴露状态 API：

- `GET /health`
- `GET /v1/seller/status`：查看钱包、peer、模型、claim 队列、并发保护和 mining 配置状态
- `POST /v1/seller/claims/flush`：手动把已排队的授权提交到 `EscrowPool.claim`

示例：

```bash
curl http://127.0.0.1:8787/v1/seller/status
```

当前 `MiningRewards` 合约已部署并绑定到 `EscrowPool`，但客户端侧 `MiningReporter` 还没有按最新合约 ABI 接上；seller status 会如实显示 `not_configured`，不会假装能单独 claim 挖矿积分。结算产生的挖矿记录目前由 `EscrowPool.claim` 内部调用 `MiningRewards.recordSettlement`。

## 3. 启动 buyer

buyer 机器本地启动 gateway，所有应用流量都打到这个本地端口。

在启动前，buyer 钱包需要已经把测试网 USDC `deposit` 到 `EscrowPool`。

```bash
BUYER_PRIVATE_KEY=0x... \
BOOTSTRAP_PEERS="/dns4/bootstrap.example.com/tcp/9090/p2p/...,/dns4/bootstrap.example.com/tcp/9091/ws/p2p/..." \
BOOTSTRAP_MANIFEST_URLS="https://bootstrap.example.com/bootstrap.json" \
BOOTSTRAP_CACHE_PATH=/var/lib/clawmarket/bootstrap-cache.json \
BOOTSTRAP_PEER_CACHE_PATH=/var/lib/clawmarket/known-public-peers.buyer.json \
REFRESH_MODELS=gpt-4o-mini \
ESCROW_POOL_ADDRESS=0x8A392a77eb88f477FeF060033937a2e4692Eb56E \
CONSUMER_PORT=8080 \
P2P_IDENTITY_PATH=/var/lib/clawmarket/buyer.key \
npm run buyer:testnet
```

如果你想直接连接某个 seller，而不等 DHT 自动发现，可以追加：

```bash
SEED_PROVIDERS_FILE=/path/to/seller-seed.json
```

或者直接传 seller 输出的 JSON：

```bash
SEED_PROVIDERS_JSON='{"announcement": {...}, "multiaddrs": [...]}'
```

启动后，本地会暴露：

- `GET /health`
- `GET /v1/models`
- `GET /v1/wallet`
- `GET /v1/escrow/balance`
- `GET /v1/credits`
- `POST /v1/escrow/deposit`
- `POST /v1/credits/purchase`
- `POST /v1/escrow/withdraw/request`
- `POST /v1/escrow/withdraw/cancel`
- `POST /v1/escrow/withdraw/complete`
- `POST /v1/chat/completions`

`/v1/credits/purchase` 会先自动检查项目 USDC 对 `EscrowPool` 的 allowance，不够就发 `approve`，然后再 `deposit`。这就是本机 buyer 从钱包购买 API token / 额度的入口。

### 3.1 用交互式 CLI 操作 buyer / seller

仓库现在已经带了第一版 `clawmarket` CLI。先构建，然后直接进入交互界面：

```bash
corepack pnpm cli
```

默认会连接：

- buyer: `http://127.0.0.1:18080`
- seller status: `http://127.0.0.1:8787`

如果你想改默认地址，可以在启动前设置：

```bash
CLAWMARKET_BUYER_URL=http://127.0.0.1:8080 \
CLAWMARKET_SELLER_URL=http://127.0.0.1:8787 \
corepack pnpm cli
```

也可以直接走命令式子命令：

```bash
corepack pnpm cli -- buyer status
corepack pnpm cli -- buyer guide
corepack pnpm cli -- buyer chat "回复一个 ok"
corepack pnpm cli -- buyer purchase --amount 0.01
corepack pnpm cli -- buyer watch
corepack pnpm cli -- seller status
corepack pnpm cli -- seller watch
corepack pnpm cli -- seller flush-claims
corepack pnpm cli -- doctor
```

这版 CLI 的目标不是替代 GUI，而是先解决“节点启动后不知道下一步干什么”的问题：

- buyer 看余额、额度和提问入口
- buyer 用 `guide` / `watch` 直接看到本机 API 地址、`curl` 示例、额度充值和扣费反馈
- seller 看模型、claim 队列、保护状态，也可以开着 `seller watch` 观察收益队列变化
- `doctor` 快速检查本机 buyer / seller 服务是否在线

## 4. buyer 下单示例

```bash
curl http://127.0.0.1:8080/v1/models
```

查询钱包与额度：

```bash
curl http://127.0.0.1:8080/v1/credits
```

购买 5 USDC 的 API 额度：

```bash
curl http://127.0.0.1:8080/v1/credits/purchase \
  -H 'Content-Type: application/json' \
  -d '{ "amountUsd": 5 }'
```

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-4o-mini",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Say hello from Base Sepolia." }
    ]
  }'
```

## 5. 仓库内置验证命令

真实链上结算 smoke：

```bash
npm run smoke:base-sepolia
```

真实 DHT 发现 + Base Sepolia 结算 smoke：

```bash
npm run smoke:discovery:base-sepolia
```

第二条会在本机起 bootstrap、seller、buyer 和 fake proxy，但支付授权与 claim 仍然会走真实 Base Sepolia。

建议所有长期运行的节点都设置 `P2P_IDENTITY_PATH`，这样重启后 `Peer ID` 不会变化。
建议 buyer / seller 同时配置 `BOOTSTRAP_PEERS` 和 `BOOTSTRAP_MANIFEST_URLS`，前者兜底，后者负责后续更新。
建议 buyer / seller 再加上 `BOOTSTRAP_PEER_CACHE_PATH`，让节点在跑网络时自动记住并复用曾经连通过的公网 peers。

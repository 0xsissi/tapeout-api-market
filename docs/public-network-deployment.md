# Public Network Deployment

这份文档描述的是“通用部署方式”，不是给某两台服务器写死的专用代码。

同一套程序可以部署到任意机器上，真正因机器不同而变化的只有环境变量：

- `ANNOUNCE_HOST`
- `P2P_LISTEN_PORT`
- `BOOTSTRAP_PEERS`
- `BOOTSTRAP_MANIFEST_URLS`
- `BOOTSTRAP_CACHE_PATH`
- `BOOTSTRAP_PEER_CACHE_PATH`
- `P2P_IDENTITY_PATH`
- `SELLER_STATUS_PORT`
- 钱包私钥和 OpenAI 兼容后端配置

## 连接说明

`packages/p2p-node` 默认不启用 AutoNAT；只有显式配置 `enableAutoNAT: true` 时启用。

## 1. 节点身份持久化

现在 `bootstrap:testnet`、`seller:testnet`、`buyer:testnet` 都支持：

- `P2P_IDENTITY_PATH=/var/lib/clawmarket/<role>.key`

首次启动时脚本会自动生成 Ed25519 节点私钥并写入这个文件。
后续重启会复用同一份身份，所以：

- `Peer ID` 不会变化
- 对外公布的 bootstrap multiaddr 可以长期稳定
- systemd 重启后不需要重新通知所有客户端

## 2. 两台长期在线服务器的推荐角色

如果你现在有两台长期在线服务器，建议先这样分：

- 服务器 A：`bootstrap + relay`
- 服务器 B：`bootstrap + relay`

seller 可以先跑在你自己的业务机器上，也可以先临时挂在其中一台上。

## 3. 公共 bootstrap 列表的分发和更新

现在支持两种方式：

- 静态 `BOOTSTRAP_PEERS`
- 动态 `BOOTSTRAP_MANIFEST_URLS`
- 本地 `BOOTSTRAP_PEER_CACHE_PATH`

推荐做法是两者同时配置：

- `BOOTSTRAP_PEERS` 作为冷启动兜底
- `BOOTSTRAP_MANIFEST_URLS` 作为运行中的列表更新来源
- `BOOTSTRAP_CACHE_PATH` 作为 manifest 拉取失败时的本地缓存
- `BOOTSTRAP_PEER_CACHE_PATH` 作为“已知好公网 peers”缓存

bootstrap 节点可以通过 `BOOTSTRAP_MANIFEST_OUT` 生成一个标准 JSON 文件，挂到静态站点或 nginx 下。

seller / buyer 启动后会：

1. 先合并静态 peers + manifest peers
2. 读取上一次成功连通过的公网 peers
3. 定时刷新 manifest
4. 主动重拨这些 bootstrap peers，尽量维持到 relay/入口节点的连接
5. 把成功连通过的公网 peers 持久化到 `BOOTSTRAP_PEER_CACHE_PATH`

这能明显提升：

- 公共入口的分发能力
- bootstrap 列表更新速度
- NAT 后节点对 relay 的依赖稳定性
- 单台 bootstrap 临时下线后的重连成功率

## 3.5 社区 bootstrap / relay

这套程序不要求 bootstrap 必须是“官方服务器”。

任何满足下面条件的用户都可以充当公共入口节点：

- 有公网 IP 或稳定 DNS
- 能长期在线
- 愿意开放 `P2P_LISTEN_PORT` 和 websocket 端口

推荐的简单机制是：

- 保留少量默认 `BOOTSTRAP_PEERS` 作为冷启动入口
- 社区公网节点自己运行 `bootstrap:testnet`
- 这些节点把自己写进 `BOOTSTRAP_MANIFEST_OUT`
- buyer / seller 通过 `BOOTSTRAP_MANIFEST_URLS` 持续更新列表
- buyer / seller 通过 `BOOTSTRAP_PEER_CACHE_PATH` 自动记住曾经连通过的公网 peers

这样即使未来没有单一官方服务器，只要网络里仍然有一些社区公网节点持续在线，老节点和重启后的节点仍然能自动续上网络。
真正无法完全靠网络自愈的场景只剩下“全新安装、没有任何静态入口、没有缓存、也没有 manifest 地址”的纯冷启动。

## 4. 环境变量样板

仓库里已经带了通用样板：

- `deploy/env/bootstrap.env.example`
- `deploy/env/seller.env.example`
- `deploy/env/buyer.env.example`

你只需要复制后改成真实值。

当前 Base Sepolia 默认合约是：

- `EscrowPool`: `0x8A392a77eb88f477FeF060033937a2e4692Eb56E`
- `项目 USDC`: `0xcF0819eb156D6c6c1c5d9A515E351D2D1aefff7D`
- `MiningRewards`: `0x6f090F5Af7d53773E7a834F83C18A785Bec06C82`

## 5. systemd 模板

仓库里也带了通用的 service 模板：

- `deploy/systemd/clawmarket-bootstrap.service.example`
- `deploy/systemd/clawmarket-seller.service.example`
- `deploy/systemd/clawmarket-buyer.service.example`

它们都走同一套 `npm run ...` 命令，不依赖特定机器。

## 6. 最小部署步骤

### 6.1 两台 bootstrap

服务器 A 和 B 都部署代码后：

1. 复制 `deploy/env/bootstrap.env.example` 到实际环境文件
2. 设置不同的 `ANNOUNCE_HOST`
3. 设置 `P2P_IDENTITY_PATH`
4. 设置 `BOOTSTRAP_MANIFEST_OUT`
5. 如果是第二台 bootstrap，把第一台 peer 放进 `BOOTSTRAP_EXTRA_PEERS`
6. 启动 `clawmarket-bootstrap.service`
7. 记录输出的 `Peer ID`

拿到两台机器的 `Peer ID` 之后，整理出统一的 `BOOTSTRAP_PEERS`：

```text
/dns4/bootstrap-a.example.com/tcp/9090/p2p/<PEER_ID_A>,/dns4/bootstrap-b.example.com/tcp/9090/p2p/<PEER_ID_B>
```

如果你要开放 websocket 入口，也可以再补上 `9091/ws` 版本。

### 6.2 seller

1. 复制 `deploy/env/seller.env.example`
2. 配好：
   - `PROVIDER_PRIVATE_KEY`
   - 任选一组后端配置：
   - `EMBED_CLIPROXY=true` + `CLIPROXY_SOURCE_DIR` + `CLIPROXY_WORK_DIR`
   - `UPSTREAM_BASE_URL` + `UPSTREAM_API_KEY`
   - 或 `PROXY_URL` + `PROXY_HEADERS_JSON`
   - 或 `SELLER_PROFILE_PATH`
   - `MODELS_JSON` 或 `UPSTREAM_MODEL`
   - `BOOTSTRAP_PEERS`
   - `BOOTSTRAP_MANIFEST_URLS`
   - `BOOTSTRAP_CACHE_PATH`
   - `BOOTSTRAP_PEER_CACHE_PATH`
   - `ANNOUNCE_HOST`
   - `P2P_IDENTITY_PATH`
   - 可选 `SELLER_STATUS_PORT`，用于本机查看 claim 队列和收益状态
3. 启动 `clawmarket-seller.service`

### 6.2.1 模型对齐检查清单

AIMM Quote 路由能不能命中，除了 p2p 通之外，还取决于 seller 广播的模型和 buyer 订阅的模型有没有交集。

上线前至少检查这 4 项：

1. 确认 seller 的 `MODELS_JSON` 或 `seller.models`
2. 确认 buyer 的 `REFRESH_MODELS` / `DISCOVERABLE_MODELS`
3. 确认 buyer 启动日志里的 `Quote models:` 与 seller 至少有一个交集
4. seller 改了 `MODELS_JSON` 之后，同步通知 buyer 更新 `subscribedModels`

当前 `203.0.113.30` 上的 seller 实际模型集合记录为：

- `gpt-5.4`
- `gpt-5.4-mini`
- `gpt-5.3-codex`
- `gpt-5.2`

如果 buyer 订阅列表里不包含这些模型，即使 quote 广播正常，也会表现成“始终走 legacy fallback”。

推荐做法：

- buyer 默认订阅一组主流模型超集
- seller 只配置这个超集的子集
- 每次改 seller 模型前，先确认 buyer 默认配置是否仍然覆盖

如果走内嵌 `cliproxy` 模式，先在同一套 `CLIPROXY_WORK_DIR` 下完成一次登录：

```bash
EMBED_CLIPROXY=true \
CLIPROXY_SOURCE_DIR=/absolute/path/to/CLIProxyAPI \
CLIPROXY_WORK_DIR=/var/lib/clawmarket/embedded-cliproxy \
corepack pnpm seller:codex-login
```

### 6.3 buyer

1. 复制 `deploy/env/buyer.env.example`
2. 配好：
   - `BUYER_PRIVATE_KEY`
   - `ESCROW_POOL_ADDRESS`
   - `BOOTSTRAP_PEERS`
   - `BOOTSTRAP_MANIFEST_URLS`
   - `BOOTSTRAP_CACHE_PATH`
   - `BOOTSTRAP_PEER_CACHE_PATH`
   - `P2P_IDENTITY_PATH`
3. 启动 `clawmarket-buyer.service`

## 7. 当前状态边界

现在这套通用部署已经具备：

- 通用脚本
- 固定节点身份
- 通用 env 样板
- 通用 systemd 模板

真实链上 buyer/provider/USDC claim 也已经验证过。

但“全网自动发现 seller”这件事，仍然取决于：

- 你的 bootstrap 节点是否长期在线
- seller 是否公网可达
- DHT 自动发现稳定性是否继续补强

所以目前最稳的上线方式还是：

- 公共 bootstrap 网络
- seller 正常 announce
- buyer 默认走 `BOOTSTRAP_PEERS`
- 必要时保留 seed bundle 作为兜底

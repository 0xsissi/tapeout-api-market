# Testnet Runtime Guardrails

**目的**：防止以后改 CLI / gateway / seller 时再次踩到“余额读错、buyer 连错网络、buyer/seller 授权协议不兼容”这类问题。

**适用范围**：
- CLI buyer / seller TUI
- `consumer-gateway`
- `provider-gateway`
- Base Sepolia 测试网运行脚本
- 公开 release 包和自动更新兼容性

这篇文档不是功能规划，而是**测试网运行不变量**。改相关代码前请先确认没有违反下面规则。

---

## 1. 网络固定是 Base Sepolia，但 USDC 不是官方测试 USDC

Tapeout API Market 当前测试网使用 Base Sepolia，但支付 token 是项目自己的 USDC 合约：

```text
0xcF0819eb156D6c6c1c5d9A515E351D2D1aefff7D
```

不要使用 Base Sepolia 官方测试 USDC：

```text
0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

### 必须遵守

- 所有默认合约地址必须从 `packages/shared/src/index.ts` 的 `CONTRACTS` 读取。
- CLI 余额、buyer gateway `/v1/credits`、deposit approval、seller claim 都必须指向同一套 token / escrow。
- 如果需要临时覆盖，使用环境变量，例如 `USDC_ADDRESS` / `ESCROW_POOL_ADDRESS`，不要把临时地址写进源码。

### 改动检查

改这些文件时要特别小心：

- `packages/shared/src/index.ts`
- `packages/cli/src/services/chain.ts`
- `packages/consumer-gateway/src/wallet.ts`
- `packages/consumer-gateway/src/pool-manager.ts`
- `scripts/lib/testnet-runtime.mjs`
- `scripts/run-consumer-testnet.mjs`
- `scripts/run-provider-testnet.mjs`

推荐检查：

```bash
rg "036CbD|cf0819|cF0819|USDC_ADDRESS|CONTRACTS.TOKEN"
```

如果 `0x036CbD...` 又出现在运行时代码里，基本就是错的。

---

## 2. CLI 只有一个用户钱包文件

CLI buyer / seller 共享同一个轻量钱包：

```text
~/.clawmarket/wallet.json
```

旧文件只用于迁移：

```text
~/.clawmarket/seller-wallet.json
```

### 必须遵守

- buyer 和 seller 都读 `wallet.json`。
- 没有钱包时才自动生成新私钥。
- 已存在的钱包不能被启动流程覆盖。
- import 私钥时必须先备份旧文件到 `wallet.json.bak`。
- 不要恢复历史 demo private key，它已经永久泄漏，只能保留废弃说明。

### 改动检查

```bash
rg "seller-wallet|demoPrivateKey|wallet.json|generatePrivateKey" packages/cli packages/consumer-gateway
```

---

## 3. Buyer 默认连接测试网 seller，不要偷偷优先本地 seller

CLI buyer 的默认目标是连接网络中的 seller。它可以通过以下来源发现 seller：

- 配置里的 `buyer.seedProvidersFile`
- bootstrap peers
- buyer peer cache
- DHT / relay 发现

本地 seller 只应该在明确配置 seed 或本机联调脚本中使用。**不要在通用 buyer 启动逻辑里因为检测到 `127.0.0.1:8787` 在线就自动改用本地 seller seed。**

### 为什么

测试用户打开 buyer 时，预期是进入公共测试网。如果代码偷偷优先本地 seller：

- 用户以为自己连到了网络，实际只在本机自测。
- 远端 seller 的兼容性问题会被掩盖。
- TUI 模型列表和真实网络状态会混在一起。

### 改动检查

改这些文件时要确认没有引入隐式本地优先：

- `packages/cli/src/runtime/buyer-runtime.ts`
- `packages/cli/src/config/store.ts`
- `packages/cli/src/services/seller.ts`
- `packages/consumer-gateway/src/router.ts`
- `scripts/run-consumer-testnet.mjs`

可以显式本机联调，但要通过参数或环境变量表达，例如：

```bash
CLAWMARKET_SEED_PROVIDERS_FILE=/tmp/clawmarket-local-seller-seed.json ...
```

---

## 4. 授权签名协议必须向网络 seller 兼容

buyer 发送推理请求前会生成 EIP-712 authorization。seller 会在 provider gateway 里验签。

当前公共测试网必须默认使用：

```text
nonceMode = sequential
```

`bitmap` nonce 是合约能力和未来扩展方向，但不能作为默认值，除非公共 seller fleet 已经全部升级并且有明确版本门禁。

### 为什么

`sequential` 和 `bitmap` 的 EIP-712 typed data 不一样：

- `sequential` 不包含 `nonceMode`
- `bitmap` 包含 `nonceMode`

如果 buyer 默认改成 `bitmap`，但网络 seller 还按旧结构验签，就会出现：

```text
Authorization signature verification failed
```

这看起来像钱包/余额问题，但实际是 buyer/seller 协议不一致。

### 必须遵守

- 默认 `CLAWMARKET_AUTH_NONCE_MODE` 缺省值保持 `sequential`。
- 只有明确设置 `CLAWMARKET_AUTH_NONCE_MODE=bitmap` 时才启用 bitmap。
- 改 EIP-712 domain、types、message 字段时，必须同步升级 buyer、seller、合约测试和版本策略。
- 破坏兼容的协议改动必须配合 `clientVersion` / `protocolVersion` / 最低版本拦截。

### 改动检查

```bash
rg "nonceMode|BITMAP_AUTHORIZATION_TYPES|LEGACY_AUTHORIZATION_TYPES|CLAWMARKET_AUTH_NONCE_MODE"
```

重点文件：

- `packages/crypto/src/authorization.ts`
- `packages/consumer-gateway/src/pool-manager.ts`
- `packages/consumer-gateway/src/local-server.ts`
- `packages/provider-gateway/src/billing.ts`
- `packages/provider-gateway/src/claim-batcher.ts`
- `packages/contracts/src/EscrowPool.sol`

---

## 5. 公开测试网发布必须考虑 buyer/seller 版本矩阵

Tapeout API Market 不是单进程软件。一次 release 至少涉及：

- CLI
- consumer-gateway
- provider-gateway
- p2p protocol
- contract ABI / address
- public seller fleet

### 必须遵守

- 新 buyer 要能打当前网络里的 seller。
- 新 seller 要能服务当前公开 CLI buyer。
- 如果做不到双向兼容，必须通过最低版本策略拦截旧客户端。
- `Provider request failed` 这类泛化错误必须带真实原因，方便用户和运营判断是余额、网络、版本还是 seller 上游问题。

相关设计：

- [client-auto-update.md](client-auto-update.md)

---

## 6. TUI 错误必须中文、可操作

测试用户看到错误时，不应该被迫读日志猜。

### 推荐格式

```text
错误：无法连接 buyer gateway（127.0.0.1:18080）：服务还没启动，或者刚刚已经退出。
建议：先启动 buyer；如果刚升级过，请重启旧进程。
日志：~/.clawmarket/logs/buyer.log
```

provider 失败时要尽量透传真实原因：

```text
Provider request failed: Authorization signature verification failed
```

不要只显示：

```text
Provider request failed
```

---

## 7. 常用诊断命令

### 看当前 buyer 是否还在跑旧进程

```bash
lsof -nP -iTCP:18080 -sTCP:LISTEN
ps -p <PID> -o pid,ppid,command
```

### 看 buyer 钱包和资金状态

```bash
curl -sS http://127.0.0.1:18080/v1/credits
```

重点字段：

- `address`
- `usdcBalance`
- `nativeBalance`
- `escrowAvailable`
- `pendingWithdraw`
- `tokenAddress`

### 看 buyer 发现了哪些 seller

```bash
curl -sS http://127.0.0.1:18080/v1/network/status
```

重点字段：

- `models[].providerCount`
- `models[].bestProvider.peerId`
- `models[].bestProvider.walletAddress`
- `models[].bestProvider.multiaddrs`

### 看日志

```bash
tail -n 120 ~/.clawmarket/logs/buyer.log
tail -n 120 ~/.clawmarket/logs/seller.log
```

---

## 8. PR Checklist

涉及 CLI / gateway / seller / 合约地址 / 授权签名的 PR，请逐项确认：

- 没有新增官方 Base Sepolia USDC `0x036CbD...` 作为运行时默认值。
- 新增默认合约地址来自 `CONTRACTS`。
- buyer 没有隐式优先本地 seller。
- 默认授权 nonce mode 仍兼容公共测试网 seller。
- 改 EIP-712 typed data 时，同步考虑 client policy / min version / seller fleet 升级。
- TUI 和 CLI 错误信息是中文，并包含下一步操作或日志路径。
- 改钱包逻辑时不会覆盖已有 `~/.clawmarket/wallet.json`。
- 运行过相关构建和测试。

推荐最低验证：

```bash
corepack pnpm --filter @clawmarket/cli build
corepack pnpm --filter @clawmarket/consumer-gateway build
corepack pnpm --filter @clawmarket/provider-gateway build
corepack pnpm exec vitest run \
  packages/consumer-gateway/src/wallet.test.ts \
  packages/consumer-gateway/src/pool-manager.test.ts \
  packages/consumer-gateway/src/local-server.test.ts
```

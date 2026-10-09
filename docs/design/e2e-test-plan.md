# Tapeout API Market v2 端到端测试清单

**目标**：完整跑通 Buyer 在 Seller 处购买 token → 收到推理回复 → 双方结算 → 提现 的全流程，覆盖正常路径 + 关键异常。

**测试网络**：Base Sepolia
**适用版本**：`feat/escrow-pool-migration-step1` 分支及后续钱包 UX 补齐版本
**预估全跑时长**：2-3 小时（不含 48h timelock 等待）

---

## 0. 测试前准备

### 0.1 环境要求

- [ ] 至少 **2 台独立机器**（物理机 / VM / Docker 容器均可），一台做 buyer，一台做 seller。不建议同机双身份，会掩盖 P2P 发现问题。
- [ ] 两台都能访问 Base Sepolia RPC（默认公共节点够用）
- [ ] 两台都能访问 bootstrap 节点 IP `203.0.113.30`
- [ ] Node 版本：`pnpm -v` 成功输出
- [ ] 代码已 `pnpm install && pnpm build`

### 0.2 账户与资金准备

- [ ] 为 **buyer 钱包**准备：
  - Base Sepolia ETH：**≥ 0.01 ETH**（gas，多准备点避免来回充）
  - Base Sepolia USDC：**≥ 10 USDC**（充值用）
- [ ] 为 **seller 钱包**准备：
  - Base Sepolia ETH：**≥ 0.01 ETH**（flush claims 的 gas）
  - 不需要 USDC
- [ ] Testnet faucet：
  - ETH：https://www.alchemy.com/faucets/base-sepolia
  - USDC：Base Sepolia 有几个 test USDC faucet，Circle 的官方 faucet 或从团队内部钱包转

### 0.3 Seller 上游账号

- [ ] 至少一个可用的上游账号（Codex / Claude / Gemini）。走 `claw seller login --upstream codex` 登录好，本地有 auth 文件。

### 0.4 工具

- [ ] Basescan 测试网：https://sepolia.basescan.org/
- [ ] 两台机器各开一个终端能 tail 日志
- [ ] 如果要抓 P2P 协议包，装 `tcpdump` 或 wireshark（可选）

---

## 1. 钱包生命周期测试

### TC-1.1 首次启动生成钱包

**前置**：两台机器都是干净环境，`~/.clawmarket/` 不存在。

**步骤**（两台机器各跑一次）：
1. 启动 CLI：`claw console` 或 `claw init`
2. 观察 onboarding 流程

**期望**：
- [ ] `~/.clawmarket/wallet.json` 被自动生成，文件权限 `0o600`
- [ ] 文件内容是合法的私钥（66 字符 hex `0x...`）或 keystore JSON（视 P0-2 实现）
- [ ] TUI 显示一次性提示"钱包已创建：0xabcd...1234，按 E 导出"
- [ ] **Buyer 和 Seller 共用同一个钱包文件**（关键回归点：确认 [config/store.ts](../../packages/cli/src/config/store.ts) 里已没有 hardcoded demo 私钥）

**验证命令**：
```bash
ls -la ~/.clawmarket/wallet.json    # 权限应为 -rw-------
cat ~/.clawmarket/wallet.json | head -1    # 不应是 0xd14... 这个 demo key
```

### TC-1.2 导出私钥

**前置**：TC-1.1 完成。

**步骤**：
1. 进 TUI → 主菜单按 `E`
2. 确认弹出的私钥

**期望**：
- [ ] 显示完整私钥（hex 66 字符）
- [ ] 顶部有红字警告"不要发给任何人"
- [ ] 按回车/Q 返回，私钥不残留在屏幕上（或者明确告知用户 scroll buffer 还会留着）

### TC-1.3 导入私钥（恢复）

**前置**：准备一个新机器 or 先备份 `~/.clawmarket/` 再删除。

**步骤**：
1. 启动 CLI → 主菜单按 `I`
2. 粘贴 TC-1.2 导出的私钥
3. 确认

**期望**：
- [ ] 提示原钱包已备份到 `wallet.json.bak`
- [ ] 新钱包地址与 TC-1.1 一致
- [ ] 后续 `claw buyer status` 查到的余额和原钱包一致

### TC-1.4 无效私钥的校验

**步骤**（都要试）：
1. 导入空字符串 → 应报错
2. 导入 `0x1234`（长度不对）→ 应报错
3. 导入 `not-a-hex-string-xxxx...` × 66 字符 → 应报错
4. 导入缺 `0x` 前缀的合法 hex → 最好也能接受（或明确报错）

**期望**：报错信息友好，不崩溃，`wallet.json` 不被损坏。

---

## 2. Seller 上线测试

### TC-2.1 Seller 启动

**前置**：
- TC-1.1 完成（seller 钱包存在）
- 上游账号已登录
- Seller 钱包 ETH ≥ 0.005

**步骤**：
```bash
claw seller up \
  --input-price 1.0 \
  --output-price 2.0 \
  --models gpt-4o-mini
```

**期望**：
- [ ] 进程启动，无报错
- [ ] 日志出现 `seller listening on /ip4/.../tcp/PORT` 或类似 libp2p 启动日志
- [ ] 日志出现 `announced <cid> for model gpt-4o-mini`（DHT 发布）
- [ ] `claw seller status` 能返回数据，`queuedCount: 0`

**验证命令**：
```bash
claw seller status
# 期望输出包含：
# - wallet address
# - peerId
# - online: true
# - announced models: gpt-4o-mini
```

### TC-2.2 Seller 在 DHT 里可被发现

**前置**：TC-2.1 运行中。

**步骤**：在 **buyer 机器**上跑：
```bash
node scripts/smoke-discovery-base-sepolia.mjs  # 或等价 smoke 工具
```

**期望**：
- [ ] 脚本查 `gpt-4o-mini` 模型能返回至少 1 个 provider
- [ ] 返回的 peerId / wallet 匹配 TC-2.1 里的 seller

**失败诊断**：
- 如果 0 个 provider：看 bootstrap 节点是否可达（`curl http://203.0.113.30:port` 或 ping）
- 看 seller 日志是否有 `DHT provide failed`

---

## 3. Buyer 启动 & 充值

### TC-3.1 Buyer 启动

**前置**：
- Buyer 钱包有 ETH ≥ 0.005 + USDC ≥ 5
- Seller 已上线（TC-2.1）

**步骤**：
```bash
claw buyer up
```

**期望**：
- [ ] 进程启动无错
- [ ] `claw buyer status` 返回：
  - `escrowAvailable: 0`（还没充值）
  - `usdcBalance: ≥ 5`
  - `nativeBalance` > 0

### TC-3.2 TUI 钱包视图显示正确

**前置**：TC-3.1 完成。

**步骤**：
1. `claw console` 进入 TUI
2. 切到 Wallet 视图（P0-3 新增）

**期望**：
- [ ] 显示钱包地址（完整或省略中间但可展开）
- [ ] 4 项余额齐全：钱包 USDC / 钱包 ETH / Escrow 可用 / Escrow 提现中
- [ ] 网络标签显示 `Base Sepolia`
- [ ] 按 C 能复制地址（拿去 `pbpaste` 或 `xclip -o` 验证）
- [ ] ETH 很低时显示 `⚠ gas 偏低`

### TC-3.3 充值到 EscrowPool

**步骤**：
- 命令版：`claw buyer purchase --amount 5`
- 或 TUI：Wallet 视图 → `[1] 充值到 Escrow` → 输入 5

**期望**：
- [ ] 如果 USDC allowance 不足，先自动发 approve tx（TUI 显示"步骤 1/2：approve"）
- [ ] 随后 deposit tx（TUI 显示"步骤 2/2：deposit"）
- [ ] 两个 tx 都成功，TUI 输出可点击的 basescan 链接
- [ ] 刷新后：
  - `usdcBalance` 减少 5
  - `escrowAvailable` 增加 5

**验证命令**：
```bash
claw buyer status
# 期望：escrowAvailable ≈ 5.0 USDC
```

**链上验证**：
- 在 basescan 打开 tx，确认 event 为 `Deposit(buyer, 5_000_000)`（USDC 6 位精度）

### TC-3.4 充值边界情况

- [ ] 金额为 0 → 应前端校验拦住，不发 tx
- [ ] 金额超过 wallet USDC balance → 前端拦住，提示"余额不足"
- [ ] 金额是负数 / 非数字 → 前端拦住
- [ ] USDC balance 刚好够 + gas 不够 → 走 P1-2 Gas 预检，提示 ETH 不足

---

## 4. 完整推理请求（核心路径）

### TC-4.1 单次 chat 请求

**前置**：
- TC-2.1 seller 在线
- TC-3.3 buyer 已充值 ≥ 1 USDC

**步骤**：
```bash
claw buyer chat "用一句话介绍你自己"
```

**期望**：
- [ ] 返回有内容的回复
- [ ] Buyer 日志出现：
  - `found N providers for gpt-4o-mini`
  - `selected peer <peerId>`
  - `sent authorization with nonce=X, amount=Y`
- [ ] Seller 日志出现：
  - `received request from <peerId>`
  - `verified authorization signature`
  - `forwarded to upstream`
  - `streamed tokens, usage: input=X output=Y`
  - `queued claim <nonce> amount=<USDC>`
- [ ] Buyer `escrowAvailable` 下降 = 本次消费金额
- [ ] Seller `queuedAmountUsdc` 上升 = 同等金额（claim 还没落链）

### TC-4.2 流式响应

**步骤**：
```bash
curl -N -X POST http://localhost:<buyer-port>/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"count 1 to 10"}]}'
```

**期望**：
- [ ] SSE chunk 持续输出，不是一次性返回
- [ ] 最后一个 chunk 包含 `usage` 字段
- [ ] 总耗时 < 10s（视模型）

### TC-4.3 并发请求（10 个）

**步骤**：
```bash
for i in {1..10}; do
  claw buyer chat "test $i" &
done
wait
```

**期望**：
- [ ] 10 个全部成功返回
- [ ] Seller `queuedCount` 增加 10
- [ ] 累计消费 ≈ 10 × 单次金额，误差 < 5%
- [ ] 无 nonce 冲突报错

### TC-4.4 Seller 维度的限流

**前置**：启动 seller 时把 `maxConcurrent` 调小（如 2）。

**步骤**：起 20 个并发 chat。

**期望**：
- [ ] 大部分请求成功
- [ ] 超过 maxConcurrent 的请求被 429 或排队（看实现）
- [ ] Buyer 在 429 时自动切换到 alternatives 或进入失败冷却（见 [router.ts](../../packages/consumer-gateway/src/router.ts)）
- [ ] **不应出现资金扣了但没回复** 或 **回复了但没扣钱** 的情况

---

## 5. 结算测试（Flush Claims）

### TC-5.1 手动 Flush

**前置**：TC-4.1 或 4.3 完成，seller `queuedCount > 0`。

**步骤**：
- 命令：`claw seller flush`
- 或 TUI：Claims 视图 → Flush claims

**期望**：
- [ ] 返回 tx hash
- [ ] Tx 在 basescan 上成功，event 为 `BatchClaimed(seller, totalAmount, count)`
- [ ] 刷新后 seller `queuedCount: 0`
- [ ] Seller 钱包 USDC 余额增加 ≈ queued 金额（减 protocol fee 如果有）
- [ ] Buyer 的 `escrowAvailable` 不变（充值时就已经减了，flush 不改变）

**验证命令**：
```bash
claw seller status    # queuedCount should be 0
# basescan 查 seller 地址最新 tx
```

### TC-5.2 空 Flush

**前置**：`queuedCount: 0`。

**步骤**：`claw seller flush`

**期望**：
- [ ] 命令返回"没有待提交 claims"，不发 tx，不报错

### TC-5.3 Flush 时 gas 不足

**前置**：故意让 seller ETH 接近 0（转出或换个穷钱包）。

**步骤**：`claw seller flush`

**期望**：
- [ ] P1-2 的 gas 预检提示 ETH 不足 + faucet 链接
- [ ] 不真的发 tx 失败

### TC-5.4 Double-claim 防御

**前置**：Seller 已经 flush 过一批 claims。

**步骤**：尝试手工重放之前的 authorization signature（用 cast send 或 hardhat console 直接调合约）

**期望**：
- [ ] 合约 revert，错误类型 `NonceAlreadyUsed` 或 `Unauthorized`
- [ ] Buyer escrow 余额不被二次扣除

---

## 6. Buyer 提现（48h Timelock 全流程）

### TC-6.1 发起提现

**前置**：Buyer `escrowAvailable ≥ 2`。

**步骤**：
- 命令：`claw buyer withdraw request --amount 2`
- 或 TUI：Wallet 视图 → `[2] 从 Escrow 提现`

**期望**：
- [ ] Tx 成功
- [ ] `escrowAvailable` 减 2，`escrowPendingWithdraw` 增 2
- [ ] TUI 显示"还剩 47h Xm 可完成"
- [ ] basescan 上 event 为 `WithdrawRequested(buyer, 2_000_000, unlocksAt)`

### TC-6.2 提前 complete 应失败

**步骤**：立刻 `claw buyer withdraw complete`

**期望**：
- [ ] 合约 revert `TimelockNotElapsed`
- [ ] TUI 错误信息友好："还需等待 47h Xm"
- [ ] 余额状态不变

### TC-6.3 取消提现

**前置**：TC-6.1 的 pending withdraw 还在。

**步骤**：`claw buyer withdraw cancel`

**期望**：
- [ ] Tx 成功
- [ ] `escrowPendingWithdraw: 0`
- [ ] `escrowAvailable` 恢复到 + 2
- [ ] 可以再发一次 TC-6.1，不会被阻塞

### TC-6.4 完成提现（跨 48h 的长测试）

**方案 A（真等 48h）**：
- [ ] TC-6.1 后记录时间戳，48h 后回来执行 `claw buyer withdraw complete`

**方案 B（短测，需合约支持）**：
- 如果 [EscrowPool.sol](../../packages/contracts/src/EscrowPool.sol) 在 testnet 部署时把 timelock 调短（如 5 分钟），用这个版本测
- 或在 hardhat / anvil fork 本地跑，`evm_increaseTime` 快进

**期望**：
- [ ] Tx 成功
- [ ] Buyer 钱包 USDC + 2
- [ ] `escrowPendingWithdraw: 0`
- [ ] basescan event `WithdrawCompleted`

---

## 7. 异常与回归场景

### TC-7.1 Seller 中途掉线

**步骤**：
1. TC-4.1 期间，seller 进程被 `kill -9`
2. Buyer 已经发了 authorization，但 seller 没来得及响应

**期望**：
- [ ] Buyer 侧超时报错（不应无限等待）
- [ ] Buyer 的 escrow 余额：应该**未扣款**（认证是预授权，扣款发生在 claim 时）
- [ ] Seller 重启后 `queuedCount` 持久化（如果已 queue）或丢失（如果还没 queue）—— 明确记录实际行为

### TC-7.2 Buyer 余额不足

**前置**：Buyer `escrowAvailable` 只剩 0.01 USDC。

**步骤**：`claw buyer chat "写一首 1000 字的诗"`（故意让消费超过余额）

**期望**：
- [ ] 请求失败，错误信息："余额不足"
- [ ] Seller 不会承接（或者承接后发现授权金额小于实际消费，返回 402）
- [ ] 不产生"回复了但没付钱"的情况

### TC-7.3 网络分区

**步骤**：
1. TC-4.1 正常跑通后，用 `iptables` 或拔网线阻断 buyer ↔ seller 的 TCP 连接（保留 buyer ↔ bootstrap）
2. Buyer 再发一次请求

**期望**：
- [ ] Router 发现 peer 不可达，切到 alternatives 或报错
- [ ] 不会卡死进程

### TC-7.4 错误上游

**步骤**：Seller 的上游 token 过期（手动改 auth 文件破坏之）。

**期望**：
- [ ] Seller 响应 502 / upstream error
- [ ] Buyer 失败冷却这个 seller，下次不选它
- [ ] 没消费到 buyer 的 escrow

### TC-7.5 CLI 重启后钱包还在

**步骤**：
1. TC-3.3 充值完成
2. `Ctrl+C` 退出，重新 `claw console`

**期望**：
- [ ] 钱包地址不变
- [ ] `escrowAvailable` 不变
- [ ] Session sticky 可能丢失，属正常

### TC-7.6 CLI 版本升级后钱包还在

**步骤**：
1. 装旧版 CLI，走完 TC-3.3
2. 安装新版 CLI（npm / pnpm 覆盖）
3. 再次 `claw console`

**期望**：
- [ ] 钱包文件没被覆盖
- [ ] 余额查询正常

---

## 8. 压力 / 规模测试（可选，用于验证百级节点设计）

### TC-8.1 50 buyer vs 10 seller（本地 docker）

**步骤**：
- 用 docker-compose 起 10 个 seller 容器（不同端口、不同钱包）
- 跑 `scripts/smoke-e2e.mjs` 的扩展版，起 50 个虚拟 buyer 每秒发请求
- 持续 5 分钟

**期望**：
- [ ] 全部请求成功率 > 95%
- [ ] 每个 seller 的 RPS 不偏差超过 3×（若超过说明羊群效应，对应 P0-1 Phase 2 P2C 没做完）
- [ ] 累计 claim 金额 = 买家累计消费，误差 < 1%

### TC-8.2 持续 24 小时稳定性

**步骤**：TC-8.1 的配置，跑 24h。

**期望**：
- [ ] 无内存泄漏（各进程 RSS 不线性增长）
- [ ] 无积压的 queued claims 超过自动 flush 阈值
- [ ] Seller 的 libp2p 连接数稳定

---

## 9. 验收标准总览

| 阶段 | 必须通过的 TC |
|---|---|
| 钱包 UX | 1.1, 1.2, 1.3, 1.4 |
| Seller 上线 | 2.1, 2.2 |
| Buyer 充值 | 3.1, 3.2, 3.3, 3.4 |
| 核心推理 | 4.1, 4.2, 4.3 |
| 结算 | 5.1, 5.2, 5.4 |
| 提现 | 6.1, 6.2, 6.3, 6.4 |
| 异常回归 | 7.1, 7.2, 7.5, 7.6 |

**全通过 = testnet release 候选**。

压力测试（8.x）不通过不阻塞 testnet，但阻塞公开 testnet + 百级节点演示。

---

## 10. 测试记录模板

建议同事每跑一轮填一份：

```
测试日期：2026-__-__
测试人：
版本 / commit：
机器：buyer=______________  seller=______________

| TC | 状态 | 备注 / bug 编号 |
|----|------|----------------|
| 1.1 | ✅   | |
| 1.2 | ❌   | 导出后私钥格式不对，缺 0x 前缀 |
| ... |      | |
```

发现问题开 issue 的时候带上：
- TC 编号
- 命令 + 完整输入
- 期望 vs 实际
- buyer + seller 的关键日志 10 行
- 若链上相关：tx hash

---

## 参考
- [cli-wallet-ux-gap-list.md](cli-wallet-ux-gap-list.md) —— 钱包 UX 补齐对应本测试清单的 §1, §3, §6
- [scheduling-design.md](scheduling-design.md) —— 调度器设计，§4 / §8 对应本清单的核心路径和压测
- [escrow-pool-migration.md](escrow-pool-migration.md) —— 合约迁移，§5 / §6 对应本清单的结算和提现

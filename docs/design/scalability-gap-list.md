# Scalability Gap List — 百级自治节点就绪度

**目标**：数百台节点同时在线，无中心调度，自主运行不出问题。
**现状**：设计完整，代码约完成 50-60%。以下为必须补齐项。
**Bootstrap 多元化问题由网络维护团队单独处理，不在此文档范围内。**

---

## P0-1 调度器 Phase 2：P2C + 价格加权随机

### 问题
当前 [packages/consumer-gateway/src/scheduler/scheduler.ts:184-187](../../packages/consumer-gateway/src/scheduler/scheduler.ts) 的选择逻辑：

```ts
const topProviders = cfg.enableTopNPreselect
  ? pool.candidates.slice(0, cfg.topN)
  : pool.candidates.slice(0, 1);
const provider = topProviders[0] ?? null;  // 永远选 Top-1
```

`alternatives` 已计算但未使用。所有 buyer 同步选同一个"最优" seller。

### 羊群效应场景
- DHT provider 缓存 TTL = 60s（见 [p2p-node](../../packages/p2p-node/src/)）。
- 同一 60s 窗口内，所有 buyer 看到的 provider 列表+分数相同。
- 所有请求落到 Top-1 seller → `maxConcurrent` 打满 → 雪崩 → 失败冷却 → 流量切到 Top-2 继续雪崩。

### 要做的
按 [scheduling-design.md](scheduling-design.md) §4.5：

1. **P2C (Power of Two Choices)**：从 Top-N 候选里随机抽 2 个，选观察到的 inflight/latency 较低者。
2. **价格加权随机**：当分数相近时（例如分差 < 5%），按 `weight = 1/price^α`（α≈1.5）做加权抽样，而不是严格取 Top-1。
3. **TTL jitter**：provider 缓存 TTL 在 [45s, 75s] 区间内按 peerId 哈希加抖动，破坏全局同步刷新窗口。

### 验收
- 单测：1000 虚拟 buyer × 10 seller（价格梯度），Top-1 seller 的流量占比 ≤ 40%（当前会是 ~100%）。
- E2E：本地模拟 50 buyer + 20 seller，观察 5 分钟内每个 seller 的 RPS 标准差。

### 文件
- 改：[scheduler.ts](../../packages/consumer-gateway/src/scheduler/scheduler.ts) 的 `newSelect`。
- 改：[config.ts](../../packages/consumer-gateway/src/scheduler/config.ts) 增加 `enableP2C`, `priceWeightAlpha`, `scoreTieThreshold` 配置。
- 改：[router.ts](../../packages/consumer-gateway/src/router.ts) 的 provider 缓存 TTL 加 jitter。

---

## P0-2 调度器 Phase 3：Backpressure 信号（X-Load-Hint）

### 问题
grep 全仓 `X-Load-Hint` / `X-Inflight` → 0 结果。[router.ts:173](../../packages/consumer-gateway/src/router.ts) 只有一行注释 `// Reserved for Phase 3 backpressure logic.`。

Provider 过载时 buyer 完全感知不到，只能靠 5xx / 超时事后反应。

### 要做的
按 [scheduling-design.md](scheduling-design.md) §5：

1. **Provider 端**（[packages/provider-gateway/src/sidecar.ts](../../packages/provider-gateway/src/sidecar.ts)）在每个响应头塞：
   - `X-Load-Hint: 0.0 ~ 1.0`（= `inflight / maxConcurrent`）
   - `X-Inflight: <int>`
   - `X-Queue-Depth: <int>`（若有排队）
2. **Consumer 端**（[router.ts](../../packages/consumer-gateway/src/router.ts)）解析后写入 provider observability 表，影响下次 P2C 的"观察值"。
3. **软拒绝协议**：Provider 在 load > 0.9 时直接返回 `429` + `Retry-After: <seconds>`，buyer 收到后把该 peer 加入短期 `excludedPeerIds` 并走 alternatives 列表。

### 验收
- 单测：Provider 在 load=0.95 时返回 429，Consumer 自动切换到 alternatives[0]，不计入失败冷却。
- E2E：手动把一个 seller 的 maxConcurrent 设为 2，灌入 20 并发，确认流量被分流到其他 seller（而不是全部失败）。

### 文件
- 改：[sidecar.ts](../../packages/provider-gateway/src/sidecar.ts) 响应头。
- 改：[router.ts](../../packages/consumer-gateway/src/router.ts) `sendRequest` 的响应处理分支。
- 改：[scheduler.ts](../../packages/consumer-gateway/src/scheduler/scheduler.ts) 把 load hint 喂进 P2C。

---

## P1 支付：Nonce 并发卡死修复

### 问题
当前 Authorization 使用 **per-pair 严格递增 nonce**（buyer→seller）。
场景：buyer 向 seller A 依次签 nonce 1, 2, 3。若 nonce 2 请求中途崩溃（buyer 重启 / 网络断 / provider 未提交 claim），**nonce 3 永远无法被 seller 采纳**（链上 `expectedNonce = 2`），**资金永久卡死**。

百级节点、agent 长跑场景下，这个概率不是"如果"，而是"每天都会发生"。

[escrow-pool-migration.md](escrow-pool-migration.md) 已指出要上 bitmap nonce，但代码未实现。

### 要做的
改用 **bitmap / window nonce**：
- 合约里 `mapping(address buyer => mapping(address seller => mapping(uint256 wordIndex => uint256 bitmap)))`。
- 每个 nonce 占 1 bit；claim 时设 bit，重复 claim 回滚。
- Buyer 随机分配 nonce（或按 requestId 哈希），不要求严格递增。
- Claim batch 支持跳号提交。

### 验收
- 合约单测：构造"buyer 签 nonce 1, 2, 3，seller 先 claim 3 再 claim 1，最后 claim 2"场景，三笔都成功且不能重放。
- 集成测：Buyer 故意中断第 2 个请求，确认第 3 个请求仍可正常结算。

### 文件
- 改：`contracts/EscrowPool.sol`（具体路径 @同事 查）。
- 改：[packages/shared/src/types/index.ts](../../packages/shared/src/types/index.ts) Authorization 结构。
- 改：[claim-batcher.ts](../../packages/provider-gateway/src/claim-batcher.ts) 提交逻辑。
- 改：Buyer 端 nonce 分配器（[packages/consumer-gateway/src/wallet.ts](../../packages/consumer-gateway/src/wallet.ts)）。
- **迁移策略**：旧 Authorization 仍按 sequential nonce 处理；新字段加 `nonceMode: 'bitmap'`，合约按模式分发。

---

## P1 Session Sticky 容量 & 可观测性

### 问题
[session-sticky.ts](../../packages/consumer-gateway/src/scheduler/session-sticky.ts) 容量硬编码 / 只读 config。百级并发 agent 场景（每个 agent 多会话）下 1000 容量可能不够，淘汰率高会放大羊群效应。

### 要做的
1. 从 [config.ts](../../packages/consumer-gateway/src/scheduler/config.ts) 曝露 `stickyMaxSize`，默认提到 10000。
2. [admin-endpoint.ts](../../packages/consumer-gateway/src/scheduler/admin-endpoint.ts) 加 `/admin/scheduler/sticky/stats`，返回 hit rate / eviction rate / size。
3. 运维面板（或日志采样）接入这些指标。

### 验收
- `/admin/scheduler/sticky/stats` 返回完整统计；压测 10k 会话不 OOM。

---

## P2 Agent 生态启动 Blocker（主网前必做）

详见 [agent-integration-roadmap.md](agent-integration-roadmap.md)。此处只列必须项：

### P2-1 Hosted Gateway
- 起一个 `gateway.clawmarket.xxx` 服务，替 agent 持有 libp2p 节点 + 钱包（可选托管或 BYO-key）。
- Agent 侧走 HTTPS REST，无需本地跑 P2P。
- 首字节延迟目标 < 500ms。

### P2-2 Agent SDK
- `@clawmarket/agent-sdk`（TS + Python），兼容 OpenAI SDK 接口（`baseURL` 替换即用）。
- 提供 LangChain / Vercel AI SDK adapter。

### P2-3 Gasless Onboarding
- EIP-2612 permit 或 meta-tx，允许 agent 首次 deposit 不持有 ETH。
- 或：Hosted Gateway 代付首笔 gas（内部成本核算）。

---

## 优先级与排期建议

| 优先级 | 项目 | 预计工期 | Blocker for |
|---|---|---|---|
| P0 | Phase 2 P2C + 加权随机 + TTL jitter | 3-5 天 | 公开 testnet |
| P0 | Phase 3 Backpressure (X-Load-Hint) | 3-5 天 | 公开 testnet |
| P1 | Nonce bitmap 迁移 | 1 周（含合约审计） | 主网 |
| P1 | Sticky 容量/可观测 | 1-2 天 | 百级规模 |
| P2 | Hosted Gateway | 2 周 | Agent 生态 |
| P2 | Agent SDK | 1 周 | Agent 生态 |
| P2 | Gasless onboarding | 1 周（含合约改动） | Agent 生态 |

**最小公开 testnet 门槛**：P0-1 + P0-2 + P1（Sticky）完成。
**主网门槛**：加 P1（Nonce）+ 合约审计。
**Agent 生态启动**：再加 P2 三项。

---

## 参考
- [scheduling-design.md](scheduling-design.md) — 调度器完整设计（§4.5 P2C、§5 Backpressure）
- [scheduling-phase-0-1-implementation.md](scheduling-phase-0-1-implementation.md) — Phase 0-1 已落地范围
- [escrow-pool-migration.md](escrow-pool-migration.md) — 支付迁移设计（nonce bitmap 在设计里）
- [agent-integration-roadmap.md](agent-integration-roadmap.md) — Agent 场景 blocker 清单

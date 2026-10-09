# Tapeout API Market 调度系统设计文档

> 在去中心化 P2P 网络上，为 LLM 推理市场提供稳定、公平、高性能的 seller 选择算法。
> 目标规模：初期 100–500 台 seller，长期可扩展至数千台。

---

## 1. 设计目标与权衡

### 1.1 核心目标（按优先级排序）

1. **可用性（P0）**：买家请求不应因 seller 单点问题失败。目标 ≥ 99.5% 请求成功。
2. **会话粘性 / Cache 命中（P0）**：同一对话的后续请求尽量路由到同一 seller，充分利用 KV cache。
3. **负载均衡（P1）**：避免热点 seller，防止"选最优"导致的羊群效应。
4. **价格公平（P1）**：用户感知价格可预期、可控、透明，平台价格永远在用户设定上限内。
5. **去中心化（硬约束）**：**无中心调度器**。每个 buyer 本地做决策，仅依赖 DHT + 响应头 + 本地观测。
6. **鲁棒性（硬约束）**：算法本身不能成为稳定性瓶颈。任何新逻辑必须可灰度、可回滚、可观测。

### 1.2 关键权衡

| 张力 | 解决思路 |
|---|---|
| 缓存命中 ↔ 负载均衡 | **优先粘，过载再飘**：粘性是 soft 的，只在目标 seller 健康且不过载时坚持 |
| 最低价 ↔ 可持续市场 | **不选绝对最低**：在"便宜的合格候选"中做加权随机，保护次便宜供给不被饿死 |
| 集中决策 ↔ 去中心化 | **用随机性 + 局部状态 + 反馈信号**替代中心协调（P2C + backpressure） |
| 算法精度 ↔ 实现复杂度 | **分阶段落地**：每阶段可独立见效、可独立回滚 |

### 1.3 非目标

- 不做 hedged requests（双扣费风险，与 escrow 不兼容）
- 不引入中心调度器、中心价格发现服务
- 不做 Mooncake / prefill-decode 分离级别的 seller 内部架构改造

---

## 2. 系统模型

### 2.1 参与方

- **Buyer**：发起推理请求，本地运行 consumer-gateway，自行选 seller
- **Seller**：提供推理服务，本地运行 provider-gateway，有 `maxConcurrent` 等本地保护
- **DHT**：存储 `ProviderAnnouncement`（价格、模型、声誉、公钥等），最终一致
- **Escrow**：链上支付通道，每次请求消耗一个 nonce

### 2.2 信息源（每个 buyer 可用）

| 来源 | 实时性 | 用途 |
|---|---|---|
| DHT announcement | 秒级–分钟级滞后 | 候选发现、价格、声誉 |
| 响应头（本次请求） | 实时 | seller 当前负载、健康状态 |
| 本地观测 | 实时 | 自己的成功率、延迟、in-flight |
| Session 粘性表 | 实时（本地） | 上次使用的 seller |

**原则**：本地实时观测 > 响应头 > DHT。冲突时优先相信更新鲜的信息。

---

## 3. 调度分层架构

```
请求进入
   ↓
【Layer 0】请求解析：提取 model, max_price, session_id, prefix
   ↓
【Layer 1】Hard Filter：硬约束过滤
   ↓
【Layer 2】Session 粘性快路径
   ↓
【Layer 3】候选池收窄：分位数过滤
   ↓
【Layer 4】Prefix-aware 排序（可选，Phase 4）
   ↓
【Layer 5】P2C + 价格加权 随机选择
   ↓
【Layer 6】执行 + 故障切换
   ↓
【Layer 7】反馈与观测
```

---

## 4. 各层详细设计

### 4.1 Layer 1 — Hard Filter（硬约束过滤）

**不满足任一条件的 seller 直接排除**，不进入后续排序：

| 过滤项 | 规则 | 数据来源 |
|---|---|---|
| 模型支持 | 必须在 `announcement.models` 中 | DHT |
| 价格上限 | `price ≤ user.max_price`（用户未设则用平台默认） | DHT |
| 健康状态 | 不在 `failed` / `cooldown` 中 | 本地 + 响应头 |
| 成功率 | 30 天滑窗成功率 ≥ 95% | 声誉 |
| 在线率 | 最近 24 小时在线率 ≥ 90% | 声誉 |
| 声誉下限 | `reputation.score ≥ 60` | 声誉 |

**新 seller 冷启动例外**：保留 5% 流量做 exploration（ε-greedy），给没有声誉的新人机会。
- 标记 `is_new = true` 的 seller 以 5% 概率绕过声誉下限检查
- 绕过的前提：在线率和健康状态必须仍然通过

**设计理由**：
- Hard filter 保证用户预期下限 — 价格不会超、烂 seller 不会中
- 它独立于排序逻辑，单独可调，单独可观测
- 冷启动例外防止新供给被饿死，维持市场竞争

---

### 4.2 Layer 2 — Session 粘性快路径

**目的**：同一对话的后续请求尽量回到上次的 seller，复用 KV cache。

**数据结构**：本地 LRU，容量 1000，TTL 10 分钟无活动过期。
```
stickyTable: LRU<sessionKey, { peerId, lastUsedAt, hitCount }>
```

**Session key 生成**（优先级顺序）：
1. 请求带显式 `session_id` 字段 → 直接用
2. 请求带 `user` 字段 + model → `hash(user + model)`
3. 否则 → `hash(messages[0..n-1].content)`（取前 N-1 条消息做前缀哈希，最后一条是当前轮）

**粘性命中逻辑**：
```
sticky = stickyTable.get(sessionKey)
if sticky exists
  AND sticky.peerId 在 Layer 1 候选集中
  AND sticky.peerId 当前 in-flight < seller 声称的 maxConcurrent × 0.9
  AND sticky.peerId 最近 60 秒没有失败过：
    → 直接使用 sticky.peerId，跳过 Layer 3-5
否则：
    → 清理该粘性条目，进入 Layer 3
```

**溢出规则**：目标 seller 过载（in-flight ≥ 90% 容量）时不强制粘，让它溢出到 P2C，避免推大热点。

**设计理由**：
- 粘性是本地事实，不需要任何跨 buyer 协调
- 90% 的软阈值既保护 cache 命中率，也避免硬打爆
- 60 秒失败窗口过滤掉刚坏但还没被标记的 seller

---

### 4.3 Layer 3 — 候选池收窄（分位数过滤）

**目的**：让 P2C 的随机范围限制在"便宜的合格候选"内，控制价格波动。

**策略**：按用户 `mode` 参数决定保留比例：

| mode | 保留最便宜的 | 随机选择的价格方差 |
|---|---|---|
| `cheap` | 15% | 极小 |
| `balanced`（默认） | 30% | 小 |
| `quality` | 50% | 中 |

**实现细节**：
- 候选数量太少时（< 5 个）不做分位数过滤，全部保留，避免 P2C 退化为单选
- 分位数计算使用"合格候选集"的价格分布，而不是全网分布

**设计理由**：
- 用户始终付的价格都在"最便宜的一小撮"里，感知公平
- 配合用户设定的 `max_price`（硬上限）双保险
- 保留 30% 而不是 top1，是为了 P2C 有选择空间，防止热点

---

### 4.4 Layer 4 — Prefix-aware 排序（Phase 4，可选）

**目的**：进一步提升 KV cache 命中率，尤其跨 session 的 prefix 复用（相同 system prompt、相同工具定义）。

**实现方式**：
- Seller 定期把本地 KV cache 的 **prefix 摘要**（radix tree 叶子 hash 集合，或 bloom filter）放入 `ProviderAnnouncement`
- Buyer 提取请求的 prompt 前缀（前 512 tokens）做分段 hash
- 在候选集中找"前缀匹配最长"的 seller，作为主排序键

**候选排序键**（字典序）：
1. Prefix 匹配 token 数（降序）
2. 价格（升序）
3. 当前 in-flight 负载（升序）

**注意**：这层是 Phase 4 才做，Phase 1-3 不依赖。先不做不影响整体设计。

**设计理由**：SGLang Router、AIBrix、Preble 论文均证明 prefix-aware 对 LLM 吞吐有 2-10× 提升。但需要 seller 侧配合改造，优先级靠后。

---

### 4.5 Layer 5 — P2C + 价格加权随机选择（核心）

**算法**：改良版 Power of Two Choices，防止去中心化下的羊群效应。

```
输入：候选集 C（已过 Layer 1-4）
若 |C| == 1: 直接返回该 seller
若 |C| == 2: 返回 load 更低的那个

否则：
  按 1/price 做权重，随机抽取 2 个候选 a, b（无放回）
  返回 load(a) 和 load(b) 中更低的那个
  （load = 本地 in-flight count，若响应头有 X-Load-Hint 则取两者较大值）
```

**为什么这样设计**：

- **P2C 的随机性破坏同步**：即使所有 buyer 算法相同，不会所有人同时选中 top1
- **价格加权的抽样**让便宜 seller 被选中概率更高，但不会垄断
- **负载比较**让最终结果不被忙 seller 抢到
- **理论保证**：最大负载 O(log log N)，接近最优

**权重计算**：
```
weight(seller) = 1 / max(price, minPrice)
probability(seller) = weight(seller) / sum(weights)
```

**设计理由**：P2C 是现代服务网格（Envoy、Linkerd、gRPC）的默认算法，数学上证明优于"选最优"。去中心化下不需要任何全局视图即可工作。

---

### 4.6 Layer 6 — 执行与故障切换

**Top-N 预选**：
- Layer 5 返回主选 seller 的同时，缓存 **next 2 备选**
- 失败时 0 延迟切换，不重跑 Layer 1-5

**失败分类与处理**：

| 失败类型 | 处理 | 切换 |
|---|---|---|
| 连接超时 / 网络错误 | 本地 markFailed，30s cooldown | 切备选 |
| Seller 返回 busy/429 | 降权该 seller 60s（权重 × 0.3） | 切备选 |
| Seller 返回 model_cooldown | 标记该 model 不可用 N 秒 | 切备选 |
| 应用层错误（400、认证失败） | 不重试 | 直接返回用户 |
| 流式已吐出 token 后失败 | 不切换，返回部分结果 + 错误 | 无 |

**Retry budget**（防重试雪崩）：
- 全局：最近 1 分钟内重试请求数 / 总请求数 ≤ 10%
- 单请求：最多 3 次切换（MAX_PROVIDER_ATTEMPTS = 3，已有）
- 超出 budget 时：停止切换，直接返回错误（而不是拖垮所有 seller）

**Nonce 安全**：
- 每次切换重新签名 authorization（当前已有）
- **重要**：被放弃的 nonce 必须能在 escrow 超时后释放资金，避免用户被"预占"多笔
- 若 escrow 不支持软取消，需在 authorization TTL 上做合理下限（比如 30s）

**设计理由**：
- Top-N 预选把"切换延迟"从数百毫秒压到毫秒级
- Retry budget 是 Google SRE 书里的反雪崩核心技巧
- Nonce 释放是 marketplace 独有问题，必须从一开始考虑

---

### 4.7 Layer 7 — 反馈与观测

**必须记录的信息**（每个请求一行结构化日志）：
```json
{
  "requestId": "...",
  "model": "...",
  "sessionKey": "hash(...)",
  "stickyHit": true,
  "candidatesAfterFilter": 12,
  "candidatesAfterQuantile": 4,
  "selectedPeerId": "...",
  "selectionReason": "sticky" | "p2c" | "prefix_match",
  "alternatives": ["peerId1", "peerId2"],
  "price": 3.2,
  "priceQuantile": 0.35,
  "inflightAtSelection": 3,
  "attempts": 1,
  "outcome": "success" | "failover" | "error",
  "latencyMs": { "ttfb": 420, "total": 2100 }
}
```

**本地观测指标（用于动态调度）**：

| 指标 | 窗口 | 用途 |
|---|---|---|
| 每 seller 近 1 分钟成功率 | 滑动 60s | 健康判定 |
| 每 seller p95 TTFB | 滑动 5 分钟 | 延迟排序 |
| 每 seller in-flight | 实时 | P2C 输入 |
| 全网合格候选价格中位数 | 1 分钟 | 价格透明度展示 |
| Retry budget 使用率 | 滑动 60s | 熔断决策 |

**价格透明度**：每次响应带出：
```json
{
  "usage": { ... },
  "meta": {
    "provider": "seller-0xabc",
    "price_per_1m": 3.2,
    "price_quantile": "35%",
    "network_median": 3.5,
    "selection_reason": "cache_hit"
  }
}
```

**设计理由**：
- 没有观测就没有调优依据，出问题无法定位
- 价格透明度是用户信任的关键（详见 §7）

---

## 5. 去中心化协调机制

**核心原则**：不引入任何跨 buyer 协调，仅靠以下四个机制实现全局良好行为。

### 5.1 自然去同步（Natural Desynchronization）

每个 buyer 的**输入天然不同**：
- Session key 不同 → 粘性目标不同
- 本地观测的 latency/failure 不同
- 本地 in-flight 不同
- DHT 刷新时间有 jitter

即使算法完全相同，决策不会同步。

### 5.2 P2C 随机性

见 §4.5。从理论上证明，纯随机 + 局部信息可以达到接近全局最优的负载分布。

### 5.3 Seller Backpressure

Seller 端（provider-gateway）在响应头带出实时状态：
```
X-Load-Hint: low | medium | high | critical
X-Inflight: 8
X-Max-Concurrent: 32
```

Buyer 收到后：
- `high` → 本地权重 × 0.5，持续 30 秒
- `critical` → 本地权重 × 0.1，持续 60 秒
- 429 / 503 → 本地 markFailed，30 秒 cooldown

**关键**：seller 自己的容量信号比 DHT 快得多，是实时反馈。

### 5.4 Jitter（抖动）

所有周期性任务加随机抖动，防止全网同步：
- DHT 刷新：`60s ± 15s`
- 候选缓存 TTL：`30s ± 10s`
- 熔断半开探活：`cooldown ± 30%`
- 重试退避：指数退避 + 10%–100% jitter

**设计理由**：AWS 经典博客《Exponential Backoff and Jitter》论证，jitter 是去中心化系统避免同步风暴的最便宜手段。

---

## 6. 价格与公平性

### 6.1 用户可控上限

用户请求可带：
```json
{
  "max_price_per_1m": 5.0,
  "mode": "cheap" | "balanced" | "quality"
}
```

- `max_price` 是硬上限，永不突破
- `mode` 调整 Layer 3 的分位数

### 6.2 平台承诺（SLO）

在正常市场状态下：
> "你付的价格，不会高于全网合格 seller 中位数的 1.2 倍。"

实现：
- Layer 3 的分位数过滤天然保证（balanced 模式下只在最便宜 30% 内选）
- 监控：若某用户月度均价持续高于承诺，自动触发审查

### 6.3 冷启动 & 市场公平

- 新 seller 前 100 个请求内享受 5% exploration 流量
- 保留次便宜供给：分位数过滤而非 top1，防止"赢家通吃"
- 声誉绑定钱包地址（而非 peerId），防止 Sybil 攻击

### 6.4 价格操纵防护

- **异常低价警戒**：报价低于全网 P10 分位的 seller，自动降权（可能是诱导抢流量）
- **突变检测**：seller 价格 10 分钟内波动超过 50% → 冷却 30 分钟
- **本地验证**：Buyer 收到响应后对照 DHT announcement 校验价格，不一致则拉黑

---

## 7. 鲁棒性保护

### 7.1 多层故障隔离

```
用户请求 timeout: 60s（最外层，兜底）
  └─ Provider 请求 timeout: 45s
      └─ Seller 内部 timeout: 30s
```

**原则**：外层 timeout 必须 > 内层。buyer 能主动切，而不是傻等。

### 7.2 熔断状态机

每个 seller 本地维护：
```
healthy → [连续 3 次失败 or 错误率 > 30%] → unhealthy (30s)
unhealthy → [探活成功] → half-open → [再成功 3 次] → healthy
half-open → [失败] → unhealthy (60s，倍增)
```

**探活**：cooldown 结束后，只放 1 个请求试水，避免一起扑上去。

### 7.3 Load Shedding（buyer 侧）

当本地队列堆积严重时，直接拒绝新请求而不是无限排队：
- 本地待处理队列 > 100 → 新请求 503
- 所有 seller 都不可用 → 新请求 503

**理由**：宁愿快速失败，也不让上游雪崩拖死自己。

### 7.4 Kill Switch

配置开关可随时降级到"旧逻辑"：
```
schedulerMode: "new" | "legacy"
```
- 新算法上线默认 5% 流量灰度
- 可随时切回 legacy（保留现有 `selectBest` 路径）

---

## 8. 分阶段落地计划

每个 Phase 独立可上线、可回滚、可观测。

### Phase 0 — 观测基础（前置，必须先做）

**工作量**：1-2 天
**内容**：
- 加结构化日志（Layer 7 的日志格式）
- 加本地观测指标采集（近 1 分钟成功率、p95、in-flight）
- 把现有 `calculateScore` 的决策过程打印出来
- 加 feature flag `schedulerMode`

**验收**：能从日志还原每个请求的选择过程。

---

### Phase 1 — Hard Filter + Session 粘性 + Top-N 预选

**工作量**：3-5 天
**内容**：
- 把 `calculateScore` 改为 Layer 1 Hard Filter + 原评分（Soft Rank）
- 实现 Session 粘性表（LRU + TTL）
- `selectBest` 改为 `selectTopN`，返回 3 个候选
- 故障切换时用预选，不重跑

**预期收益**：
- 稳定性提升（Top-N 预选减少切换延迟）
- 多轮对话 cache 命中率上来（粘性）
- 烂 seller 被 hard filter 挡掉

**验收**：
- 相同 session 的连续请求 ≥ 80% 打到同一 seller
- 单 seller 故障时切换 P95 < 100ms

---

### Phase 2 — 分位数过滤 + P2C + 价格加权

**工作量**：5-7 天
**内容**：
- 实现 Layer 3 分位数过滤（cheap/balanced/quality 三档）
- 实现 Layer 5 价格加权 P2C
- 用户请求支持 `max_price` 和 `mode` 参数
- 响应里加 `meta` 价格透明字段

**预期收益**：
- 去中心化下的负载均衡（无羊群）
- 价格波动受控
- 用户可见透明度

**验收**：
- 合格候选 > 3 家时，top1 seller 的流量占比 < 50%
- 用户看到的价格 95% 落在"最便宜 30%" 内

---

### Phase 3 — Seller Backpressure + 熔断增强

**工作量**：5-7 天
**内容**：
- Seller 响应头返回 `X-Load-Hint`、`X-Inflight`
- Buyer 消费这些 header 做本地权重调整
- 实现完整熔断状态机（healthy / unhealthy / half-open）
- 加 retry budget 限制

**预期收益**：
- 过载 seller 被快速规避
- 防止重试雪崩
- 半自愈能力

**验收**：
- 注入 30% seller 故障的 chaos 测试下，成功率 > 95%
- Retry budget 被正确约束，不触发雪崩

---

### Phase 4 — Prefix-aware Routing（可选）

**工作量**：10-15 天
**内容**：
- Seller 上报 prefix 摘要（radix tree 或 bloom filter）
- Buyer 做 prefix 匹配排序
- Session 粘性 + Prefix 匹配双机制并行

**预期收益**：
- 跨 session 的 cache 复用
- LLM 吞吐 2-5× 提升（论文数据）

**验收**：
- 跨用户、相同 system prompt 的请求 ≥ 60% 命中缓存

**注意**：此阶段需要 seller 侧改造。无 seller 配合时跳过。

---

### Phase 5 — Outlier Detection + Chaos Testing

**工作量**：5-10 天
**内容**：
- Outlier ejection（p99 严重偏离群体的 seller 主动降权）
- Chaos 测试框架（模拟网络分区、seller 集体下线、恶意价格等）
- 价格操纵防护（异常低价检测、突变检测）
- 完整的 kill switch 和灰度框架

**预期收益**：
- 生产级鲁棒性
- 对抗恶意 seller 和网络分区

**验收**：
- 50% seller 突然下线，系统 30 秒内恢复
- 恶意 seller 报价攻击被自动识别

---

## 9. 测试策略

### 9.1 单元测试

- 每层独立测试（Hard Filter、Session 粘性、分位数、P2C、Backpressure 解析）
- 覆盖边界：候选 0 个、1 个、很多个；价格全相同；全都过载

### 9.2 集成测试

- 模拟 3 种 seller 混合（cheap+slow、expensive+fast、balanced）
- 验证流量分布符合预期

### 9.3 Chaos 测试

必测场景：
- Seller 突然下线（1 个 / 50% / 全部）
- 网络高延迟（300ms / 1s / 3s）
- DHT 返回过期数据
- Seller 报价突变
- 大量重试请求涌入（检查 retry budget）

### 9.4 性能基准

- 单 buyer 调度决策延迟：P99 < 10ms
- 候选集 500 个时的决策延迟：P99 < 30ms
- Session 粘性表查询：P99 < 1ms

---

## 10. 关键参数（可配置）

```typescript
{
  // Layer 1: Hard Filter
  minSuccessRate: 0.95,
  minReputationScore: 60,
  minUptimeRate: 0.90,
  newSellerExplorationRate: 0.05,

  // Layer 2: Session Sticky
  stickyTableCapacity: 1000,
  stickyTTLMs: 600_000,              // 10 min
  stickyOverflowRatio: 0.90,         // 超过 90% 容量就让它溢出
  stickyFailureIgnoreWindowMs: 60_000,

  // Layer 3: Quantile
  quantileCheap: 0.15,
  quantileBalanced: 0.30,
  quantileQuality: 0.50,
  quantileMinCandidates: 5,          // 候选少于此数就不过滤

  // Layer 5: P2C
  p2cMinPrice: 0.01,                 // 防除零

  // Layer 6: Failover
  maxProviderAttempts: 3,
  retryBudgetRatio: 0.10,
  retryBudgetWindowMs: 60_000,

  // Layer 7: Circuit Breaker
  failureThreshold: 3,
  errorRateThreshold: 0.30,
  cooldownBaseMs: 30_000,
  cooldownMaxMs: 300_000,

  // Backpressure
  loadHintHighMultiplier: 0.5,
  loadHintCriticalMultiplier: 0.1,

  // Jitter
  dhtRefreshJitterMs: 15_000,
  candidateCacheTTLJitterMs: 10_000,
}
```

---

## 11. 风险清单与缓解

| 风险 | 可能后果 | 缓解 |
|---|---|---|
| 新算法 bug 导致全网错误路由 | 服务质量下降 | Feature flag 灰度，kill switch |
| Session 粘性表内存泄漏 | buyer OOM | LRU 上限 + TTL 强制过期 |
| Retry 雪崩 | seller 连锁崩 | Retry budget + 指数退避 + jitter |
| 恶意 seller 报低价 | 用户体验差 | 冷启动流量限制 + 本地观测 + 价格操纵防护 |
| DHT 数据过期 | 选到已下线 seller | 响应头 + 本地观测覆盖 DHT |
| Prefix 摘要泄漏用户 prompt | 隐私问题 | 只报 hash 前缀，不报原文 |
| 价格剧烈波动让用户失去信任 | 用户流失 | 分位数过滤 + SLO 承诺 + 透明展示 |

---

## 12. 参考文献

### 论文
- **Mitzenmacher, M. (2001).** "The Power of Two Choices in Randomized Load Balancing." IEEE TPDS.
- **Consistent Hashing with Bounded Loads.** Google, 2016.
- **Maglev: A Fast and Reliable Software Network Load Balancer.** Google NSDI 2016.
- **Preble: Efficient Distributed Prompt Scheduling for LLM Serving.** UVA, 2024.
- **Mélange: Cost Efficient LLM Serving by Exploiting GPU Heterogeneity.** Berkeley, 2024.
- **Lu et al., Join-Idle-Queue.** Microsoft Research, 2011.

### 工程参考
- Envoy Cluster 配置（`ring_hash`, `maglev`, `outlier_detection`, `panic_threshold`）
- Linkerd Load Balancer 文档
- gRPC LB 实现
- SGLang Router 源码
- AIBrix 白皮书（ByteDance, 2024）

### 书籍与博客
- Google SRE Book, Chapter 22: "Handling Overload"
- AWS Builders' Library: "Exponential Backoff and Jitter"
- 《Designing Data-Intensive Applications》Chapter 8–9

---

## 13. 附录：和现有代码的映射

| 设计层 | 现有代码位置 | 修改程度 |
|---|---|---|
| Layer 1 Hard Filter | `consumer-router.ts:46 findProviders` | 中（拆分过滤和评分） |
| Layer 2 Session 粘性 | 新增 | 新文件 `session-sticky.ts` |
| Layer 3 分位数 | 新增 | 加在 `findProviders` 末尾 |
| Layer 4 Prefix-aware | 新增（Phase 4） | 需要 seller 改造 |
| Layer 5 P2C | `consumer-router.ts:90 selectBest` | 大（替换选择逻辑） |
| Layer 6 故障切换 | `local-server.ts:436` | 中（加 Top-N 预选） |
| Layer 7 观测 | 各处 console.log | 大（换成结构化日志） |
| Backpressure | `protection.ts:80` | 小（加响应头） |
| 熔断 | `router.ts:133` | 中（增强状态机） |

---

**文档版本**：v1.0
**最后更新**：2026-04-21
**作者**：调度设计讨论整理

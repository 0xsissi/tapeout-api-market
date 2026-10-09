# AIMM 系统架构

> 这份文档画清楚"数据在协议里怎么流"。
> 配合 `primer.md`（讲 why/what）、`engineering-spec.md`（讲 how to implement）阅读。

---

## 1. 系统全景图

```
                  ┌───────────────────────────────────────────┐
                  │          AIMM P2P Network (libp2p)        │
                  │                                           │
                  │  ┌──────────┐  gossip   ┌──────────┐      │
                  │  │  Maker A │◀────────▶│  Maker B │ ...  │
                  │  └──────────┘           └──────────┘      │
                  │       ▲                      ▲            │
                  └───────┼──────────────────────┼────────────┘
                          │                      │
                  QuoteMessage                QuoteMessage
                  (every 10s)                 (every 10s)
                          │                      │
                          ▼                      ▼
                  ┌───────────────────────────────────┐
                  │        Buyer Client (CLI)         │
                  │                                   │
                  │  ┌───────────────────────────┐    │
                  │  │    LocalQuoteCache        │    │
                  │  │  Map<MakerId, Quote>      │    │
                  │  │  TTL-based eviction       │    │
                  │  └───────────────────────────┘    │
                  │              │                    │
                  │              ▼                    │
                  │  ┌───────────────────────────┐    │
                  │  │  Softmax Router           │    │
                  │  │  P(i) = f(price, β)       │    │
                  │  └───────────────────────────┘    │
                  │              │                    │
                  └──────────────┼────────────────────┘
                                 │
                         InferenceRequest (E2EE)
                                 │
                                 ▼
                           [Chosen Maker]
                                 │
                      InferenceResponse + SignedReceipt
                                 │
                                 ▼
                     ┌──────────────────────┐
                     │  EscrowPool (Base)   │
                     │  Batch USDC claim    │
                     └──────────────────────┘
```

---

## 2. 三条主要数据流

### 流 A：Quote 广播流（后台持续）

**发起方**：每个在线的 Maker
**频率**：每 10 秒一次
**目标**：让全网 Buyer 知道自己的当前报价

```
Maker 定时器触发
  │
  ├─ 读本地 utilization u = inFlightRequests / maxConcurrent
  ├─ 读本地配置 p₀, α
  ├─ 构造 QuoteMessage {maker, model, p0, alpha, u, timestamp, ttl=10000}
  ├─ 用 Maker 私钥签名
  ▼
libp2p GossipSub.publish("aimm/quotes/{model}", message)
  │
  ▼
全网 Buyer 订阅者收到
  │
  ▼
Buyer 验签 → 存入 LocalQuoteCache
```

**关键属性**：
- 不等待、不应答——**火后不理**
- Maker 不知道有谁在听
- Buyer 不需要向 Maker 请求——信息自动送上门

### 流 B：请求流（用户触发）

**发起方**：Buyer 用户执行 `claw chat ...`
**频率**：按用户需求
**目标**：把 prompt 送到选定 Maker 并拿到结果

```
用户输入 prompt
  │
  ▼
CLI 调用 consumer-gateway
  │
  ├─ LocalQuoteCache.active(model) → 候选 Quote 列表
  │   （纯内存操作，<1ms）
  │
  ├─ Softmax 采样 → 选中一个 Maker
  │   P(i) = (1/price_i)^β / Σ(1/price_j)^β
  │
  ▼
libp2p 建立到选中 Maker 的直连（如果没有）
  │
  ├─ 发送 InferenceRequest
  │   payload = E2EE 加密(prompt, buyerPriv, makerPub)
  │
  ▼
Maker 解密、执行、流式回传
  │
  ▼
Buyer 收到 InferenceResponse + SignedReceipt
  │
  ▼
本地存档 Receipt，等候 Maker 批量 claim
```

**关键属性**：
- 选 Maker **0 次网络调用**
- 下单仅 **1 次 P2P 连接**
- 失败有 3 次自动 fallback（已实现）

### 流 C：结算流（后台 / 定时）

**发起方**：Maker（累积够一批后）
**频率**：每 N 单或每 T 分钟（取较早者）
**目标**：把链下累积的签名凭证变成链上 USDC

```
每笔成功请求 → 本地累积 SignedReceipt
  │
  ▼
触发条件到：N=50 单 或 T=60 分钟
  │
  ├─ ClaimBatcher.build(receipts) → 批量调用载荷
  │
  ▼
调用 EscrowPool.batchClaim(receipts, signatures)
  │
  ▼
合约验证每个签名 + 扣减 Buyer 余额 → 转账给 Maker
  │
  ▼
事件 USDCClaimed 上链 → 更新 Maker 信誉
```

**关键属性**：
- 单笔推理**不**上链（成本不对）
- 批量才划算
- 争议期：Buyer 可在 24 小时内 challenge 异常 Receipt

---

## 3. 核心数据结构

### QuoteMessage（新增）

```typescript
interface QuoteMessage {
  // 身份
  makerId: string;           // libp2p PeerID
  makerAddress: string;      // 链上钱包地址

  // 定价 (CUC)
  model: string;             // "claude-sonnet-3.5" | "gpt-4o" | ...
  p0: number;                // 底价 USDC / 1M tokens
  alpha: number;             // CUC 斜率，典型 0.5-2.0
  utilization: number;       // 当前 u ∈ [0, 1)

  // 容量
  maxConcurrent: number;     // 容量上限
  currentPrice: number;      // p(u) 预计算值，方便 Buyer

  // 质量
  recentLatencyMs: number;   // 最近 N 单平均延迟
  successRate: number;       // 最近 N 单成功率

  // 协议层
  timestamp: number;         // Unix ms
  ttlMs: number;             // 有效期，默认 10000
  schemaVersion: number;     // "1"

  // 签名
  signature: string;         // secp256k1(hash of above fields)
}
```

### LocalQuoteCache（Buyer 侧新增）

```typescript
interface LocalQuoteCache {
  // 按模型索引
  active(model: string): QuoteMessage[];

  // 插入新 quote（验签 + TTL 检查）
  insert(quote: QuoteMessage): void;

  // 清理过期
  cleanup(): void;

  // 汇总（给 Dashboard 用）
  depth(model: string, priceLevel: number): number;
}
```

### SignedReceipt（已有，需补充字段）

```typescript
interface SignedReceipt {
  requestId: string;
  buyerAddress: string;
  makerAddress: string;
  model: string;

  inputTokens: number;
  outputTokens: number;
  pricedAt: number;          // 🆕 成交价
  quoteUsed: QuoteMessage;   // 🆕 成交依据的完整 Quote（含签名）

  timestamp: number;
  buyerSignature: string;    // Buyer 签名确认
  makerSignature: string;    // Maker 签名确认
}
```

---

## 4. 组件职责划分

```
┌─────────────────────────────────────────────────────────────┐
│ packages/shared                                             │
│   - QuoteMessage, SignedReceipt 类型定义                     │
│   - CUC 定价纯函数: cucPrice(p0, u, alpha)                   │
│   - 签名/验签工具                                             │
└─────────────────────────────────────────────────────────────┘
           ▲                                    ▲
           │                                    │
┌──────────┴──────────────┐      ┌─────────────┴──────────────┐
│ packages/provider-gateway│      │ packages/consumer-gateway │
│ (Maker 侧)              │      │ (Buyer 侧)                │
│                         │      │                           │
│  - UtilizationTracker   │      │  - LocalQuoteCache        │
│  - CUC 定价计算          │      │  - Softmax Router         │
│  - QuoteBroadcaster     │◀────▶│  - QuoteSubscriber        │
│    每 10s 发一次         │gossip │    订阅 topic              │
│  - ClaimBatcher (已有)  │      │  - 请求/回退 (已有)         │
└─────────────────────────┘      └───────────────────────────┘
           │                                    │
           └──────────┬─────────────────────────┘
                      ▼
          ┌─────────────────────────┐
          │ packages/p2p-node       │
          │  - libp2p + GossipSub   │
          │  - topic: aimm/quotes/* │
          └─────────────────────────┘
                      │
                      ▼
          ┌─────────────────────────┐
          │ 链上 EscrowPool (Base)  │
          │  - batchClaim()         │
          │  - reputation events    │
          └─────────────────────────┘
```

---

## 5. 关键时序图

### 完整一次买家请求的时序

```
 Buyer          Buyer           Buyer          Maker          EscrowPool
 CLI         QuoteCache       libp2p         libp2p          (contract)
  │               │              │              │                │
  │ (后台)        │◀──QuoteMsg───┼──────────────│ (每10s)         │
  │               │              │              │                │
  │─ chat prompt ─▶             │              │                │
  │               │              │              │                │
  │◀─ candidates ─│              │              │                │
  │                              │              │                │
  │─ softmax pick ─┐             │              │                │
  │                ▼             │              │                │
  │───────── dial + encrypted request ─────────▶│                │
  │                              │              │                │
  │                              │              │─ compute inf ─ │
  │                              │              │                │
  │◀─── stream response + signed receipt ───────│                │
  │                              │              │                │
  │── store receipt locally ──   │              │                │
  │                              │              │                │
  │  [...重复 N 次后, Maker 触发批量 claim...]  │                │
  │                              │              │                │
  │                              │              │──batchClaim()──▶
  │                              │              │                │
  │                              │              │◀── USDC ───────
  │                              │              │                │
```

---

## 6. 失败模式与降级

| 场景 | 协议行为 |
|---|---|
| 选中的 Maker 超时 | 从 cache 取次优，最多重试 3 次 |
| Quote cache 空（刚启动） | 等 1-2 秒接收首批 gossip，或从 bootstrap 拉快照 |
| 网络分区，看不到部分 Maker | 在可见子网内正常工作，可能错过更优价 |
| Maker 广播后立即掉线 | Buyer 发请求失败→fallback；cache TTL 内自然清理 |
| **Quote 信息滞后（惊群效应）** | **Reject-with-Quote：Maker 拒绝时返回新 Quote，Buyer 更新 cache 后重试**（见 §6.1） |
| Maker 报价和实际计费不一致 | Receipt 里包含 `quoteUsed` 原文，链上可仲裁 |
| Gossip 消息被篡改 | 签名验证失败，Buyer 直接丢弃 |
| 同一 Maker 广播矛盾报价 | Buyer 采纳 timestamp 最新的；历史不一致可用于信誉扣分 |

---

## 6.1 防惊群效应的三道防线

**问题**：10 秒 Quote TTL 在高并发下太长。Maker A 广播 "u=0.1 我很便宜" 后，全网 1000 个 Buyer 看到都想砸过去，2 秒内 A 就被打到 u=0.9。但其他 Buyer 的 cache 还是旧 u，继续按低价下单。

**单靠 Softmax 稀释不够**——β=3 把最便宜 Maker 的流量从 100% 压到约 70%，但高并发下 70% 一样能打爆。

**必须三道防线组合**：

### 防线 1：Softmax 路由（概率层）
- 买家端选 Maker 时用 `P(i) = (1/price_i)^β / Σ`
- 把流量按概率分散到多个 Maker，不让最便宜的吃 100%
- **作用**：第一层稀释

### 防线 2：Reject-with-Quote（请求层）
- Maker 收到请求时实时校验：Buyer 引用的 Quote 是否过期 / u 漂移 > 15%
- 若是，返回 `RejectWithQuote { code: "STALE_QUOTE", currentQuote: freshQuote }`
- Buyer 收到后**立即更新本地 cache**（拿到签名的最新 Quote），然后从 cache 重选 Maker 重试
- **关键**：这次拒绝**不计入 Maker 声誉失败**，不消耗 3-attempt 重试配额
- **作用**：同步反馈，不等 10s 心跳

### 防线 3：事件驱动 Quote 广播（主动层）
- Maker 的 `UtilizationTracker` 监控 u 变化
- 当 Δu > 0.15 时**立即发一次 off-schedule 广播**，不等常规心跳
- 限流：同一 Maker 广播间隔 ≥ 2 秒，防抖动刷屏
- **作用**：预防还没下单的 Buyer 使用旧价

### 三道防线时序图

```
场景：Maker A 原本 u=0.1，报价 $2.00
  时刻 t=0s                         Buyer 群看到便宜 Quote，大量请求启动
                                    │
  ┌─ 防线 1：Softmax 概率分散 ─────┘
  │   - 70% 流量给 A，30% 分给 B/C
  │
  时刻 t=0.3s                       A 的 u 从 0.1 快速涨到 0.4
  │
  ├─ 防线 3：事件驱动广播启动 ─────┐
  │   - Maker A 感知 Δu>0.15      │
  │   - 立即 gossip 新 Quote       │
  │   - 全网 cache 200-500ms 内更新│
  │
  时刻 t=0.5s                       部分还没来得及更新的 Buyer 仍按旧 Quote 下单
  │
  └─ 防线 2：Reject-with-Quote ────┘
      - Maker A 校验 Quote 已失效
      - 返回拒绝 + 新 Quote
      - Buyer 更新 cache 后重试 B/C
      - 无损重试（不计失败）
```

### 参数默认值

| 参数 | 默认值 | 说明 |
|---|---|---|
| Softmax β | 3.0 | 温度参数，越大越贪婪 |
| u 漂移阈值 | 0.15 | 超过此阈值的请求被拒 |
| Quote 过期宽限 | 0ms | 严格模式，V2 可放宽 |
| 事件广播最小间隔 | 2s | 防抖动 |
| STALE_QUOTE 最大重试 | 5 次 | 防死循环 |

---

## 7. 参数默认值

| 参数 | 默认值 | 作用范围 | 说明 |
|---|---|---|---|
| Quote TTL | 10,000 ms | 全网协议约定 | Quote 有效期 |
| Quote 广播频率 | 10 s | Maker 本地 | 每 TTL 周期发一次 |
| Softmax β | 3.0 | Buyer 本地 | 温度参数 |
| CUC p₀ | 由 Maker 设 | Maker 本地 | 底价 |
| CUC α | 1.0 | Maker 默认 | 斜率 |
| MaxConcurrent | 由 Maker 设 | Maker 本地 | 容量上限 |
| Batch claim 阈值 | 50 单 或 60 分钟 | Maker 本地 | 结算触发 |
| 请求重试次数 | 3 | Buyer 本地 | 已有 |
| Bootstrap snapshot 大小 | 最近 100 条 Quote | 辅助节点 | 冷启动用 |

---

## 8. 为什么这个架构抗审查

1. **无中心调度器**：没有一个服务可被关停/诉讼/监管拔插头
2. **Gossip 通过 libp2p**：穿透 NAT，走 relay，中国墙也阻不断基础 P2P 协议
3. **E2EE 加密**：中间节点看不到 prompt 内容
4. **链上结算**：USDC 到账不依赖任何中介托管
5. **辅助节点可替换**：Bootstrap / Analytics 节点有谁跑都行，挂了一个可以换另一个

和 OpenRouter 这种中心化聚合器相比——**AIMM 没有一个可被敲门的对象**。

---

*文档版本：v0.1 · 2026-04-22*

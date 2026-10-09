# AIMM V1 工程实施文档

> 这是开发同事对着写代码的文档。
> 读前请先扫一遍 `primer.md`（协议理论）和 `architecture.md`（系统设计）。
>
> **目标**：把现有代码从"固定价格 P2P 市场"改造成"AIMM V1 协议实现"。
> **总工期估计**：3 周（一个工程师全职）

---

## 0. 改造清单一览

| # | 任务 | 优先级 | 所在包 | 预估 | 状态 |
|---|---|---|---|---|---|
| T1 | Utilization 追踪 | 🔥 P0 | provider-gateway | 1d | ✅ DONE |
| T2 | CUC 定价公式 | 🔥 P0 | shared + provider-gateway | 1d | ✅ DONE |
| T3 | QuoteMessage 类型 + 签名 | 🔥 P0 | shared + crypto | 0.5d | ✅ DONE |
| T4 | QuoteBroadcaster（Maker 侧广播） | 🔥 P0 | provider-gateway + p2p-node | 1d | ✅ DONE |
| T5 | LocalQuoteCache（Buyer 侧缓存） | 🔥 P0 | consumer-gateway | 1d | ✅ DONE |
| T6 | QuoteSubscriber（Buyer 侧订阅） | 🔥 P0 | consumer-gateway + p2p-node | 0.5d | ✅ DONE |
| T7 | Softmax 路由 | 🟡 P1 | consumer-gateway | 1d | ✅ DONE |
| T8 | Receipt 带 quoteUsed 字段 | 🟡 P1 | shared + provider-gateway | 0.5d | ✅ DONE |
| T9 | CLI 配置 p₀ / α | 🟡 P1 | cli | 0.5d | ✅ DONE |
| T10 | 集成测试 + 端到端演示 | 🟡 P1 | 全部 | 2d | ✅ DONE |
| T11 | Reject-with-Quote（防惊群） | 🔥 P0 | provider-gateway + consumer-gateway | 1d | ✅ DONE |
| T12 | 事件驱动 Quote 广播 | 🟡 P1 | provider-gateway | 0.5d | ✅ DONE |
| T13 | 滚动窗口配额追踪 | 🔥 P0 | provider-gateway | 1.5d | ✅ DONE |
| T14 | 订阅等级自动探测 + 预设配额 | 🔥 P0 | cli + provider-gateway | 1d | ✅ DONE |
| T15 | 429 / quota exhausted 容错 | 🔥 P0 | provider-gateway | 0.5d | ✅ DONE |
| T16 | Quote 反重放 + 请求幂等 | 🔥 P0 | p2p-node | 0.5d | ✅ DONE |
| T17 | 时钟偏移容忍 | 🔥 P0 | p2p-node | 0.3d | ✅ DONE |
| T18 | 熔断器（持续 u>0.95 自动下线） | 🔥 P0 | provider-gateway | 0.5d | ✅ DONE |
| T19 | 密钥分离（peer / signing / wallet） | 🔥 P0 | crypto + cli | 1d | ✅ DONE |
| T20 | 最小可观测性（结构化日志 + metrics） | 🔥 P0 | shared | 0.5d | ✅ DONE |
| T21 | AIMM TestKit（测试基础设施） | 🔥 P0 | aimm-testkit (新) | 1d | ✅ DONE |
| T22 | L1 单元 + L2 组件集成测试 | 🔥 P0 | 全部 | 持续 | ✅ DONE |
| T23 | L3 机制有效性对照实验（A-F） | 🔥 P0 | aimm-testkit | 2d | ✅ DONE |
| T24 | L4 真账号 E2E smoke | 🔥 P0 | 全部 | 0.5d | 🟡 LIVE REPORT CAPTURED |
| T25 | L5 24h 混沌长跑 | 🔥 P0 | aimm-testkit | 1d (+ 24h) | ✅ ACCELERATED PASS |

**小计**：功能 T1-T20 约 13 天，测试 T21-T25 约 5 天 + 24h，加缓冲共 4-5 周。

**测试任务 T21-T25 的详细内容见独立文档 [`test-plan.md`](./test-plan.md)**（TestKit / 对照实验 / E2E / 混沌长跑）。本文档只关心如何**建造**，测试文档关心如何**验证**。

---

### T1 重要更新（v0.4 修订）

**经研究，订阅号上游没有显式并发限制，且配额计量不是"消息数"而是"token 加权 credit"。** 据此调整：

```typescript
// ❌ 旧：u_final = max(u_concurrent, u_window)
// ✅ 新：
u_for_pricing = u_window          // CUC 定价只看配额窗口
u_for_admission = u_concurrent    // 并发仅作本地硬门禁
```

- `u_concurrent` = T1 UtilizationTracker — **只做本地 admission gate**（防止单机 CPU/网络崩）。满了直接拒单 + Reject-with-Quote（T11），**不进入 CUC 公式**
- `u_window` = T13 QuotaWindowTracker — **credit 维度**（不是 message count），是 CUC 的唯一 u

**为什么并发不能进 CUC**：
- 上游根本不按并发限。本地 maxConcurrent 是我们自己的节流阀，把它灌进价格公式会让报价随单个请求进出剧烈抖动（整数级 u 跳跃）
- u_concurrent 的稀缺性是"秒级，马上空"，u_window 的稀缺性是"小时级，要等重置"，两者语义不可混

**为什么 u_window 要按 credit 不按消息数**：Claude/Codex 订阅都是 token 加权计量。一条 Opus + 50k context 的回复，抵得上 10-15 条普通 Sonnet 消息。按消息数算的 tracker 会让重度用户"看起来还空着"但实际已经打满，上线即封号。详见 T13/T14。

---

## 1. 开发前准备

### 1.1 基线分支
```bash
git checkout -b feat/aimm-v1 origin/main
```

### 1.2 相关文件扫描
开始前先熟悉这几个文件：
- `packages/shared/src/types/index.ts` — 所有类型定义
- `packages/provider-gateway/src/billing.ts` — 现在的定价逻辑（要改）
- `packages/consumer-gateway/src/scheduler/scheduler.ts` — 现在的路由逻辑（要改）
- `packages/consumer-gateway/src/local-server.ts:518-700` — 请求主循环
- `packages/p2p-node/src/consumer-router.ts` — 现有加权评分（参考）
- `packages/crypto/src/e2ee.ts` — 签名工具（复用）

### 1.3 原则
- **向后兼容**：老的 `inputPer1m/outputPer1m` 不删，作为 p₀ 的 fallback
- **每个 PR 独立**：T1-T10 每个任务一个 PR，按顺序合并
- **CUC 公式在 shared**：Maker 和 Buyer 都要用，放公共包避免漂移
- **不要过度抽象**：V1 能跑就行，抽象留给 V2

---

## 2. P0 任务详解

### T1. Utilization 追踪

#### 目标
Maker 侧维护一个实时变量 `utilization = inFlightRequests / maxConcurrent`，每次请求开始 / 结束时更新。

#### 文件
- `packages/provider-gateway/src/billing.ts`（或新建 `utilization.ts`）

#### 实现

在 `BillingManager` 上新增字段和方法：

```typescript
// packages/provider-gateway/src/utilization.ts (新建)
export class UtilizationTracker {
  private inFlight = 0;
  private readonly maxConcurrent: number;
  private readonly window: number[] = [];  // 最近 60s 的 u 采样，用于 EWMA（V2 用）

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  onRequestStart(): void {
    this.inFlight++;
  }

  onRequestEnd(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  get current(): number {
    return Math.min(this.inFlight / this.maxConcurrent, 0.999);
  }

  get inFlightCount(): number {
    return this.inFlight;
  }
}
```

#### 集成点
在 `sidecar.ts` 或 `billing.ts` 的请求处理入口挂钩：

```typescript
// 请求进入
tracker.onRequestStart();
try {
  // ... 调用 CLIProxyAPI ...
} finally {
  tracker.onRequestEnd();
}
```

#### 验收
- [ ] 请求并发时 `tracker.current` 反映实时占用比
- [ ] 单测：并发 5 个请求，tracker.current ≈ 5/maxConcurrent
- [ ] 请求异常时 inFlight 也要减（用 try/finally）

---

### T2. CUC 定价公式

#### 目标
用 CUC 公式 `p(u) = p₀ / (1-u)^α` 替代当前的静态 `inputPer1m / outputPer1m`。

#### 文件
- `packages/shared/src/pricing.ts`（新建）
- `packages/shared/src/types/index.ts`（扩展 ModelPricing）
- `packages/provider-gateway/src/billing.ts`（改 calculateCost）

#### 实现

**1. 公共纯函数**
```typescript
// packages/shared/src/pricing.ts
export function cucPrice(p0: number, u: number, alpha: number): number {
  const uClamped = Math.min(Math.max(u, 0), 0.999);
  return p0 / Math.pow(1 - uClamped, alpha);
}
```

**2. 类型扩展**
```typescript
// packages/shared/src/types/index.ts
export interface ModelPricing {
  // 老字段保留向后兼容
  inputPer1m: number;
  outputPer1m: number;

  // 🆕 AIMM 字段
  p0?: number;          // 底价 USDC / 1M tokens（不设则 fallback to inputPer1m + outputPer1m 的平均）
  alpha?: number;       // CUC 斜率，默认 1.0
}
```

**3. 改 billing.ts 的 calculateCost**

```typescript
// packages/provider-gateway/src/billing.ts
import { cucPrice } from "@clawmarket/shared";

function calculateCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelPricing,
  utilization: number,
): number {
  const p0 = pricing.p0 ?? (pricing.inputPer1m + pricing.outputPer1m) / 2;
  const alpha = pricing.alpha ?? 1.0;
  const currentPrice = cucPrice(p0, utilization, alpha);

  const totalTokens = inputTokens + outputTokens;
  return (totalTokens / 1_000_000) * currentPrice;
}
```

#### 验收
- [ ] 单测覆盖：u=0 → p=p₀；u=0.5 α=1 → p=2p₀；u→1 → p→∞
- [ ] 未配置 p₀ / α 时走老逻辑（不破坏现有卖家）
- [ ] 价格计算在 U=0.5 时符合预期

---

### T3. QuoteMessage 类型 + 签名

#### 目标
定义 Maker 向全网广播的报价消息，带签名防伪。

#### 文件
- `packages/shared/src/types/index.ts`
- `packages/shared/src/quote.ts`（新建）

#### 实现

**1. 类型**（参见 `architecture.md` 第 3 节完整定义）

```typescript
// packages/shared/src/types/index.ts
export interface QuoteMessage {
  makerId: string;
  makerAddress: string;
  model: string;
  p0: number;
  alpha: number;
  utilization: number;
  maxConcurrent: number;
  currentPrice: number;           // 预计算的 p(u)
  recentLatencyMs: number;
  successRate: number;
  timestamp: number;
  ttlMs: number;
  schemaVersion: 1;
  signature: string;
}
```

**2. 签名 / 验签**

```typescript
// packages/shared/src/quote.ts
import { signMessage, verifyMessage } from "@clawmarket/crypto";

export function signQuote(
  quote: Omit<QuoteMessage, "signature">,
  privateKey: string,
): QuoteMessage {
  const payload = canonicalJson(quote);
  const signature = signMessage(payload, privateKey);
  return { ...quote, signature };
}

export function verifyQuote(quote: QuoteMessage, expectedAddress: string): boolean {
  const { signature, ...rest } = quote;
  const payload = canonicalJson(rest);
  return verifyMessage(payload, signature, expectedAddress);
}

export function isQuoteExpired(quote: QuoteMessage, now = Date.now()): boolean {
  return now > quote.timestamp + quote.ttlMs;
}

// 规范化 JSON 序列化（字段按 key 排序），保证签名可验证
function canonicalJson(obj: unknown): string {
  // 使用 json-stable-stringify 或手写
  return JSON.stringify(obj, Object.keys(obj).sort());
}
```

#### 验收
- [ ] 签名/验签单测覆盖
- [ ] 改字段后签名失效（防篡改）
- [ ] 过期检查函数正确

---

### T4. QuoteBroadcaster（Maker 侧）

#### 目标
Maker 节点每 10 秒广播一次 Quote 到 `aimm/quotes/{model}` topic。

#### 文件
- `packages/provider-gateway/src/quote-broadcaster.ts`（新建）
- `packages/p2p-node/src/` 增加 pubsub publish 接口

#### 实现

**1. Broadcaster**
```typescript
// packages/provider-gateway/src/quote-broadcaster.ts
import { signQuote, QuoteMessage } from "@clawmarket/shared";
import { cucPrice } from "@clawmarket/shared";

export class QuoteBroadcaster {
  private timer: NodeJS.Timer | null = null;

  constructor(
    private readonly p2p: P2PNode,
    private readonly tracker: UtilizationTracker,
    private readonly config: {
      makerId: string;
      makerAddress: string;
      privateKey: string;
      models: string[];
      p0: number;
      alpha: number;
      maxConcurrent: number;
      intervalMs: number;       // 默认 10000
      ttlMs: number;            // 默认 10000
    },
  ) {}

  start(): void {
    this.broadcast();   // 启动时立即发一次
    this.timer = setInterval(() => this.broadcast(), this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private broadcast(): void {
    const u = this.tracker.current;
    const currentPrice = cucPrice(this.config.p0, u, this.config.alpha);

    for (const model of this.config.models) {
      const quote = signQuote({
        makerId: this.config.makerId,
        makerAddress: this.config.makerAddress,
        model,
        p0: this.config.p0,
        alpha: this.config.alpha,
        utilization: u,
        maxConcurrent: this.config.maxConcurrent,
        currentPrice,
        recentLatencyMs: this.getRecentLatency(),
        successRate: this.getRecentSuccessRate(),
        timestamp: Date.now(),
        ttlMs: this.config.ttlMs,
        schemaVersion: 1,
      }, this.config.privateKey);

      this.p2p.publish(`aimm/quotes/${model}`, quote);
    }
  }

  private getRecentLatency(): number { /* 从 metrics 拉 */ return 0; }
  private getRecentSuccessRate(): number { /* 从 metrics 拉 */ return 1.0; }
}
```

**2. p2p-node 增加 publish 方法**
```typescript
// packages/p2p-node/src/index.ts （或现有文件）
publish(topic: string, message: unknown): Promise<void> {
  const encoded = new TextEncoder().encode(JSON.stringify(message));
  return this.libp2p.services.pubsub.publish(topic, encoded);
}
```

#### 集成
在 `packages/provider-gateway/src/index.ts` 的 `start()` 流程里初始化 Broadcaster：

```typescript
const tracker = new UtilizationTracker(config.maxConcurrent);
const broadcaster = new QuoteBroadcaster(p2pNode, tracker, {...});
broadcaster.start();
```

#### 验收
- [ ] 启动 Maker 后每 10s 能在日志看到 broadcast 事件
- [ ] 用第二个节点监听同 topic 能收到消息
- [ ] 改 p₀/α 配置后下次广播立即生效

---

### T5. LocalQuoteCache（Buyer 侧缓存）

#### 目标
Buyer 本地维护"按模型索引的 Quote 表"，自动清理过期项。

#### 文件
- `packages/consumer-gateway/src/quote-cache.ts`（新建）

#### 实现

```typescript
// packages/consumer-gateway/src/quote-cache.ts
import { QuoteMessage, isQuoteExpired, verifyQuote } from "@clawmarket/shared";

interface CacheEntry {
  quote: QuoteMessage;
  receivedAt: number;
}

export class LocalQuoteCache {
  // Map<model, Map<makerId, CacheEntry>>
  private readonly cache = new Map<string, Map<string, CacheEntry>>();

  private gcTimer: NodeJS.Timer | null = null;

  start(): void {
    this.gcTimer = setInterval(() => this.cleanup(), 2000);
  }

  stop(): void {
    if (this.gcTimer) clearInterval(this.gcTimer);
  }

  insert(quote: QuoteMessage): void {
    // 1. 验签（防伪）
    if (!verifyQuote(quote, quote.makerAddress)) {
      console.warn(`[QuoteCache] invalid signature from ${quote.makerId}`);
      return;
    }

    // 2. 过期检查
    if (isQuoteExpired(quote)) return;

    // 3. 时间单调性检查（防旧 Quote 覆盖新 Quote）
    const modelCache = this.cache.get(quote.model) ?? new Map();
    const existing = modelCache.get(quote.makerId);
    if (existing && existing.quote.timestamp > quote.timestamp) return;

    modelCache.set(quote.makerId, { quote, receivedAt: Date.now() });
    this.cache.set(quote.model, modelCache);
  }

  active(model: string): QuoteMessage[] {
    const modelCache = this.cache.get(model);
    if (!modelCache) return [];

    const now = Date.now();
    const result: QuoteMessage[] = [];
    for (const entry of modelCache.values()) {
      if (!isQuoteExpired(entry.quote, now)) {
        result.push(entry.quote);
      }
    }
    return result;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [model, modelCache] of this.cache) {
      for (const [makerId, entry] of modelCache) {
        if (isQuoteExpired(entry.quote, now)) {
          modelCache.delete(makerId);
        }
      }
      if (modelCache.size === 0) this.cache.delete(model);
    }
  }

  // 给 Dashboard 用
  depth(model: string, priceCeiling: number): number {
    return this.active(model)
      .filter(q => q.currentPrice <= priceCeiling)
      .reduce((sum, q) => sum + q.maxConcurrent * (1 - q.utilization), 0);
  }
}
```

#### 验收
- [ ] 插入验签失败的 Quote 被拒绝
- [ ] 过期 Quote 2s 内被 GC 清掉
- [ ] 同一 Maker 新 Quote 覆盖旧 Quote
- [ ] active(model) 返回未过期的列表

---

### T6. QuoteSubscriber（Buyer 侧订阅）

#### 目标
Buyer 订阅 `aimm/quotes/*`，收到消息后喂给 LocalQuoteCache。

#### 文件
- `packages/consumer-gateway/src/quote-subscriber.ts`（新建）

#### 实现

```typescript
// packages/consumer-gateway/src/quote-subscriber.ts
import { QuoteMessage } from "@clawmarket/shared";
import { LocalQuoteCache } from "./quote-cache";

export class QuoteSubscriber {
  constructor(
    private readonly p2p: P2PNode,
    private readonly cache: LocalQuoteCache,
    private readonly interestedModels: string[],
  ) {}

  async start(): Promise<void> {
    for (const model of this.interestedModels) {
      const topic = `aimm/quotes/${model}`;
      await this.p2p.subscribe(topic, (rawMsg) => {
        try {
          const quote: QuoteMessage = JSON.parse(new TextDecoder().decode(rawMsg));
          this.cache.insert(quote);
        } catch (err) {
          console.warn("[QuoteSubscriber] bad message", err);
        }
      });
    }
  }
}
```

#### 集成
在 `consumer-gateway` 启动流程里：
```typescript
const cache = new LocalQuoteCache();
cache.start();
const subscriber = new QuoteSubscriber(p2pNode, cache, ["claude-sonnet-3.5", "gpt-4o", "gemini-pro"]);
await subscriber.start();
```

#### 验收
- [ ] 本机跑 Maker + Buyer，Buyer 能在 15s 内收到至少 1 条 Quote
- [ ] Cache 的 active() 返回这条 Quote

---

## 3. P1 任务详解

### T7. Softmax 路由

#### 目标
替换现有贪婪路由（取 `providers[0]`）为概率采样。

#### 文件
- `packages/consumer-gateway/src/scheduler/scheduler.ts`
- `packages/consumer-gateway/src/local-server.ts:518-700`

#### 实现

```typescript
// packages/consumer-gateway/src/scheduler/softmax.ts (新建)
import { QuoteMessage } from "@clawmarket/shared";

export function softmaxSample(
  quotes: QuoteMessage[],
  beta: number = 3.0,
): QuoteMessage | null {
  if (quotes.length === 0) return null;
  if (quotes.length === 1) return quotes[0];

  const weights = quotes.map(q => Math.pow(1 / q.currentPrice, beta));
  const sum = weights.reduce((a, b) => a + b, 0);
  const normalized = weights.map(w => w / sum);

  const r = Math.random();
  let acc = 0;
  for (let i = 0; i < quotes.length; i++) {
    acc += normalized[i];
    if (r <= acc) return quotes[i];
  }
  return quotes[quotes.length - 1];
}

// 给用户手动挡的出口
export function greedyPick(quotes: QuoteMessage[]): QuoteMessage | null {
  if (quotes.length === 0) return null;
  return quotes.reduce((best, q) => q.currentPrice < best.currentPrice ? q : best);
}
```

集成到 `scheduler.ts`:
```typescript
async select(model: string, options: { prefer?: "price" | "latency"; maker?: string }): Promise<QuoteMessage | null> {
  const candidates = this.quoteCache.active(model);
  if (candidates.length === 0) return null;

  if (options.maker) {
    return candidates.find(q => q.makerId === options.maker) ?? null;
  }

  if (options.prefer === "price") return greedyPick(candidates);

  return softmaxSample(candidates, this.config.softmaxBeta ?? 3.0);
}
```

#### 验收
- [ ] 5 个 Maker，价格分布 [$2, $2.2, $3, $5, $10]，跑 1000 次采样，最便宜的占比 ~50-70%
- [ ] `--maker <id>` 能精确定位
- [ ] `--prefer price` 等同于贪婪

---

### T8. Receipt 带 quoteUsed

#### 目标
每笔 Receipt 记录成交时用的 Quote 原文（含签名），便于将来仲裁。

#### 文件
- `packages/shared/src/types/index.ts`
- `packages/provider-gateway/src/billing.ts`（产出 receipt 时填 quoteUsed）
- `packages/consumer-gateway/src/local-server.ts`（发请求前记录当时的 Quote）

#### 改动
在 `SignedReceipt` 增加字段（参见 architecture.md 第 3 节）：
```typescript
interface SignedReceipt {
  ...existing fields,
  pricedAt: number;           // 🆕
  quoteUsed: QuoteMessage;    // 🆕
}
```

Buyer 发请求时把当时选中的 Quote 发给 Maker，Maker 在签 Receipt 时原样回塞。

#### 验收
- [ ] Receipt 里含完整 Quote 原文
- [ ] quoteUsed 签名和 makerAddress 一致
- [ ] pricedAt === quoteUsed.currentPrice（基于当时 u）

---

### T9. CLI/TUI 配置 p₀ / α + AIMM 卖家 UX 改造

#### 目标
**核心认知修正**：卖家设的价格是**底价 p₀（最低能接受的价）**，不是实际成交价。实际成交价由 CUC 公式 `p(u) = p₀ / (1-u)^α` 实时计算。**TUI 必须把这个讲清楚，否则卖家看到成交价会困惑**。

#### 涉及三个地方
1. **Onboarding 步骤**（首次引导）—— 教育 + 输入
2. **Seller Console 视图**（日常 dashboard）—— 实时显示底价 / α / u / 实时价
3. **config schema**（配置文件）—— 新增 p₀/α 字段

#### 文件
- `packages/cli/src/config/schema.ts`
- `packages/cli/src/tui/onboarding/`（seller 流程对应步骤）
- `packages/cli/src/tui/console/views/Seller.tsx`（pricing panel）
- `packages/cli/src/tui/components/PriceCurvePreview.tsx`（新建）

#### 改动 1：Schema

```typescript
// packages/cli/src/config/schema.ts
seller: {
  // ... 其他字段 ...
  pricing: {
    input: number;         // 🚨 老字段，保留作为 p₀ 兜底
    output: number;        // 🚨 老字段，保留作为 p₀ 兜底
    p0?: number;           // 🆕 底价 USDC / 1M tokens（未设则 = (input + output) / 2）
    alpha?: number;        // 🆕 CUC 斜率，默认 1.0
    maxConcurrent?: number;// 🆕 容量上限（已有 maxConcurrent 字段则复用）
  };
}
```

#### 改动 2：Onboarding 步骤 — 带教育的输入

```
┌─ 设置做市参数 ──────────────────────────────────────────┐
│                                                       │
│  AIMM 下你设的是"底价"（最低愿意接受的价）              │
│  实际成交价会随需求自动浮动：生意闲价接近底价，            │
│  生意忙自动涨价保留容量。                                │
│                                                       │
│  底价 p₀         $ [2.00] / 1M tokens                 │
│                  └─ 低于此价不成交                      │
│                                                       │
│  斜率 α         [1.0]                                 │
│                  └─ 0.5=温和涨价  1.0=平衡(推荐)       │
│                     2.0=激进涨价（稀缺时高价）           │
│                                                       │
│  最大并发        [5] 个请求                            │
│                  └─ 超过后会限流                        │
│                                                       │
│  ┌─ 价格预览 ──────────────────────────┐              │
│  │  空闲时 (u=0)     $2.00            │              │
│  │  一半占用 (u=0.5) $4.00            │              │
│  │  满载时 (u=0.9)   $20.00           │              │
│  └─────────────────────────────────────┘              │
│                                                       │
│  [保存]  [跳过 → 用推荐值]                              │
└─────────────────────────────────────────────────────────┘
```

**实现要点**：
- "价格预览"是实时计算的，用户改 p₀/α 时立刻更新
- 提供"跳过 → 推荐值"出口（p₀=$2, α=1, concurrent=5）给新手
- 顶部 3 行说明文字是**硬性必须有的教育**

#### 改动 3：Seller Console 视图

替换现有的静态价格面板：

```
┌─ 做市参数 ────────────────────────────────────────────┐
│                                                      │
│  底价 p₀          $2.00 / 1M tokens   [p] 修改        │
│  斜率 α           1.0                 [a] 修改        │
│  最大并发         5                    [c] 修改        │
│                                                      │
├─ 当前状态（实时） ─────────────────────────────────────┤
│                                                      │
│  利用率 u         0.40    ████░░░░░░ 40%             │
│  实时报价         $3.33 / 1M tokens                   │
│  在途请求         2 / 5                               │
│                                                      │
├─ 价格曲线 ────────────────────────────────────────────┤
│                                                      │
│  $20 ┤                                    ●         │
│      │                               ●              │
│  $10 ┤                         ●                    │
│      │                  ●                           │
│   $4 ┤           ●◀ 你现在在这                       │
│   $2 ┤── ●                                          │
│      └──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬                │
│         0  0.2  0.4  0.6  0.8  1.0  (u)             │
│                                                      │
├─ 今日统计 ────────────────────────────────────────────┤
│                                                      │
│  已售 tokens      1.2M                               │
│  平均成交价       $2.87 / 1M tokens                   │
│  收入             $3.44 USDC                         │
│  Quote 广播       86 次                              │
│  被拒 (STALE)    3 次                                │
│                                                      │
└──────────────────────────────────────────────────────┘
```

**实现要点**：
- "实时报价" 和 "利用率" 必须是**实时的**（订阅 UtilizationTracker 的事件）
- 价格曲线图可以用 ASCII art 或 Ink 的图表组件
- "平均成交价"和"底价"的差，直观告诉卖家 CUC 在生效

#### 改动 4：新建 PriceCurvePreview 组件

```tsx
// packages/cli/src/tui/components/PriceCurvePreview.tsx
import { Box, Text } from "ink";
import { cucPrice } from "@clawmarket/shared";

interface Props {
  p0: number;
  alpha: number;
  currentU?: number;  // 可选，画"你在这"标记
  mode?: "table" | "ascii-chart";
}

export function PriceCurvePreview({ p0, alpha, currentU, mode = "table" }: Props) {
  const samples = [0, 0.25, 0.5, 0.75, 0.9, 0.99];
  if (mode === "table") {
    return (
      <Box flexDirection="column">
        <Text bold>价格预览</Text>
        {samples.map(u => {
          const price = cucPrice(p0, u, alpha);
          const marker = currentU !== undefined && Math.abs(u - currentU) < 0.1 ? " ◀ 现在" : "";
          return (
            <Text key={u}>
              {`  u=${u.toFixed(2)}  →  $${price.toFixed(2)}${marker}`}
            </Text>
          );
        })}
      </Box>
    );
  }
  // ascii-chart 实现省略
}
```

#### 改动 5：Tooltip / Help 文本

在 Console 界面 [?] help 面板里加一段 AIMM 说明：

```
关于 AIMM 定价

  你设的"底价 p₀"是最低成交价——任何请求的价格都不会低于它。
  实际成交价随容量占用自动浮动：
    • 闲 (u=0)     → 接近 p₀
    • 半满 (u=0.5) → 约 p₀ × 2
    • 满载 (u=0.9) → 约 p₀ × 10

  斜率 α 控制涨价速度：
    • α=0.5  温和，适合薄利多销
    • α=1.0  平衡（推荐）
    • α=2.0  激进，适合稀缺容量

  查看自己在市场中的位置：[m] 打开 Market Depth
```

#### 验收
- [ ] 新卖家 onboarding 顶部 3 行教育文本清晰显示
- [ ] Onboarding 价格预览随输入实时更新
- [ ] Seller 视图"实时报价"随 u 变化而变化（可通过触发请求验证）
- [ ] 价格曲线图正确显示当前 u 位置
- [ ] "跳过 → 推荐值"出口能一键完成
- [ ] Help 面板的 AIMM 教育文字存在且准确
- [ ] 修改 p₀/α 后下次 Quote 广播（≤10s）立即生效
- [ ] α=0 时退化成固定价（给保守卖家选项）

#### 边界情况
- **p₀ 输入 0 或负数**：拒绝保存，提示"底价必须 > 0"
- **α 输入 0**：允许（退化固定价），但提示"α=0 时不享受 CUC 自动涨价"
- **α 输入过大（>3）**：保存，但警告"高斜率在满载时价格可能惊人"

---

### T11. Reject-with-Quote（防惊群效应，P0 关键）

#### 为什么需要
Softmax（T7）只稀释流量概率，不解决"信息滞后"问题：
- 10 秒 TTL 内，Maker A 从 u=0.1 被打到 u=0.9，其他 Buyer 的本地 cache 还在按旧 u 下单
- 大量请求继续砸向 A，造成雷鸣之兽

**解决方案**：Maker 拒绝过期报价请求时，在拒绝消息里附带最新 Quote，Buyer 立即更新 cache 并重试其他 Maker。

#### 文件
- `packages/shared/src/types/index.ts`（新增拒绝响应类型）
- `packages/provider-gateway/src/sidecar.ts`（Maker 侧入口校验）
- `packages/consumer-gateway/src/local-server.ts`（Buyer 侧重试逻辑）

#### 实现

**1. 新增协议消息**
```typescript
// packages/shared/src/types/index.ts
export interface RejectWithQuote {
  code: "STALE_QUOTE";
  reason: string;                // "utilization exceeded tolerance"
  currentQuote: QuoteMessage;    // 最新 Quote（带签名）
  retryable: true;
}
```

**2. Maker 侧校验（sidecar.ts）**

请求到达时 Maker 检查：
- Buyer 引用的 Quote 是否过期（timestamp + ttl < now）
- 当前 u 是否偏离 Quote 里的 u 超过阈值（如 Δu > 0.15）

两个条件任一满足 → 返回 `RejectWithQuote`，带新 Quote。

```typescript
// packages/provider-gateway/src/sidecar.ts
function validateQuoteFreshness(
  quoteInRequest: QuoteMessage,
  currentU: number,
  tracker: UtilizationTracker,
): RejectWithQuote | null {
  const now = Date.now();
  const quoteExpired = now > quoteInRequest.timestamp + quoteInRequest.ttlMs;
  const uDrift = Math.abs(currentU - quoteInRequest.utilization);

  if (!quoteExpired && uDrift < 0.15) return null;

  // 需要拒绝，构造最新 Quote
  const freshQuote = buildFreshQuote(tracker.current);
  return {
    code: "STALE_QUOTE",
    reason: quoteExpired ? "quote TTL expired" : `u drift ${uDrift.toFixed(2)}`,
    currentQuote: freshQuote,
    retryable: true,
  };
}
```

**3. Buyer 侧接收逻辑（local-server.ts 的重试循环）**

```typescript
// 在现有 3-attempt 循环里增加分支
for (let attempt = 0; attempt < MAX_PROVIDER_ATTEMPTS; attempt++) {
  const quote = softmaxSample(quoteCache.active(model), beta);
  const response = await sendRequest(quote.makerId, prompt, { quoteRef: quote });

  if (response.code === "STALE_QUOTE") {
    // 关键：更新本地 cache 后重试，不计入失败次数
    quoteCache.insert(response.currentQuote);
    attempt--;   // 补偿：不消耗重试配额
    continue;
  }

  if (response.ok) return response;
  // 其他错误走原 fallback 逻辑
}
```

#### 参数
- **Δu 阈值**：默认 0.15（可调，太小会频繁拒绝，太大起不到作用）
- **不消耗重试配额**：stale quote 不算 Maker 失败，否则会误伤声誉
- **死循环保护**：同一 prompt 最多接受 5 次 STALE_QUOTE 拒绝，超过走常规 fallback

#### 验收
- [ ] 在高并发压测下（200 并发请求砸同一 Maker），拒绝+重试能在 <500ms 内完成
- [ ] 被拒绝的请求不计入 Maker 声誉失败
- [ ] 正常流量下 Reject 率 <1%
- [ ] 验证：过期 Quote / u 漂移两种场景分别能触发

---

### T12. 事件驱动 Quote 广播（P1，配合 T11）

#### 为什么需要
T11 是"被动拒绝"兜底，T12 是"主动加速"预防：
- 正常情况 Maker 每 10s 广播一次
- 当 u 发生显著跳变（如一下子从 0.1 涨到 0.5），**不等心跳，立即触发一次 off-schedule 广播**
- 这样还没发出的 Buyer 请求能提前看到新价，减少后续 STALE_QUOTE 发生率

#### 文件
- `packages/provider-gateway/src/quote-broadcaster.ts`（T4 已创建）
- `packages/provider-gateway/src/utilization.ts`（T1 已创建，加事件发射）

#### 实现

UtilizationTracker 增加事件：
```typescript
import { EventEmitter } from "node:events";

export class UtilizationTracker extends EventEmitter {
  private lastBroadcastU: number = 0;

  onRequestStart(): void {
    this.inFlight++;
    this.maybeEmitJump();
  }

  onRequestEnd(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.maybeEmitJump();
  }

  private maybeEmitJump(): void {
    const now = this.current;
    if (Math.abs(now - this.lastBroadcastU) >= 0.15) {
      this.emit("u-jump", { from: this.lastBroadcastU, to: now });
      this.lastBroadcastU = now;
    }
  }
}
```

Broadcaster 监听：
```typescript
tracker.on("u-jump", () => {
  this.broadcast();  // 触发一次额外广播
});
```

#### 限流
防止高频抖动触发过多广播：
- 事件触发的广播与常规心跳共享一个**最小间隔**（默认 2 秒）
- 短时间内多次事件合并成一次广播

#### 验收
- [ ] u 从 0.1 跳到 0.3 立即触发额外广播（不等 10s 心跳）
- [ ] 短时间内 10 次跳变只产生 ~5 次广播（限流有效）
- [ ] 对常规场景无性能影响

---

### T13. 滚动窗口配额追踪（真正的 u_window）

> **v0.3 修订（2026-04-22）**：优先读**上游响应 header**（Claude 会直接告诉你还剩多少），只在 header 不可用时才 fallback 到本地数滑窗。这比全靠 CLIProxyAPI usage 数据聚合更准、更便宜。

#### 为什么需要
T1 UtilizationTracker 只追"并发槽"（L1），但订阅用户真正的瓶颈是**上游的滚动时间窗配额**（L2）：
- ChatGPT Plus ≈ 40 msg / 3h
- Claude Pro ≈ 45 msg / 5h
- Claude Max 5× / 20× ≈ 225 / 900 msg / 5h

#### 数据源优先级（从强到弱）

| Provider | 权威源 | 降级 |
|---|---|---|
| **Claude** | 响应 header `anthropic-ratelimit-tokens-remaining` / `-unified-*-remaining` | 本地滑窗 |
| **ChatGPT / Codex** | 无 header，**只能本地数** | 429 触发立即置 u=1 |
| **Gemini** | `loadCodeAssist` 返回部分 quota（启动时探一次） | 本地滑窗 |

所以这个 tracker 有两条数据路径：
1. **Header 路径**（Claude 独享）：provider-gateway 的 CliproxyClient 响应拦截器抓 header，直接更新 `tokensRemaining` → 反推 u
2. **本地滑窗路径**（兜底）：从 CLIProxyAPI `/v0/management/usage` 轮询，按账号维护滚动窗口

#### 文件
- `packages/provider-gateway/src/quota-window-tracker.ts`（新建）
- `packages/provider-gateway/src/cliproxy-usage-client.ts`（新建，轮询 `/v0/management/usage`）
- `packages/provider-gateway/src/upstream/ratelimit-header-parser.ts`（新建，抓 Claude header）
- `packages/provider-gateway/src/upstream/CliproxyClient.ts`（改：响应拦截器调 parser）

#### 实现

**1. Header 解析器（Claude 专属）**

```typescript
// packages/provider-gateway/src/upstream/ratelimit-header-parser.ts
export interface RateLimitSnapshot {
  authIndex: string;
  observedAt: number;
  // 两套 header 同时可能出现，优先用 unified（Max 版才有）
  requestsLimit?: number;
  requestsRemaining?: number;
  tokensLimit?: number;
  tokensRemaining?: number;
  resetAt?: number;   // Unix ms
}

export function parseClaudeHeaders(h: Headers, authIndex: string): RateLimitSnapshot | null {
  const pick = (name: string) => h.get(name) ?? h.get(name.replace('unified-', ''));
  const limit = pick('anthropic-ratelimit-unified-tokens-limit');
  const remain = pick('anthropic-ratelimit-unified-tokens-remaining');
  const reset = pick('anthropic-ratelimit-unified-tokens-reset');
  if (!limit && !remain) {
    // 不是 unified 版，试普通
    const rLimit = h.get('anthropic-ratelimit-requests-limit');
    const rRemain = h.get('anthropic-ratelimit-requests-remaining');
    if (!rLimit && !rRemain) return null;
    return {
      authIndex,
      observedAt: Date.now(),
      requestsLimit: rLimit ? +rLimit : undefined,
      requestsRemaining: rRemain ? +rRemain : undefined,
    };
  }
  return {
    authIndex,
    observedAt: Date.now(),
    tokensLimit: limit ? +limit : undefined,
    tokensRemaining: remain ? +remain : undefined,
    resetAt: reset ? new Date(reset).getTime() : undefined,
  };
}
```

**2. CLIProxyAPI 客户端（本地滑窗路径）**

```typescript
// packages/provider-gateway/src/cliproxy-usage-client.ts
interface UsageRecord {
  timestamp: number;       // Unix ms
  authIndex: string;       // 哪个账号
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  failed: boolean;
}

export class CliproxyUsageClient {
  constructor(
    private readonly managementUrl: string,   // "http://localhost:3121"
    private readonly pollIntervalMs: number = 10_000,
  ) {}

  async fetchRecentRecords(sinceMs: number): Promise<UsageRecord[]> {
    const res = await fetch(`${this.managementUrl}/management/usage`);
    const data = await res.json();
    const records: UsageRecord[] = [];
    // 从嵌套的 apis[key].models[model].details[] 抽平
    for (const apiKey of Object.keys(data.usage.apis)) {
      const models = data.usage.apis[apiKey].models ?? {};
      for (const model of Object.keys(models)) {
        for (const detail of models[model].details ?? []) {
          const ts = new Date(detail.timestamp).getTime();
          if (ts < sinceMs) continue;
          records.push({
            timestamp: ts,
            authIndex: detail.auth_index,
            model,
            inputTokens: detail.tokens?.input_tokens ?? 0,
            outputTokens: detail.tokens?.output_tokens ?? 0,
            totalTokens: detail.tokens?.total_tokens ?? 0,
            failed: detail.failed === true,
          });
        }
      }
    }
    return records;
  }
}
```

**3. 配额窗口追踪器（credit 模型 + 5h + 周双窗口）**

> 关键变化（v0.4）：
> - 计量单位从"消息数 / tokens 直接求和"改为 **credit**（token 加权，按 model weight）
> - 同时维护 **5h 滚动窗 + 周滚动窗**，u 取两者 max
> - Claude header 仍是权威源，但解析后也**归一化成 credit**（header 自带的 unified-tokens-remaining 本来就是加权值，用它等价于一个免费的服务端 credit 计数器）

```typescript
// packages/provider-gateway/src/quota-window-tracker.ts
export interface AccountQuota {
  authIndex: string;
  upstream: 'claude' | 'codex' | 'gemini';

  // 主窗口（5h）
  credits: number;               // 5h 总预算（credit 单位）
  windowMs: number;              // 通常 5 * 3600_000

  // 次窗口（周），可选
  weeklyCredits?: number;
  weeklyWindowMs?: number;       // 通常 7 * 24 * 3600_000

  // 把 tokens 换算成 credit 的权重：credits = modelWeights[model] × total_tokens / 1000
  modelWeights: Record<string, number>;
  defaultWeight: number;         // 未知 model 的兜底
}

export class QuotaWindowTracker {
  private readonly buffers = new Map<string, UsageRecord[]>();   // 本地滑窗（credit 已计算好）
  private readonly headerSnap = new Map<string, RateLimitSnapshot>();
  private pollTimer: NodeJS.Timer | null = null;
  private lastPollAt = Date.now();

  constructor(
    private readonly client: CliproxyUsageClient,
    private readonly quotas: AccountQuota[],
  ) {}

  /** CliproxyClient 响应拦截器调用，权威性高于本地滑窗 */
  ingestHeader(snap: RateLimitSnapshot): void {
    this.headerSnap.set(snap.authIndex, snap);
  }

  async start(): Promise<void> {
    this.pollTimer = setInterval(() => this.poll(), 10_000);
    await this.poll();
  }

  stop(): void { if (this.pollTimer) clearInterval(this.pollTimer); }

  private creditsFor(q: AccountQuota, rec: UsageRecord): number {
    const w = q.modelWeights[rec.model] ?? q.defaultWeight;
    return (w * rec.totalTokens) / 1000;
  }

  private async poll(): Promise<void> {
    const now = Date.now();
    const records = await this.client.fetchRecentRecords(this.lastPollAt - 1000);
    this.lastPollAt = now;

    for (const rec of records) {
      const buf = this.buffers.get(rec.authIndex) ?? [];
      buf.push(rec);
      this.buffers.set(rec.authIndex, buf);
    }
    // 清理（超出最大窗口，包括周窗）
    const maxWindow = Math.max(...this.quotas.map(q => q.weeklyWindowMs ?? q.windowMs));
    for (const [key, buf] of this.buffers) {
      this.buffers.set(key, buf.filter(r => r.timestamp >= now - maxWindow));
    }
  }

  /** 5h 窗口内账号 u：优先 header，其次本地滑窗 */
  private primaryU(q: AccountQuota, now: number): number {
    const snap = this.headerSnap.get(q.authIndex);
    if (snap && now - snap.observedAt < 60_000) {
      if (snap.tokensLimit && snap.tokensRemaining != null) {
        // Claude unified header 本身就是加权分数
        return Math.min(1 - snap.tokensRemaining / snap.tokensLimit, 0.999);
      }
      if (snap.requestsLimit && snap.requestsRemaining != null) {
        return Math.min(1 - snap.requestsRemaining / snap.requestsLimit, 0.999);
      }
    }
    // Fallback: 本地滑窗，credit 累加
    const buf = this.buffers.get(q.authIndex) ?? [];
    const relevant = buf.filter(r => r.timestamp >= now - q.windowMs && !r.failed);
    const usedCredits = relevant.reduce((s, r) => s + this.creditsFor(q, r), 0);
    return Math.min(usedCredits / q.credits, 0.999);
  }

  /** 周窗口 u（纯本地滑窗，Anthropic 暂不暴露周 header） */
  private weeklyU(q: AccountQuota, now: number): number {
    if (!q.weeklyCredits || !q.weeklyWindowMs) return 0;
    const buf = this.buffers.get(q.authIndex) ?? [];
    const relevant = buf.filter(r => r.timestamp >= now - q.weeklyWindowMs! && !r.failed);
    const usedCredits = relevant.reduce((s, r) => s + this.creditsFor(q, r), 0);
    return Math.min(usedCredits / q.weeklyCredits!, 0.999);
  }

  /** 单账号 u：两个窗口取 max（任一窗口满都要涨价） */
  accountU(q: AccountQuota, now = Date.now()): number {
    return Math.max(this.primaryU(q, now), this.weeklyU(q, now));
  }

  /** 跨账号聚合：按 credit 容量加权平均（和单账号 u 语义一致） */
  get aggregateUtilization(): number {
    const now = Date.now();
    let totalUsedCap = 0;
    let totalCap = 0;
    for (const q of this.quotas) {
      const u = this.accountU(q, now);
      totalUsedCap += u * q.credits;
      totalCap += q.credits;
    }
    if (totalCap === 0) return 0;
    return Math.min(totalUsedCap / totalCap, 0.999);
  }

  /** Dashboard 视图 */
  perAccount(): Array<{
    authIndex: string; uPrimary: number; uWeekly: number; u: number;
    source: 'header' | 'window';
  }> {
    const now = Date.now();
    return this.quotas.map(q => {
      const snap = this.headerSnap.get(q.authIndex);
      const source: 'header'|'window' = snap && now - snap.observedAt < 60_000 ? 'header' : 'window';
      const uPrimary = this.primaryU(q, now);
      const uWeekly = this.weeklyU(q, now);
      return { authIndex: q.authIndex, uPrimary, uWeekly, u: Math.max(uPrimary, uWeekly), source };
    });
  }
}
```

**关于 modelWeights 的基准**（从 2026-04 公开 Anthropic 定价反推，以 Sonnet = 1 为单位）：

```typescript
// packages/shared/src/model-weights.ts
export const CLAUDE_MODEL_WEIGHTS = {
  'claude-opus-4':     5.0,
  'claude-sonnet-4':   1.0,
  'claude-haiku-4-5':  0.15,
} as const;

export const CODEX_MODEL_WEIGHTS = {
  'gpt-5.4':           1.0,
  'gpt-5.4-mini':      0.2,
  'gpt-5.3-codex':     0.6,
} as const;
```
这些数字会漂——必须在 `SUBSCRIPTION_PRESETS` 旁边留注释提醒每季度校准。

**4. QuoteBroadcaster 的 u 计算（T4 修订，v0.4）**

```typescript
// 定价只看 u_window；并发只做 admission
const uWindow = this.quotaTracker.aggregateUtilization;
const price = cucPrice(p0, uWindow, alpha);

// u_concurrent 不进公式，但在 inbound request handler 里：
//   if (this.tracker.current >= 1) → reject + RejectWithQuote (T11)
```

#### 验收
- [ ] 单测：header parser 正确解析 unified-* 和普通 requests-* 两种形态
- [ ] 单测：creditsFor 按 modelWeights 正确加权（Opus 1000 tokens = 5 credit，Sonnet 1000 tokens = 1 credit）
- [ ] 单测：注入"Opus 5 次每次 2k tokens"的记录，Pro plan credits=45 → u ≈ 50/45 → clamp 0.999；再注入"Sonnet 5 次每次 2k tokens" → u ≈ 10/45 ≈ 0.22
- [ ] Claude 响应注入 `unified-tokens-remaining: 10000` / `limit: 100000` → `primaryU` 返回 `source='header'`、u=0.9
- [ ] header 超过 60s 未更新 → 自动回落到本地 credit 滑窗（`source='window'`）
- [ ] 周窗口独立生效：5h 窗 u=0.3，但周窗 u=0.9 → `accountU` 返回 0.9
- [ ] 上游 429 的失败请求不计入已用（`!failed`）
- [ ] 跨账号聚合：3 个 Pro 账号（credits=45 each），累计花了 45 credit → aggregateUtilization ≈ 0.33
- [ ] 轮询间隔 10s，CLIProxyAPI 宕机不崩溃（降级到只看并发 admission + 最后一次 header 快照）
- [ ] modelWeights 里不存在的 model 走 `defaultWeight`，不抛异常

---

### T14. 订阅等级**自动探测** + 预设配额

> **v0.3 重写（2026-04-22）**：之前让卖家手选 tier，上线 friction 太大。各家 CLI 登录后其实都在本地留有足够证据让我们自己探测出来。手填从"必填"降为"探测失败时的 fallback"。

#### 三家探测策略

| Provider | 探测方式 | 证据来源 |
|---|---|---|
| **Codex / ChatGPT** | 读 `~/.codex/auth.json`，base64 解码 `tokens.id_token` 的 JWT payload，取 `https://api.openai.com/auth.chatgpt_plan_type`（`plus` / `pro` / `team` / `enterprise`） | 本地文件，零网络请求 |
| **Claude Code** | 先试一个 1-token 轻量 `/v1/messages` ping，抓响应 header。有 `anthropic-ratelimit-unified-*` → Max 版；按 limit 数值分档 Max5× vs Max20×。只有普通 `anthropic-ratelimit-requests-*` → Pro | JWT 里**没有** tier |
| **Gemini** | 带 OAuth token GET `https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`，返回 `FREE` / `STANDARD` / `PAID` | 官方端点 |

探测失败的情况（必须 fallback 到手填）：
- Codex JWT 里没有 `chatgpt_plan_type` 字段（已知 bug: openai/codex#13007, ARM64 Windows）
- Claude ping 收到网络错误或 5xx
- Gemini 的 OAuth token 过期

#### 文件
- `packages/provider-gateway/src/tier-prober/index.ts`（新建，入口）
- `packages/provider-gateway/src/tier-prober/codex.ts`（JWT 解码）
- `packages/provider-gateway/src/tier-prober/claude.ts`（ping + header 分档）
- `packages/provider-gateway/src/tier-prober/gemini.ts`（loadCodeAssist 调用）
- `packages/shared/src/subscription-presets.ts`（tier → 限额 map）

#### 实现

**1. 预设表（tier → 限额）**

```typescript
// packages/shared/src/subscription-presets.ts
//
// ⚠️ 数字全是 credit 单位（不是"消息数"），以 Sonnet / GPT-5.4 为 1× 基准。
// ⚠️ 2026-04 基线，Anthropic/OpenAI 每季度都可能调，务必每 release 校准一次。
// ⚠️ credits ≈ 官方宣传的 "Opus 消息数"（因为 Opus = 5× Sonnet，Pro=45 Opus msg ≈ 45 credit / 5 ≈ 9 "Opus msg"
//     其实不对等——官方数字本身就隐含一条消息的平均 token 量假设。
//     实际运行时以 Claude unified header 为准，presets 仅用于 header 缺失时的 fallback 估算。)

export const SUBSCRIPTION_PRESETS = {
  "chatgpt-plus": {
    label: "ChatGPT Plus",
    upstream: "codex",
    credits: 100,              // 5h 内能跑 ~100 credit (GPT-5.4 消息)
    windowMs: 5 * 3600_000,
    weeklyCredits: 100 * 5,    // 周预算估算（Codex 刚引入，需观察）
    weeklyWindowMs: 7 * 24 * 3600_000,
    modelWeights: CODEX_MODEL_WEIGHTS,
    defaultWeight: 1.0,
  },
  "chatgpt-pro": {
    label: "ChatGPT Pro",
    upstream: "codex",
    credits: 500,
    windowMs: 5 * 3600_000,
    weeklyCredits: 500 * 5,
    weeklyWindowMs: 7 * 24 * 3600_000,
    modelWeights: CODEX_MODEL_WEIGHTS,
    defaultWeight: 1.0,
  },
  "chatgpt-business": { /* 同 pro，值略不同 */ } as any,
  "chatgpt-enterprise": { /* 定制 */ } as any,

  "claude-pro": {
    label: "Claude Pro",
    upstream: "claude",
    credits: 45,               // 相当于 ~45 条 Opus / ~100 条 Sonnet
    windowMs: 5 * 3600_000,
    weeklyCredits: 45 * 7,     // 周限保守估计
    weeklyWindowMs: 7 * 24 * 3600_000,
    modelWeights: CLAUDE_MODEL_WEIGHTS,
    defaultWeight: 1.0,
  },
  "claude-max-5x": {
    label: "Claude Max 5×",
    upstream: "claude",
    credits: 225,
    windowMs: 5 * 3600_000,
    weeklyCredits: 225 * 7,
    weeklyWindowMs: 7 * 24 * 3600_000,
    modelWeights: CLAUDE_MODEL_WEIGHTS,
    defaultWeight: 1.0,
  },
  "claude-max-20x": {
    label: "Claude Max 20×",
    upstream: "claude",
    credits: 900,
    windowMs: 5 * 3600_000,
    weeklyCredits: 900 * 7,
    weeklyWindowMs: 7 * 24 * 3600_000,
    modelWeights: CLAUDE_MODEL_WEIGHTS,
    defaultWeight: 1.0,
  },

  "gemini-free": {
    label: "Gemini Free", upstream: "gemini",
    credits: 100, windowMs: 24 * 3600_000,
    modelWeights: {}, defaultWeight: 1.0,
  },
  "gemini-standard": {
    label: "Gemini Advanced", upstream: "gemini",
    credits: 1000, windowMs: 24 * 3600_000,
    modelWeights: {}, defaultWeight: 1.0,
  },
  "gemini-paid": {
    label: "Gemini Paid", upstream: "gemini",
    credits: 2000, windowMs: 24 * 3600_000,
    modelWeights: {}, defaultWeight: 1.0,
  },

  "custom": {
    label: "自定义", upstream: "any",
    credits: 0, windowMs: 3600_000,
    modelWeights: {}, defaultWeight: 1.0,
  },
} as const;

export type SubscriptionTier = keyof typeof SUBSCRIPTION_PRESETS;
```

**关键概念（写进 seller onboarding 的说明文字）**：

> 你的订阅额度按 **credit** 计量，不是"消息数"：
>   - 用 Claude **Opus** 跑一条复杂对话 ≈ 5 credit
>   - 用 **Sonnet** 跑一条普通对话 ≈ 1 credit
>   - 用 **Haiku** 跑一条 ≈ 0.15 credit
>   - 带长 context / 附件的消息会吃更多 credit
> AIMM 会根据你已花的 credit 动态涨价，避免把你的订阅打爆。Claude 账号我们直接读官方响应头拿到精确剩余量，ChatGPT/Gemini 是本地估算。

**2. Codex prober（本地 JWT 解码，无网络）**

```typescript
// packages/provider-gateway/src/tier-prober/codex.ts
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function probeCodex(authFilePath?: string): Promise<ProbeResult> {
  const path = authFilePath ?? join(homedir(), '.codex', 'auth.json');
  let auth: any;
  try {
    auth = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { ok: false, reason: 'auth_file_missing' };
  }
  const idToken: string | undefined = auth?.tokens?.id_token;
  if (!idToken) return { ok: false, reason: 'no_id_token' };
  const [, payloadB64] = idToken.split('.');
  if (!payloadB64) return { ok: false, reason: 'malformed_jwt' };
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  const planType: string | undefined = payload?.['https://api.openai.com/auth']?.chatgpt_plan_type;
  if (!planType) return { ok: false, reason: 'plan_type_missing' };  // 已知 codex#13007
  const tier = (`chatgpt-${planType}` as SubscriptionTier);
  if (!(tier in SUBSCRIPTION_PRESETS)) return { ok: false, reason: `unknown_plan:${planType}` };
  return { ok: true, tier, evidence: { planType, source: 'jwt' } };
}
```

**3. Claude prober（1-token ping + header 分档）**

```typescript
// packages/provider-gateway/src/tier-prober/claude.ts
export async function probeClaude(cliproxyUrl: string, authIndex: string): Promise<ProbeResult> {
  // 通过 CLIProxyAPI 走一个最小请求；注意：这要消耗 1 次配额
  const res = await fetch(`${cliproxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cliproxy-auth-index': authIndex },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
  }).catch(() => null);
  if (!res || !res.ok) return { ok: false, reason: 'ping_failed' };

  const unifiedLimit = res.headers.get('anthropic-ratelimit-unified-tokens-limit');
  const reqLimit = res.headers.get('anthropic-ratelimit-requests-limit');

  if (unifiedLimit) {
    const n = +unifiedLimit;
    // 分档阈值（需根据真实观测微调，写死容易偏）
    const tier: SubscriptionTier =
      n >= 800_000 ? 'claude-max-20x' :
      n >= 200_000 ? 'claude-max-5x'  :
                      'claude-pro';
    return { ok: true, tier, evidence: { unifiedLimit: n, source: 'header' } };
  }
  if (reqLimit) {
    return { ok: true, tier: 'claude-pro', evidence: { reqLimit: +reqLimit, source: 'header' } };
  }
  return { ok: false, reason: 'no_ratelimit_header' };
}
```

**4. Gemini prober（loadCodeAssist）**

```typescript
// packages/provider-gateway/src/tier-prober/gemini.ts
export async function probeGemini(): Promise<ProbeResult> {
  const credsPath = join(homedir(), '.gemini', 'oauth_creds.json');
  let creds: any;
  try { creds = JSON.parse(await readFile(credsPath, 'utf8')); }
  catch { return { ok: false, reason: 'creds_missing' }; }
  const token = creds?.access_token;
  if (!token) return { ok: false, reason: 'no_access_token' };
  const res = await fetch('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  }).catch(() => null);
  if (!res || !res.ok) return { ok: false, reason: 'api_failed' };
  const data = await res.json();
  const userTier: string | undefined = data?.currentTier?.id ?? data?.allowedTiers?.[0]?.id;
  const map: Record<string, SubscriptionTier> = {
    'free-tier': 'gemini-free', 'standard-tier': 'gemini-standard', 'legacy-tier': 'gemini-paid',
  };
  const tier = userTier ? map[userTier] : undefined;
  if (!tier) return { ok: false, reason: `unknown_tier:${userTier}` };
  return { ok: true, tier, evidence: { userTier, source: 'loadCodeAssist' } };
}
```

**5. 入口 + 通用类型**

```typescript
// packages/provider-gateway/src/tier-prober/index.ts
export type ProbeResult =
  | { ok: true; tier: SubscriptionTier; evidence: Record<string, unknown> }
  | { ok: false; reason: string };

export async function probeAllAccounts(
  accounts: Array<{ authIndex: string; upstream: 'codex'|'claude'|'gemini'; authFile?: string }>,
  cliproxyUrl: string,
): Promise<Array<{ authIndex: string; result: ProbeResult }>> {
  return Promise.all(accounts.map(async (a) => {
    const result =
      a.upstream === 'codex'  ? await probeCodex(a.authFile) :
      a.upstream === 'claude' ? await probeClaude(cliproxyUrl, a.authIndex) :
      a.upstream === 'gemini' ? await probeGemini() :
      { ok: false as const, reason: 'unknown_upstream' };
    return { authIndex: a.authIndex, result };
  }));
}
```

#### Onboarding UX

探测成功路径（90% 用户）：

```
┌─ 正在检测已登录账号 ──────────────────────────────────────────┐
│                                                              │
│  ✓ ~/.codex/auth.json         → ChatGPT Plus                │
│                                  100 credit / 5h             │
│  ✓ claude-accountB-2026-04    → Claude Max 5×               │
│                                  225 credit / 5h (header 权威) │
│  ✓ ~/.gemini/oauth_creds.json → Gemini Advanced             │
│                                  1000 credit / day           │
│                                                              │
│  credit 是什么？ 以 Sonnet / GPT-5.4 为 1× 基准，Opus ≈ 5×   │
│  AIMM 会根据你已花 credit 动态涨价，防止订阅被打爆。          │
│                                                              │
│  [✓ 全部正确，下一步]   [c 修改某一项]                        │
└──────────────────────────────────────────────────────────────┘
```

探测失败路径（fallback，保留原手选 UI）：

```
┌─ 账号 codex-accountA 自动检测失败 ──────────────────────┐
│  原因: JWT 里没有 chatgpt_plan_type 字段                │
│  （这是 Codex 某些版本的已知 bug）                       │
│                                                        │
│  请手动选择订阅等级：                                     │
│  ● ChatGPT Plus      (100 credit / 5h)                 │
│  ○ ChatGPT Pro       (500 credit / 5h)                 │
│  ○ 自定义                                               │
└────────────────────────────────────────────────────────┘
```

#### 存储

```typescript
seller: {
  accounts: [
    {
      authIndex: "codex-accountA-2026-04",
      subscriptionTier: "chatgpt-plus",
      detection: { source: "auto", evidence: { planType: "plus" }, detectedAt: 1745000000000 },
    },
    {
      authIndex: "claude-accountB-2026-04",
      subscriptionTier: "claude-max-5x",
      detection: { source: "auto", evidence: { unifiedLimit: 250000 }, detectedAt: 1745000000000 },
    },
    {
      authIndex: "codex-accountC-2026-04",
      subscriptionTier: "chatgpt-pro",
      detection: { source: "manual", reason: "plan_type_missing" },
    },
  ]
}
```

#### 何时重新探测
- 每次启动 seller-runtime 时跑一遍，结果若与持久化配置不一致 → 弹窗提示用户确认（用户可能升级/降级了订阅）
- 用户在 Dashboard 主动点"重新检测"
- 收到 429 且与当前 tier 的预期配额不符时，自动触发（订阅被改了）

#### 验收
- [ ] `probeCodex` 对我本机的 `~/.codex/auth.json`（已知 `plus`）返回 `{ ok: true, tier: 'chatgpt-plus' }`
- [ ] `probeCodex` 对缺失 `chatgpt_plan_type` 的 JWT 返回 `{ ok: false, reason: 'plan_type_missing' }`
- [ ] `probeClaude` 在 unified header `limit=250000` 下返回 `claude-max-5x`
- [ ] `probeClaude` 在只有 requests header 下返回 `claude-pro`
- [ ] `probeClaude` 的 ping 请求**必须**被 `failed: false` 归档（消耗 1 次配额是已知代价）
- [ ] `probeGemini` 在缺失 `oauth_creds.json` 时返回 `creds_missing` 而不是崩溃
- [ ] `probeAllAccounts` 并发调 3 家，任一家超时不影响其他
- [ ] Onboarding 能区分 `detection.source: 'auto' | 'manual'` 并在 UI 上标示
- [ ] Seller Dashboard 显示每个账号的独立 u 值 + 检测来源（auto/manual）

---

### T10. 集成测试 + 端到端演示

#### 目标
本地拉起 1 个 Buyer + 3 个 Maker（不同 p₀/α），演示完整 AIMM 流程。

#### 产出
- `scripts/demo-aimm.mjs`：一键启动 3 Maker + 1 Buyer 的脚本
- `scripts/test-cuc-simulation.mjs`：注入负载观察价格和路由分布

#### 演示脚本应输出
```
[Maker-A] Broadcasting: p0=$2, α=1.0, u=0.0 → current $2.00
[Maker-B] Broadcasting: p0=$2.5, α=0.8, u=0.0 → current $2.50
[Maker-C] Broadcasting: p0=$1.8, α=1.5, u=0.3 → current $2.31

[Buyer] Cache: 3 quotes active for claude-sonnet
[Buyer] Softmax pick → Maker-A (price $2.00)
[Buyer] Request sent, stream response in 245ms
[Maker-A] Utilization 0.0 → 0.2, next broadcast will price at $2.50

[Buyer] 2nd request → Softmax pick → Maker-C (now cheapest)
...
```

#### 验收
- [ ] 3 Maker 价格不同，Buyer 路由分布近似 softmax 概率
- [ ] 某 Maker 负载上升后，后续请求倾向于别家
- [ ] 手动杀一个 Maker，Buyer 自动 fallback

---

## 4. 测试策略

### 单元测试覆盖率目标
- `cucPrice()`：100%
- `softmaxSample()`：覆盖空/单项/多项/边界
- `LocalQuoteCache`：插入/过期/GC/并发
- `signQuote` + `verifyQuote`：正常 + 篡改失败

### 集成测试
- 2 个进程（Maker + Buyer）端到端
- 断网恢复
- Quote TTL 边界

### 压测
- 10 个 Maker × 100 Buyer × 1000 req/s 仿真
- 验证价格收敛、路由分布、无崩溃

---

## 5. 合并顺序

严格按这个顺序开 PR，每个合并后再开下一个：

```
T3 (types) ─┬─▶ T2 (CUC pricing) ─▶ T1 (utilization) ─▶ T4 (broadcaster) ──┐
            └─▶ T5 (cache)      ─▶ T6 (subscriber)                          │
                                                                            ├─▶ T11 (reject-with-quote) ──┐
                                                        T7 (softmax) ───────┤                             │
                                                        T12 (event broadcast)┤                            ├─▶ T10 (demo)
                                                        T8 (receipt) ────────┤                            │
                                                        T9 (CLI config) ─────┘                            │
                                                                                                          │
```

**三道防线一起上才算完工**：T7 Softmax（概率稀释） + T11 Reject-with-Quote（同步反馈） + T12 事件广播（加速预防）。

**原因**：
- T3 是类型底座，其他都依赖它
- T1/T2 是 Maker 侧定价，先通
- T4 能发出 Quote 后 T5/T6 才有东西接
- T7-T9 可并行
- T10 收尾验证

---

## 6. 不做什么（明确排除）

这些是 V2/V3 范畴，**V1 不做**：

- ❌ 链上 Reputation commit（链下 reputation 已够用）
- ❌ EWMA 平滑 u（量小不触发震荡）
- ❌ 冷启动坡道（V1 Maker 数少，手动管理）
- ❌ 反作弊（自成交检测等）
- ❌ α 自适应算法
- ❌ 批量拍卖窗口（CowSwap 风格，V2 再做）
- ❌ 跨模型套利通道

**原则**：V1 只做"让 AIMM 名字能站住"的最小集。

---

## 7. 文档同步

PR 合并后同步更新：

- [x] `docs/aimm/engineering-spec.md` 里对应任务状态改为 ✅
- [x] `docs/aimm/primer.md` 的"三阶段路线图"部分同步 V1 进度
- [x] `packages/cli` 的 README 增加 AIMM 相关 CLI 参数
- [x] 根 README 增加 `docs/aimm/` 的索引

---

## 8. 提问反馈

实施中遇到以下情况停下来讨论，**不要自己拍板**：

1. **签名规范化 JSON** 用哪个库（json-stable-stringify / safe-stable-stringify / 手写）
2. **GossipSub topic naming** 要不要加 network id 前缀（testnet / mainnet）
3. **Quote 广播频率** 10s 是否过密（可能上升到 30s）
4. **Softmax β** 默认 3.0 是否合适（可能需要根据实际测试调整）
5. **向后兼容** 老的 `ProviderAnnouncement` 什么时候废弃

---

## 9. 上线前必须处理的工程 Gotcha（主动清单）

> 这一节是"用户没问但上线会死"的边界。每条都是从"V1 第一次被真实用户跑"推演出来的。分两层：
>   - **P0 — 必须在公开 beta 前修**（变成 T15-T20 正式任务）
>   - **P1 — 首批付费用户来之前修**（列清单，下一轮 sprint 拆）
>   - **P2 — 有余力再做**（仅记录，避免被遗忘）

### P0：新增任务 T15–T20

---

### T15 [P0] 订阅额度耗尽（429 / quota exhausted）的容错路径

**背景**：CLIProxyAPI 上游（Claude / ChatGPT / Gemini）任意时刻可能返回 429 或等效的 quota 错误。若不处理：
1. Buyer 拿到的 Receipt 无法被 upstream 兑现 → Maker 既损失 quota 又没拿到钱
2. Maker 继续广播低价 Quote → 引发新 Buyer 持续撞墙 → 声誉崩塌

**文件**：
- `packages/provider-gateway/src/quota/CoolingManager.ts`（新）
- `packages/provider-gateway/src/upstream/CliproxyClient.ts`（改：响应拦截器）
- `packages/cli/src/runtime/quota/QuotaWindowTracker.ts`（集成）

**代码骨架**：
```ts
export class CoolingManager {
  private cooling = new Map<string, { until: number; reason: string }>();

  tripAccount(accountId: string, retryAfterSec: number, reason: string) {
    const until = Date.now() + retryAfterSec * 1000;
    this.cooling.set(accountId, { until, reason });
    // 1) 立即把 u_window 拉到 1.0（停止接单）
    utilTracker.forceUtilization(accountId, 1.0);
    // 2) 广播下线 Quote（p₀ = +∞ 或发 revoke）
    broadcaster.revokeAccount(accountId);
    logger.warn({ accountId, retryAfterSec, reason }, 'account cooled');
  }

  isAvailable(accountId: string): boolean {
    const entry = this.cooling.get(accountId);
    if (!entry) return true;
    if (Date.now() >= entry.until) {
      this.cooling.delete(accountId);
      return true;
    }
    return false;
  }
}
```

**响应拦截**：CliproxyClient 对 429 / 402 / specific upstream 错误码，调用 `coolingManager.tripAccount(accountId, parseRetryAfter(res) ?? 300, res.statusText)`。

**与 T8 Receipt 的互动**：若请求发起时 account 还没 cooled，中途 upstream 429 → Maker 必须返回 `ErrorResponse { code: 'UPSTREAM_QUOTA', retryAfter }`，Buyer 侧**不扣 escrow**、**不计入信誉**，仅加 backoff。

**验收**：mock upstream 第 11 次返回 429 → account 立即 cooled、广播 revoke、Buyer 在 1 个 RTT 内收到新 Quote 集合且该账户消失。

---

### T16 [P0] Quote 反重放 + 请求幂等键

**背景**：
1. GossipSub 会重复投递（fanout + mesh），同一 Quote 可能被本地收到 2-3 次
2. 恶意 Maker 可能在 TTL 内回放同一份 Quote 多次人为"抬高"自己在缓存里的权重
3. 同一 QuoteRequest 因重传被 Maker 执行两次 → Buyer 被双扣

**改动**：
- `QuoteMessage` 增加 `nonce: string`（16 字节 hex），Broadcaster 每次广播递增
- `LocalQuoteCache` 存 `(makerId, model) -> {quote, seenNonces: LRU(32)}`，nonce 重复直接丢
- `QuoteRequest` 增加 `requestId: ulid()`，Maker 维护 `SeenRequestSet` TTL=60s 去重

```ts
// packages/p2p-node/src/cache/LocalQuoteCache.ts
accept(msg: QuoteMessage): 'new' | 'update' | 'duplicate' | 'stale' {
  const key = `${msg.makerId}:${msg.model}`;
  const entry = this.store.get(key);
  if (entry && entry.seenNonces.has(msg.nonce)) return 'duplicate';
  if (entry && msg.ts < entry.quote.ts) return 'stale';  // 旧消息
  // ...
}
```

**验收**：重放同一 QuoteMessage 10 次，cache 中只有 1 份；重放 QuoteRequest 2 次，Maker 只扣一次 upstream quota。

---

### T17 [P0] 时钟偏移容忍

**背景**：Maker 和 Buyer 节点时钟可能差 ±分钟级（尤其家用机 / NAS 用户）。现状：
- TTL 检查用 `Date.now() - quote.ts > 10_000` → 时钟快的节点会把所有远端 Quote 当过期
- Receipt 时间戳用于 escrow 争议窗口 → 时钟偏移导致正常 receipt 被链上判为逾期

**方案**：
1. **NTP 启动检查**：节点启动时 `ntp.pool` 对齐，若偏移 > 30s **警告 + 记录 skew**，偏移 > 5min **拒绝启动**
2. **容忍窗口**：TTL 判定改成 `age > ttl + GRACE (2s)`；"未来时间戳"只要 `quote.ts - now < GRACE` 就接受
3. **Receipt 时间戳**：由 Buyer-Maker 双签时各写一个 ts，争议仲裁取较早者

```ts
// packages/p2p-node/src/time/ClockGuard.ts
export async function checkClockSkew(): Promise<number> {
  const ntpTime = await ntpClient.getTime('pool.ntp.org');
  const skew = Math.abs(ntpTime - Date.now());
  if (skew > 300_000) throw new Error(`clock skew ${skew}ms exceeds 5min, refuse to start`);
  if (skew > 30_000) logger.warn({ skewMs: skew }, 'clock skew > 30s');
  return skew;
}
```

**验收**：人为把本机时钟拨快 20s 启动 → 启动成功但发出 skew 警告，远端 Quote 仍可接收。

---

### T18 [P0] 熔断器：持续 u=0.99 的 Maker 自动下线

**背景**：CUC 在 u→1 时价格发散。若某 Maker 持续 u=0.99（例如后台有别的进程偷偷用订阅），会：
- 以天价报单 → 概率路由仍有小概率命中 → Buyer 体验崩
- 占据 cache 槽位
- 极端情况 u=0.999 时 cucPrice 返回几百上千美元，可能触发 Buyer 侧精度/显示 bug

**方案**：Maker 本地熔断
```ts
// packages/cli/src/runtime/CircuitBreaker.ts
class CircuitBreaker {
  private highUtilStart?: number;

  tick(u: number) {
    if (u >= 0.95) {
      this.highUtilStart ??= Date.now();
      if (Date.now() - this.highUtilStart > 60_000) {  // 持续 1min
        broadcaster.revokeAccount(this.accountId);
        logger.warn('account auto-revoked: sustained u>=0.95');
      }
    } else {
      this.highUtilStart = undefined;
    }
  }
}
```

Buyer 侧：`cucPrice` 结果 > `p₀ × 50` 直接把该 Maker 从候选里踢掉（不参与 softmax）。

**验收**：mock Maker u 稳定 0.97 持续 65s → 自动广播 revoke，本地停止接单。

---

### T19 [P0] 密钥分离与轮换

**背景**：目前存在的密钥至少 3 把，不能混用：
1. **libp2p peerId 身份钥** — 长期，暴露 = Sybil 漏洞
2. **Quote/Receipt 签名钥** — 中期，热在内存，可轮换
3. **链上结算钱包钥** — 最敏感，不应热存

**现状**：primer/architecture 都模糊带过，真开发会把三把合一（直接用 wallet 私钥签 quote）。**这是灾难性的**——一次 quote 广播解析漏洞 = 钱包被盗。

**方案**：
- `~/.clawmarket/keys/` 目录分三文件：`peer.key`、`signing.key`、`wallet.key.enc`（钱包钥 AES 加密，启动输入密码）
- `signing.key` 每 7 天自动轮换，旧 pubkey 在 cache 里保留 1 天用于验证历史 receipt
- `QuoteMessage.signerPubkey` 字段公开，链上兑现时带一张"signing key → wallet"的委托签名（wallet 签一次 "I authorize signing key X until T"）

**代码**：
```ts
// packages/p2p-node/src/identity/KeyManager.ts
export class KeyManager {
  readonly peerKey: Ed25519PrivateKey;       // libp2p
  readonly signingKey: Ed25519PrivateKey;    // quote/receipt
  readonly walletAddress: Address;           // 链上地址（私钥在冷存储，需要结算时 prompt）
  readonly delegation: SignedDelegation;     // wallet 签过的"signingKey 在 T 前有效"

  async rotateSigningKey() { /* 生成新 signing key + 请求 wallet 签新 delegation */ }
}
```

**验收**：signing.key 文件被删 → 节点拒绝启动并给出明确恢复指引；signing key 过期 → 自动发起轮换流程。

---

### T20 [P0] 最小可观测性：结构化日志 + 核心指标

**背景**：用户报 bug 时我们必须能远程诊断。V1 不做 Prometheus stack，但必须有：

1. **结构化日志**（pino 已在用）：所有 quote/request/receipt 事件带 `traceId = requestId`
2. **本地 metrics 端口**：`GET http://127.0.0.1:<port>/metrics`（纯文本 Prometheus 格式）
3. **`clawmarket doctor`**：一行命令打印节点健康摘要

**关键指标**：
```
aimm_quotes_broadcast_total
aimm_quotes_received_total{from_self="false"}
aimm_quote_cache_size
aimm_requests_inbound_total{result="ok|reject|error"}
aimm_requests_outbound_total{result="ok|rejected|timeout"}
aimm_utilization{account_id,layer="concurrent|window"}
aimm_clock_skew_ms
aimm_cooling_accounts
aimm_circuit_open_accounts
```

**验收**：Maker 启动 5min 后 `curl localhost:9100/metrics` 至少能看到 quote 数、u 值、cache 大小三项。

---

### P1：下一 sprint 拆任务的风险清单

| # | 风险 | 触发条件 | 临时缓解 |
|---|---|---|---|
| R1 | **Dust 问题**：单笔 Receipt < gas 的 10× | p₀ 设得过低 + 请求 tokens 少 | Maker 本地 `minBillable = 0.001 USDC`，小单直接免费但不入 escrow |
| R2 | **Buyer 中途 USDC 耗尽** | 预授权 escrow 不够 | 请求前必须 `quote.price × maxTokens ≤ allowance`，不够直接拒 |
| R3 | **Receipt token count 争议** | Maker 报 1000 tokens, Buyer 实收 800 tokens | 用上游返回的 `usage.total_tokens` 作为权威源，双方都存原始响应 hash |
| R4 | **EscrowPool 批量 claim gas 分摊** | 单次 claim 100 条 receipt，gas 不平均 | Maker 先垫付，按 receipt 金额比例从各 receipt 中抠 0.5% |
| R5 | **新 Maker 无声誉冷启动** | 首次上线 reputation=0 → 永远不被 softmax 选中 | 新身份获 7 天"保护期" bonus score + 限 max capacity |
| R6 | **Reputation 陈旧** | 3 个月前的一次宕机一直拉低分数 | 指数衰减 `score = Σ event × e^(-Δt/30d)` |
| R7 | **Provider-gateway crash 检测** | CLIProxyAPI 进程死了但 seller-runtime 还在报价 | seller-runtime 每 5s 健康检查，失败立即 revoke + alert |
| R8 | **Bootstrap 节点单点** | 我们自己跑的 2 个 bootstrap 都挂了 | 硬编码 5+ 个；支持 DNS TXT 动态发现 `_bootstrap.aimm.network` |
| R9 | **Sybil 压低对手报价** | 攻击者跑 100 个假 Maker 广播 p=0.01 | cache 侧对同 IP/ASN 做降权；softmax 前按 `sqrt(reputation)` 加权 |
| R10 | **协议版本协商** | V1.1 新增字段，V1.0 节点无法解析 | `QuoteMessage.schemaVersion` 已留，Subscriber 对未知版本**忽略而非崩溃** |
| R11 | **测试不可复现** | 涉及网络 + 时间 + 随机 | 引入 `TimeProvider` / `RandProvider` 抽象，测试注入 fake；端到端用 testcontainers 开 3 节点 |
| R12 | **Receipt 争议窗口** | Buyer 指控 Maker 没提供服务 | EscrowPool 合约留 24h challenge 窗口，Buyer 可提交反证（链下签名的拒收回执） |

### P2：记录但暂不处理

- 跨模型套利（Claude→GPT 回退）
- 链上 reputation commit
- α 自适应
- 批量拍卖（CoW 风格）
- 零知识证明容量真实性
- 多语言 SDK

---

## 10. 风险到任务的映射（别漏）

开发同事在开 T10 Demo PR 之前，确认以下问题各自有明确答案：

- [ ] 429 发生时谁来 revoke？→ T15
- [ ] Quote 重复投递会不会让一个 Maker 看起来有多份报价？→ T16
- [ ] 树莓派家用机时钟错了会怎样？→ T17
- [ ] u 永远卡在 0.98 的 Maker 为什么还在接单？→ T18
- [ ] signing key 泄露会不会顺带丢钱包？→ T19
- [ ] 用户报"收不到 quote"时我们怎么查？→ T20
- [ ] 0.0001 USDC 的小单怎么处理？→ R1
- [ ] 新 Maker 怎么被选中？→ R5
- [ ] Bootstrap 挂了怎么办？→ R8

**每个问题都必须在 PR 描述里给链接**，否则不合并。

---

## 11. 测试

测试策略与 T21-T25 任务详情已经拆分到独立文档 **[`test-plan.md`](./test-plan.md)**。

包含：
- 五层测试金字塔（L1 单元 → L5 24h 混沌）
- T21 TestKit 基础设施
- T22 单元 + 组件集成 + 哨兵测试 S1-S7
- T23 **对照实验 A-F**（机制有效性证明，尤其实验 C 封号保护）
- T24 真账号 E2E smoke
- T25 24h 混沌长跑
- 上线 gate 总清单

测试同事直接对着 `test-plan.md` 工作。

---

*文档版本：v0.6 · 2026-04-23*
*变更：T21-T25 测试内容抽离到 test-plan.md*
*v0.5 变更：新增 §11 测试与上线 Gate（T21-T25）+ §12 Gate 总清单（已迁移）*
*v0.4 变更：u_concurrent 退出 CUC；T13 改 credit 计量 + 5h/周双窗口；T14 预设表全部改 credit*
*联系人：@你的名字*

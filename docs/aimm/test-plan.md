# AIMM 测试与验证计划

> 这份文档是独立的**测试工作清单**，给负责测试/QA 的同事看。开发文档是 `engineering-spec.md`（T1-T20 功能实现），这份是 T21-T25（验证机制是否真的有效 + 上线 gate）。
>
> **核心问题**：代码跑通不等于机制有效。AIMM 对外承诺"动态定价防封号 + 防羊群 + 无中心调度也能分散流量"——这三件事必须用**对照实验**证明，不然上线就是假的。

*文档版本：v0.1 · 2026-04-23*

---

## 1. 测试金字塔

五层，从下往上是严格的上线 gate——**任一层不过，不得进下一层**。

```
                  ┌──────────────────────────┐
                  │ L5  24h 混沌长跑 (T25)    │  ← Mainnet gate
                  ├──────────────────────────┤
                  │ L4  真账号 E2E (T24)      │  ← Mainnet gate
                  ├──────────────────────────┤
                  │ L3  机制对照实验 (T23)    │  ← Beta gate ⭐
                  ├──────────────────────────┤
                  │ L2  组件集成 (T22)        │
                  ├──────────────────────────┤
                  │ L1  单元测试 (T22)        │
                  └──────────────────────────┘
                        ↑ 基础设施
                  ┌──────────────────────────┐
                  │    TestKit (T21)          │
                  └──────────────────────────┘
```

| 层 | 目的 | 回答的问题 |
|---|---|---|
| L1 | 单元 | 每个函数/类自己对吗 |
| L2 | 组件集成 | 组件拼起来不撞吗 |
| L3 | **机制对照** | **AIMM 机制真的比没有 AIMM 好吗** |
| L4 | 真账号 E2E | 真钱 + 真上游能跑通吗 |
| L5 | 混沌长跑 | 24h 不崩、不错账吗 |

---

## 2. T21. AIMM TestKit（测试基础设施，必须先做）

### 为什么需要
后续 T22-T25 都要"可控时钟 + mock 上游 + mock 网络 + 批量起 Maker/Buyer"。手搓会重复五遍，不如先封装。

### 文件
新包：`packages/aimm-testkit/`

```
packages/aimm-testkit/
├── src/
│   ├── MockUpstream.ts          # 模拟 Claude/Codex（可控 latency/429/token）
│   ├── MockCliproxy.ts          # 模拟 /v0/management/usage + header 注入
│   ├── TimeProvider.ts          # 假时钟（秒级跑完 5h 虚拟时间）
│   ├── RandProvider.ts          # 固定种子随机（softmax 可复现）
│   ├── InMemoryGossip.ts        # 替代 libp2p，EventEmitter 广播
│   ├── Harness.ts               # N Maker + M Buyer 一键起
│   └── Metrics.ts               # 采集 price/u/hit count/gini 曲线
└── scenarios/                   # T23 实验脚本落这
```

### 关键 API

```typescript
// packages/aimm-testkit/src/Harness.ts
export class Harness {
  constructor(opts: {
    makers: Array<MakerConfig>;    // p0, α, credits, modelWeights, tier
    buyers: Array<BuyerConfig>;    // 请求速率、model、payload 分布
    routing: 'greedy' | 'softmax';
    beta?: number;
    time: TimeProvider;
    gossip: InMemoryGossip;
    upstream: MockUpstream;
  });

  async run(durationVirtualMs: number): Promise<RunResult>;
}

export interface RunResult {
  priceTimeline: Array<{ t: number; makerId: string; price: number; u: number }>;
  routingHits: Record<string, number>;
  receipts: Array<Receipt>;
  upstream429Count: number;
  rejectWithQuoteCount: number;
}
```

### 验收
- [ ] 假时钟把 5h 虚拟时间在 < 1 秒内跑完
- [ ] MockUpstream 能返回指定 token 数 + 指定 header + 按容量自动 429
- [ ] Harness 起 10 Maker × 100 Buyer 启动 < 500ms
- [ ] **同 seed 跑两次 bit-for-bit 一致**（可复现是必需的，否则对照实验不成立）

---

## 3. T22. L1 单元 + L2 组件集成测试

### 覆盖率
- 整包 statement coverage **≥ 80%**
- Critical path（定价 / 路由 / 签名 / credit 计算）**≥ 95%**

### 必须有的哨兵测试

挂了这些 = 整个机制是假的。每条都要在代码库里 grep 得到。

**S1 — 定价公式：**
```typescript
test('cucPrice matches formula exactly', () => {
  expect(cucPrice(2.0, 0.5, 1.0)).toBeCloseTo(4.0, 4);
  expect(cucPrice(2.0, 0.9, 1.0)).toBeCloseTo(20.0, 4);
  expect(cucPrice(2.0, 0.0, 1.5)).toBeCloseTo(2.0, 4);
});
```

**S2 — credit 模型权重：**
```typescript
test('Opus burns 5x credits of Sonnet for same tokens', () => {
  const opus = creditsFor({ model: 'claude-opus-4', totalTokens: 1000 });
  const sonnet = creditsFor({ model: 'claude-sonnet-4', totalTokens: 1000 });
  expect(opus / sonnet).toBeCloseTo(5.0, 2);
});
```

**S3 — header 权威性：**
```typescript
test('fresh header overrides local credit window', () => {
  tracker.ingestHeader({
    authIndex: 'A', tokensLimit: 100000, tokensRemaining: 10000, observedAt: Date.now()
  });
  expect(tracker.accountU(quota)).toBeCloseTo(0.9, 2);
});
```

**S4 — 反重放（T16）：**
```typescript
test('duplicate nonce is rejected', () => {
  const msg = signQuote(...);
  expect(cache.accept(msg)).toBe('new');
  expect(cache.accept(msg)).toBe('duplicate');
});
```

**S5 — 双窗口：**
```typescript
test('weekly window dominates when 5h is low but weekly is saturated', () => {
  // 注入：5h 内花了 10 credit (低)，过去 7 天累计 300 credit (满)
  expect(tracker.accountU(quota)).toBeGreaterThan(0.8);
});
```

**S6 — 时钟偏移容忍（T17）：**
```typescript
test('clock skew within grace window does not reject quotes', () => {
  // 本地时钟比对端快 2 秒，GRACE=2s，quote 应接受
});
```

**S7 — 熔断（T18）：**
```typescript
test('sustained u>=0.95 for 60s triggers account revoke', async () => {
  tracker.setU(0.97);
  await vm.advance(65_000);
  expect(broadcaster.revokedAccounts).toContain('A');
});
```

### 文件
- 每个组件旁边 `*.test.ts`
- 整合 smoke：`packages/aimm-testkit/scenarios/smoke.test.ts`

### 验收
- [ ] `pnpm test` 全绿
- [ ] coverage 报告上传 CI
- [ ] 上述哨兵 S1-S7 每条独立文件，grep 能找到

---

## 4. T23. L3 机制有效性对照实验 ⭐ 最重要

> **这是白皮书和官网能用的唯一证据**。每个实验都是 `baseline`（关 AIMM，固定价 + greedy）vs `aimm`（全开）的 A/B 对照。

### 文件
```
packages/aimm-testkit/scenarios/
├── exp-A-cuc-curve.ts
├── exp-B-herd-dispersion.ts
├── exp-C-ban-protection.ts      ⭐ 白皮书核心图
├── exp-D-thundering-herd.ts
├── exp-E-price-discovery.ts
└── exp-F-model-weight.ts

scripts/run-experiments.mjs    # 一键跑全部 + 生成 report/
```

每个实验必须产出：
- `report/exp-X.json` — 原始数据
- `report/exp-X.png` — 对照图
- `report/exp-X.md` — 人读摘要 + **PASS/FAIL**

---

### 实验 A：CUC 曲线数值正确性

- **设置**：1 Maker（p₀=2, α=1, credits=100），buyer 逐步注入让 u: 0 → 0.95
- **输出**：实测 price(u) 曲线 + 理论 `2/(1-u)` 曲线叠图
- **通过**：两曲线最大偏差 < 1%
- **失败含义**：CUC 实现错了，白皮书公式不成立

---

### 实验 B：反羊群流量分散度

- **设置**：3 Maker 同 p₀ / 同 α / 初始 u=0，100 buyer 各发 100 请求（共 10000）
- **对比矩阵**：

  | Routing | 预期 Gini | 预期 max_u |
  |---|---|---|
  | greedy | > 0.7 | → 1.0（崩） |
  | softmax β=1 | 0.3-0.5 | < 0.8 |
  | softmax β=3 | < 0.2 | < 0.7 |
  | softmax β=5 | < 0.15 | 但可能过度分散 |

- **输出**：柱状图（各 Maker hit count）+ 时间序列（u over time）
- **通过**：softmax β=3 下 Gini < 0.2 且无 Maker 打满

---

### 实验 C：封号保护 ⭐⭐⭐

这是对外讲故事最有力的一张图。**AIMM 的核心卖点能不能兑现，靠这张图。**

- **设置**：1 Maker（Claude Pro, credits=45, weights={opus:5, sonnet:1}），1 Buyer 以远超容量的速率持续请求 Sonnet
- **观察窗口**：1 虚拟小时
- **对比**：

  | 指标 | Baseline（固定 $2 + greedy） | AIMM |
  |---|---|---|
  | upstream 429 次数 | 预期 > 0 | **必须 = 0** |
  | 峰值 u | → 1.0 | < 0.95 |
  | 1h 内完成请求数 | ~45（然后归零） | ~42（可持续） |
  | Buyer 最终失败率 | 某时点后 100% | 稳定 < 10% |

- **通过**：AIMM 组**全程 0 次 429 且 u < 0.98**
- **失败含义**：AIMM 没兜住配额，上线必封号，整个项目核心价值崩塌

---

### 实验 D：惊群压力

- **设置**：5 Maker，M1 p₀ 明显最低。t=0 瞬间 50 buyer 同时发请求
- **对比**：
  - **Baseline**：所有 50 砸 M1，inFlight 瞬时 50
  - **AIMM 全开**：
    - T11 Reject-with-Quote 软拒超并发
    - T12 事件广播 1s 内让所有 buyer 看到 M1 新 quote
    - T7 Softmax 后续分散到 M2-M5
- **指标**：
  - M1 inFlight 峰值 ≤ `maxConcurrent` + 少量 overshoot
  - 系统收敛时间（全部 50 buyer 拿到 receipt）< 5 秒
  - Reject-with-Quote 触发次数 > 0
- **通过**：收敛 < 5s 且 M1 inFlight 峰值 < 2 × maxConcurrent

---

### 实验 E：市场价格发现

- **设置**：3 Maker 不同 p₀（$1.5 / $2.0 / $3.0），但 $1.5 那家 credits 最少
- **跑 1000 请求**，在第 [0, 200, 500, 1000] 条采样
- **预期**：
  - 前 200 条主要进便宜家
  - 便宜家 u 上升后有效价追平中档
  - 第 500 条后三家都有流量
- **通过**：第 500 条之后每家命中数 > 10%（无 starvation）

---

### 实验 F：模型权重正确性

- **设置**：1 Maker（Claude Pro, credits=45）
- **阶段 1**：跑 9 次 Opus（各 1000 tokens）→ 预期 u ≈ 1.0（9×5=45）
- **阶段 2**：重置，跑 9 次 Sonnet（各 1000 tokens）→ 预期 u ≈ 0.2（9×1=9）
- **通过**：两阶段 u 值与理论偏差 < 5%
- **失败含义**：modelWeights 或 creditsFor 实现错了，Opus 重度用户会被封号

---

**T23 不通过不得进 Beta。**

---

## 5. T24. L4 真账号 E2E Smoke

### 设置
- 机器 A：seller-runtime + 真 CLIProxyAPI + **专用测试 Claude Pro 账号**（不用主号）
- 机器 B：buyer-runtime + libp2p
- Base Sepolia 测试网

### 步骤
1. 机器 A 启动，验证 tier 被自动探测为 `claude-pro` + credits=45
2. 机器 B 通过 libp2p 发现 A，收到 QuoteMessage，签名验证通过
3. 发 5 条真实 Sonnet 请求，每条 ~500 tokens
4. 核对：
   - [ ] 响应内容有效（不乱码、长度合理）
   - [ ] `anthropic-ratelimit-unified-*` header 被 QuotaWindowTracker 吃进
   - [ ] 链上 escrow 扣款金额 = quote × tokens
   - [ ] Receipt 链上兑现成功
5. 人为灌 10 次 Opus 把账号打到 u > 0.9，观察：
   - [ ] 价格按 CUC 上涨
   - [ ] 灌到 u > 0.95 → T18 熔断生效，Maker 自动 revoke
6. 恢复观察：5h 后 u 重置，账号自动 re-advertise

### 通过标准
每条 checkbox 必过。**任一项失败禁止上 mainnet。**

---

## 6. T25. L5 24h 混沌长跑

### 设置
- 5 Maker + 20 Buyer（全部 mock 上游，不烧真 quota）
- 持续 24 小时
- 后台每 30 分钟随机注入一种混沌：
  - `kill -9` 一个 Maker 进程
  - iptables drop 一个节点 P2P 流量 30s
  - 本机时钟跳 +60s / -60s
  - MockCliproxy 假死 2 分钟
  - MockUpstream 5xx 雨 1 分钟

### 监控
全程采集 T20 定义的 metrics：
- `aimm_quotes_broadcast_total` 稳定递增
- `aimm_cooling_accounts` 峰值不超过混沌事件触发数
- 无 OOM、无卡死、无账号被 ban、链上无资金错账

### 通过标准
- [ ] 24h 零崩溃
- [ ] 所有注入事件在 60s 内自恢复
- [ ] 最终 receipts 链上总额 = buyers 链下累计支付 **±0.01%**（无错账）
- [ ] 无任何一次账号因软件 bug 被 429（真实上游限额不算）

---

## 7. 上线 Gate 总清单

严格顺序：

```
L1 单元 (T22)         → 覆盖率 ≥ 80%，哨兵 S1-S7 全绿
        ↓
L2 TestKit (T21)      → Harness + 同 seed 可复现
        ↓
L3 对照实验 (T23 A-F) → 每个 PASS，尤其 C 实验
        ↓
   ═════ Beta 对小圈子开放 ═════
        ↓
L4 E2E 真账号 (T24)   → 全部 checkbox 通过
        ↓
L5 24h 混沌 (T25)     → 零崩溃 + 零错账
        ↓
   ═════ Mainnet 公开发布 ═════
```

**任何一关失败都退回修复，不得跳级。**

---

## 8. 产出与交付

测试完成时，必须在仓库里留下：

```
report/
├── coverage/                    # L1 coverage 报告
├── exp-A-cuc-curve.{png,json,md}
├── exp-B-herd-dispersion.{png,json,md}
├── exp-C-ban-protection.{png,json,md}   ⭐ 放进 primer.md
├── exp-D-thundering-herd.{png,json,md}
├── exp-E-price-discovery.{png,json,md}
├── exp-F-model-weight.{png,json,md}
├── e2e-smoke-YYYYMMDD.md        # T24 checkbox 记录
└── chaos-24h-YYYYMMDD.md        # T25 指标截图 + 异常日志
```

**实验 C 的对照图** 直接放进 `primer.md` 的 "4.7 AIMM 的实证证据" 章节，以及未来的白皮书、Pinned Tweet、官网 hero 区——这是我们对"AIMM 是真的 work"唯一的可视化证据。

---

## 9. 提问反馈

测试中遇到以下情况停下来讨论，**不要自己拍板**：

1. 某实验通过阈值偏差（例如 Gini 卡在 0.21，阈值 < 0.2）—— 是调参还是判定失败
2. 发现 spec 里没定义的边界行为 —— 回头给 engineering-spec.md 开 issue
3. 混沌测试出现偶发性崩溃但无法稳定复现 —— 必须查清根因，不能当 flake 忽略
4. 真账号 E2E 里的扣款误差 —— 任何非 0 偏差都是严重问题

---

*联系人：@你的名字*

# 调度系统 Phase 0 + Phase 1 实施文档

> **目标读者**：负责编码实现的开发者 / AI 编码 agent（如 Codex）
> **前置文档**：`docs/design/scheduling-design.md`（架构设计）
> **本文档范围**：Phase 0（观测基础 + 安全机制 + Mock 测试平台）+ Phase 1（Hard Filter + Session 粘性 + Top-N 预选）

---

## 0. 实施总原则（务必遵守）

这是一个**去中心化 P2P 网络**，没有中心调度器。任何 bug 都会在所有 buyer 上同时发生。因此：

### 0.1 五条铁律

1. **新路径必须可关闭**：所有新代码路径都要能通过 feature flag 瞬间关闭，回退到现有逻辑
2. **Fail-safe 优先**：新代码中的任何异常，**必须** catch 住并回退到 legacy 路径，**绝不能**让用户请求因为新调度代码本身的 bug 而失败
3. **不改协议**：不修改 `ProviderAnnouncement`、`InferenceRequest` 等协议数据结构（Phase 1 不涉及）。协议层的向后兼容永远优先
4. **先观测后改动**：Phase 0 的观测必须先落地，Phase 1 才能开始。否则出问题无法排查
5. **不触碰支付/加密路径**：Phase 1 只改 "选哪个 seller"，不改 "选中之后怎么发送/签名/付款"。支付和 E2EE 代码保持原样

### 0.2 最小侵入原则

现有调用链：
```
local-server.handleChatCompletions
  → router.selectBest(model)         ← Phase 1 改这里
  → router.selectBestExcluding(...)  ← Phase 1 改这里
  → router.markFailed / markSuccess  ← Phase 1 增强
  → handleStreamResponse / handleNonStreamResponse  ← 完全不动
```

Phase 1 的所有改动集中在 `P2PRouter` 和新增的 `SessionStickyTable`、`SchedulerConfig`、`SchedulerLogger` 模块。`local-server.ts` 只做**最小修改**：读 session_id、传给 router、记录结果。

### 0.3 版本与兼容

- Buyer 升级后，**老 seller 无需任何改动**即可正常工作
- 同一网络中新老 buyer 共存时，彼此不受影响
- 本阶段不引入任何新的 P2P 协议消息

---

## 1. 代码变更总览

### 1.1 新增文件

```
packages/consumer-gateway/src/
  scheduler/
    config.ts                 # feature flag + 配置管理
    config.test.ts
    logger.ts                 # 结构化调度日志
    logger.test.ts
    session-sticky.ts         # 粘性表（LRU + TTL）
    session-sticky.test.ts
    session-key.ts            # session key 生成
    session-key.test.ts
    hard-filter.ts            # 硬约束过滤
    hard-filter.test.ts
    scheduler.ts              # 新调度器总入口（封装 Phase 1 逻辑）
    scheduler.test.ts
    admin-endpoint.ts         # /admin/scheduler/* 端点（观测+kill switch）
    admin-endpoint.test.ts

tools/mock-seller/            # Phase 0 测试平台
  src/
    mock-seller.ts            # 轻量级假 seller
    mock-seller.config.ts     # 行为脚本配置
    mock-cluster.ts           # 一次性启动 N 个 mock seller
    scenario-runner.ts        # chaos 场景运行器
    scenarios/
      baseline.ts
      seller-failover.ts
      load-spike.ts
      dht-stale.ts
  package.json
  README.md
```

### 1.2 修改文件

| 文件 | 改动性质 | 大致规模 |
|---|---|---|
| `packages/consumer-gateway/src/router.ts` | 增强：加 `selectTopN`、`markDegraded`，保留所有现有方法 | +80 行 |
| `packages/consumer-gateway/src/local-server.ts` | 最小改动：调用新 scheduler、传 session key、记录日志 | +50/-20 行 |
| `packages/consumer-gateway/src/index.ts` | 导出新模块 | +5 行 |
| `packages/shared/src/types/index.ts` | 增加 `SchedulerConfig` 类型 | +30 行 |

### 1.3 不改动的文件（重要）

- `packages/p2p-node/src/consumer-router.ts`：底层 DHT 路由逻辑**不动**
- `packages/consumer-gateway/src/wallet.ts`、`pool-manager.ts`：支付路径**不动**
- `packages/consumer-gateway/src/quality-monitor.ts`：质量监控**不动**（Phase 1 复用）
- `packages/provider-gateway/**`：seller 侧**完全不动**（Phase 3 才涉及）

---

## 2. Phase 0 — 观测基础 + 安全机制 + Mock 平台

### 2.1 `scheduler/config.ts`

**目的**：统一管理所有调度相关配置，支持启动时环境变量 + 运行时本地文件热加载。

**完整接口**：

```typescript
// packages/consumer-gateway/src/scheduler/config.ts

export type SchedulerMode = 'legacy' | 'new';

export interface SchedulerConfig {
  // === Master switches ===
  mode: SchedulerMode;                  // 'legacy' = 完全不启用新调度；'new' = 启用
  killSwitch: boolean;                   // true = 强制回退 legacy，无视其他配置
  rolloutPct: number;                    // 0-100，按 requestId hash 决定是否走新路径

  // === Phase 1 feature toggles（可独立开关）===
  enableHardFilter: boolean;
  enableSessionSticky: boolean;
  enableTopNPreselect: boolean;

  // === Hard Filter 参数 ===
  minSuccessRate: number;                // default 0.95
  minReputationScore: number;            // default 60
  minUptimeRate: number;                 // default 0.90
  newSellerExplorationRate: number;      // default 0.05

  // === Session Sticky 参数 ===
  stickyTableCapacity: number;           // default 1000
  stickyTTLMs: number;                   // default 600_000
  stickyOverflowRatio: number;           // default 0.90
  stickyFailureIgnoreWindowMs: number;   // default 60_000

  // === Top-N 参数 ===
  topN: number;                          // default 3

  // === 观测 ===
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logRingBufferSize: number;             // default 500（保留最近 N 条调度日志）
}

export const DEFAULT_CONFIG: SchedulerConfig = { /* 上述默认值 */ };

export class SchedulerConfigManager {
  /**
   * 加载配置。顺序：
   *   1. DEFAULT_CONFIG
   *   2. 环境变量覆盖（CLAW_SCHEDULER_*）
   *   3. 本地文件覆盖（~/.clawmarket/scheduler.json）
   */
  constructor(opts?: { configFilePath?: string; pollIntervalMs?: number });

  /** 当前配置快照，读取时不会阻塞（原子替换） */
  get(): SchedulerConfig;

  /** 启动文件轮询（默认每 5 秒检查一次 mtime） */
  startWatching(): void;
  stopWatching(): void;

  /** 订阅变更，用于 kill switch 触发时的日志告警 */
  onChange(callback: (oldCfg: SchedulerConfig, newCfg: SchedulerConfig) => void): () => void;

  /** 手动更新（供 admin 端点调用） */
  updateOverride(partial: Partial<SchedulerConfig>): void;
}
```

**环境变量映射**（示例）：
- `CLAW_SCHEDULER_MODE=new|legacy`
- `CLAW_SCHEDULER_KILL=true|false`
- `CLAW_SCHEDULER_ROLLOUT_PCT=0..100`
- `CLAW_SCHEDULER_ENABLE_STICKY=true|false`

**本地文件格式** `~/.clawmarket/scheduler.json`（存在则覆盖对应字段，不存在不报错）：
```json
{
  "mode": "new",
  "killSwitch": false,
  "rolloutPct": 5,
  "enableSessionSticky": true
}
```

**关键实现要求**：
- 文件读取失败、JSON 解析失败都**不能抛出**，记一条 warn 日志然后保持旧配置
- 默认初始配置必须是"等价于 legacy"的安全值：`mode = 'legacy'`、`rolloutPct = 0`、`killSwitch = false`
- 配置变更时打印一条醒目的 warn 日志

**单元测试（config.test.ts）必须包含**：
- 默认值正确
- 环境变量能覆盖默认值
- 本地文件能进一步覆盖环境变量
- 文件不存在时不报错
- 损坏的 JSON 文件不影响运行
- kill switch 优先级高于 rolloutPct
- 轮询监测到文件变化并触发 onChange

---

### 2.2 `scheduler/logger.ts`

**目的**：结构化调度日志。每个请求一行 JSONL，带 `[SCHED]` 前缀便于 grep；同时保留在内存环形缓冲，供 admin 端点查询最近 N 条。

**接口**：

```typescript
// packages/consumer-gateway/src/scheduler/logger.ts

export interface SchedulerDecisionLog {
  requestId: string;
  model: string;
  ts: number;

  // 选择过程
  sessionKey?: string;                  // hash，不含原文
  sessionKeySource: 'explicit' | 'user' | 'prompt_prefix' | 'none';
  stickyHit: boolean;
  stickyReason?: 'hit' | 'miss' | 'overloaded' | 'unhealthy' | 'expired';

  // 候选池
  candidatesRaw: number;                 // DHT 返回的数量
  candidatesAfterFilter: number;         // Hard Filter 通过数
  filterReasons?: Record<string, number>; // { "low_success_rate": 2, "price_cap": 1 }

  // 最终选择
  selectedPeerId?: string;
  selectedPrice?: number;
  selectionReason: 'sticky' | 'top_n' | 'legacy' | 'no_candidate';
  alternatives: string[];                // 备选 peer id（Top-N）

  // 结果
  attempts: number;
  outcome: 'success' | 'failover' | 'error' | 'in_progress';
  errorKind?: string;
  latencyMs?: { ttfb?: number; total?: number };

  // 路由模式
  schedulerMode: SchedulerMode;
  rolledOut: boolean;                    // 该请求是否进入新路径
}

export class SchedulerLogger {
  constructor(config: SchedulerConfig);

  /** 开始记录一次请求的决策（返回 builder） */
  startRequest(requestId: string, model: string): DecisionLogBuilder;

  /** 获取最近 N 条日志（admin 端点使用） */
  getRecent(limit?: number): SchedulerDecisionLog[];

  /** 简易聚合（admin 端点使用） */
  getSummary(windowMs?: number): {
    total: number;
    stickyHitRate: number;
    successRate: number;
    avgCandidatesAfterFilter: number;
    topPeerDistribution: Record<string, number>;
  };
}

export interface DecisionLogBuilder {
  setSessionKey(key: string | undefined, source: SchedulerDecisionLog['sessionKeySource']): this;
  setStickyResult(hit: boolean, reason?: SchedulerDecisionLog['stickyReason']): this;
  setCandidates(raw: number, filtered: number, reasons?: Record<string, number>): this;
  setSelected(peerId: string, price: number, reason: SchedulerDecisionLog['selectionReason'], alts: string[]): this;
  setOutcome(outcome: SchedulerDecisionLog['outcome'], errorKind?: string): this;
  setLatency(ttfb?: number, total?: number): this;
  setMode(mode: SchedulerMode, rolledOut: boolean): this;
  finalize(): void;  // 写入 stdout + ring buffer
}
```

**输出格式**（stdout 一行）：
```
[SCHED] {"requestId":"abc","model":"claude-3-opus","ts":1745...,...}
```

**关键实现要求**：
- Logger 构造时只记录引用，不启动后台任务
- `finalize()` 必须**绝不抛错**（内部 try/catch），否则会把业务请求带崩
- 环形缓冲用定长数组 + 指针，O(1) 写入
- `sessionKey` 字段**只存 hash**（SHA-256 前 16 字节），不存原文，避免日志泄漏用户 prompt

**单元测试必须包含**：
- builder 链式调用
- ring buffer 容量上限
- finalize() 抛错不传播
- getSummary() 的统计正确性

---

### 2.3 `scheduler/admin-endpoint.ts`

**目的**：本地 HTTP 端点，供运维紧急操作 + 观测用。**仅绑定 127.0.0.1**，不对外暴露。

**端点清单**：

| Method | Path | 说明 |
|---|---|---|
| GET | `/admin/scheduler/config` | 返回当前 SchedulerConfig |
| POST | `/admin/scheduler/config` | 覆盖部分配置（body 为 Partial<SchedulerConfig>） |
| POST | `/admin/scheduler/kill` | 立即设置 `killSwitch=true` |
| POST | `/admin/scheduler/revive` | 清除 killSwitch |
| GET | `/admin/scheduler/logs?limit=100` | 返回最近 N 条 SchedulerDecisionLog |
| GET | `/admin/scheduler/summary?windowMs=60000` | 聚合统计 |
| GET | `/admin/scheduler/sticky` | 返回当前粘性表（脱敏） |

**端口**：默认 `localhost:9457`（选一个不常用端口）。可用环境变量 `CLAW_SCHEDULER_ADMIN_PORT` 覆盖。

**安全要求**：
- **必须** `host === '127.0.0.1' || host === 'localhost'`，其他 host 返回 403
- 无认证（仅本地）
- 启动失败（端口占用）**不能**阻塞主服务，记 warn 即可

**集成方式**：在 `LocalServer` 启动时，如果配置开启 admin 端点就启动它；进程退出时关闭。

---

### 2.4 Mock Seller 测试平台（`tools/mock-seller/`）

**目的**：在没有真实 seller 集群的情况下验证 Phase 1 的正确性和稳定性。

#### 2.4.1 Mock Seller 行为

每个 mock seller 是独立进程（或同进程多 worker），实现：

- 监听 libp2p，接受 buyer 连接
- 收到 `InferenceRequest` → 查看配置的行为 → 返回假响应
- 不解密 payload（忽略）、不调真实 LLM
- 返回可配置的 token 流（字节数、速率、延迟都可调）
- 支持行为脚本：时间驱动的状态切换

**配置示例**：
```typescript
{
  peerId: 'mock-seller-001',
  walletAddress: '0x...',
  models: [{ model: 'mock-gpt-4', inputPer1m: 3.0, outputPer1m: 9.0 }],
  maxConcurrent: 8,
  reputation: { score: 85, successRate: 0.98, avgLatencyMs: 400, totalTransactions: 1000 },

  behavior: {
    baseTTFTMs: 400,
    baseTPS: 50,
    ttftJitterMs: 100,
    errorRate: 0.0,
    timeline: [
      { atMs: 30_000, action: { type: 'increase_latency', multiplier: 3 } },
      { atMs: 60_000, action: { type: 'crash' } },
      { atMs: 120_000, action: { type: 'recover' } }
    ]
  }
}
```

#### 2.4.2 Mock Cluster

`mock-cluster.ts` 启动 N 个 mock seller，支持：
- CLI：`pnpm --filter @clawmarket/mock-seller cluster --count 50 --preset mixed`
- 预设：`homogeneous` / `mixed`（不同价格/延迟）/ `unreliable`（含故障节点）
- 输出每个 seller 的 peer id 和 multiaddr，供 buyer 连接

#### 2.4.3 Scenario Runner

`scenario-runner.ts` 运行端到端场景：
- 启动 mock cluster
- 启动本地 buyer
- 发送可配置的请求流（并发、总量、session 分布）
- 收集 buyer 侧 SchedulerDecisionLog
- 输出断言报告（如 "sticky hit rate ≥ 80%"）

**必备场景**（Phase 0 交付）：

| 场景 | 断言 |
|---|---|
| `baseline` | 50 seller 稳定运行 10 分钟，成功率 > 99% |
| `seller-failover` | 随机 20% seller 每分钟 crash-recover，成功率 > 95% |
| `load-spike` | 并发从 10 跳到 500，成功率 > 95%，top seller 流量占比 < 50%（Phase 1 完成后验证） |
| `session-stickiness` | 10 个 session 各 100 轮请求，同 session 粘定率 > 80% |
| `dht-stale` | DHT 返回的 announcement 滞后 2 分钟，buyer 仍能工作 |

**关键**：scenario runner 以退出码表明成败（0 = 通过，非 0 = 失败），便于接入 CI。

---

### 2.5 Phase 0 验收清单

Phase 0 完成标志：

- [ ] `SchedulerConfigManager` 实现 + 单测通过
- [ ] `SchedulerLogger` 实现 + 单测通过
- [ ] Admin 端点可启停，GET /config 返回默认配置
- [ ] 启动 buyer 后 `CLAW_SCHEDULER_MODE=legacy`（默认）时行为**与现在完全一致**（回归测试通过）
- [ ] `stdout` 有 `[SCHED]` 结构化日志，每个请求一行
- [ ] Mock seller 可启动，buyer 能连上并发一个推理请求
- [ ] Scenario `baseline` 通过（50 seller，10 分钟）
- [ ] 全部现有单测（`pnpm test`）不回归

**重要验收原则**：Phase 0 **不修改任何现有路由/选择逻辑**。现阶段 `mode=legacy` 即"什么都没变"，只是多了观测和 feature flag。

---

## 3. Phase 1 — Hard Filter + Session 粘性 + Top-N 预选

### 3.1 `scheduler/session-key.ts`

**职责**：从请求提取或派生 session key。

```typescript
// packages/consumer-gateway/src/scheduler/session-key.ts

import type { ChatCompletionRequest } from '../types';

export type SessionKeySource = 'explicit' | 'user' | 'prompt_prefix' | 'none';

export interface SessionKeyResult {
  key: string | null;
  source: SessionKeySource;
}

/**
 * 提取 session key，优先级：
 *   1. body.session_id（我们的扩展字段）
 *   2. body.user + ':' + body.model
 *   3. 所有 messages 中，除最后一条以外的 content 拼接做 SHA-256，取前 16 字节 hex
 *   4. 单轮无 user → 返回 null（后续 Phase 1 走普通选择）
 *
 * 生成的 key 统一 64 字符 hex；null 表示无粘性。
 */
export function deriveSessionKey(body: ChatCompletionRequest): SessionKeyResult;

/** 将原始 key 规范化为 hash（日志和表内部都使用 hash 存储） */
export function hashSessionKey(raw: string): string;
```

**关键要求**：
- **永远不把原始 prompt 内容作为 key 存储或打印**，只存 hash
- 空 messages 数组、单条 message → `source = 'none'`, `key = null`
- `session_id` 需要在 `ChatCompletionRequest` 类型中加入可选字段（protocol 向后兼容）

**单测必含**：
- 显式 session_id 优先
- user + model hash 稳定
- prompt 前缀 hash：相同前 N-1 条 message 得到相同 key
- 单轮消息 → null

---

### 3.2 `scheduler/session-sticky.ts`

**职责**：LRU + TTL 粘性表。

```typescript
// packages/consumer-gateway/src/scheduler/session-sticky.ts

export interface StickyEntry {
  peerId: string;
  createdAt: number;
  lastUsedAt: number;
  hitCount: number;
  consecutiveFailures: number;
  lastFailureAt?: number;
}

export class SessionStickyTable {
  constructor(config: { capacity: number; ttlMs: number });

  /** 查询。同时更新 lastUsedAt（LRU 排序）。过期或不存在 → null */
  get(keyHash: string): StickyEntry | null;

  /** 绑定/刷新 */
  set(keyHash: string, peerId: string): void;

  /** 标记粘定 seller 失败一次 */
  markFailure(keyHash: string): void;

  /** 成功调用后重置失败计数 */
  markSuccess(keyHash: string): void;

  /** 主动删除（seller 被 hard filter 永久剔除时调用） */
  delete(keyHash: string): void;

  /** admin 端点用：脱敏快照 */
  snapshot(): Array<{ keyHashPrefix: string; peerId: string; hitCount: number; ageMs: number }>;

  /** 测试辅助：手动推进时间 */
  readonly size: number;
}
```

**实现细节**：
- 用 `Map<string, StickyEntry>` + 双向链表实现 LRU（或直接利用 `Map` 的插入顺序）
- `get` 若发现 `Date.now() - lastUsedAt > ttlMs` 则删除并返回 null
- 超出 capacity 时淘汰最久未用的条目
- **不在内部做定时清理**（避免泄漏 timer），在 get/set 时 lazy 清理即可

**单测必含**：
- LRU 淘汰顺序正确
- TTL 过期清理
- 并发 set 同一 key 不会产生重复
- markFailure 累计，markSuccess 重置
- snapshot 不泄漏完整 key hash（只返回前缀）

---

### 3.3 `scheduler/hard-filter.ts`

**职责**：对 `ScoredProvider[]` 做硬约束过滤，返回合格候选集 + 过滤原因统计。

```typescript
// packages/consumer-gateway/src/scheduler/hard-filter.ts

import type { ScoredProvider } from '../router';
import type { SchedulerConfig } from './config';

export interface HardFilterResult {
  candidates: ScoredProvider[];
  reasons: Record<string, number>;       // { "low_success_rate": 2, ... }
  explorationCandidates: ScoredProvider[]; // 冷启动例外
}

export interface HardFilterInput {
  providers: ScoredProvider[];
  model: string;
  userMaxPrice?: number;                 // 用户设定的上限，可选
  excludedPeerIds?: Set<string>;         // 已尝试过的 peer（重试场景）
}

export function applyHardFilter(
  input: HardFilterInput,
  config: SchedulerConfig
): HardFilterResult;
```

**过滤规则**（按 `scheduling-design.md §4.1`）：

| 规则 | 拒绝理由代码 |
|---|---|
| `userMaxPrice` 存在且 `output+input 均价 > userMaxPrice` | `price_cap` |
| `reputation.successRate < minSuccessRate` | `low_success_rate` |
| `reputation.score < minReputationScore` | `low_reputation` |
| `excludedPeerIds.has(peerId)` | `already_tried` |
| （Phase 1 暂不使用 uptime 字段，因当前 ProviderAnnouncement 没有；预留） | — |

**冷启动例外**：
- 声誉分低但 `reputation.totalTransactions < 10` → 视为新 seller
- 以 `newSellerExplorationRate`（默认 5%）概率跳过声誉下限，进入 `explorationCandidates`
- 由上层决定是否把 exploration 候选合并进 candidates

**重要**：此函数是**纯函数**，不依赖 `Date.now()`，易于单测。

**单测必含**：
- 全部拒绝的边界情况
- 各原因正确计数
- 冷启动例外概率近似正确（跑 10000 次统计）
- `excludedPeerIds` 优先级

---

### 3.4 `router.ts` 的增强

**新增两个方法**，不改现有 API：

```typescript
// packages/consumer-gateway/src/router.ts

export class P2PRouter {
  // ... 现有所有方法保留不变 ...

  /**
   * 返回前 N 个合格候选。供新 scheduler 使用。
   * 内部仍然调用 findProviders，不改变缓存行为。
   */
  async selectTopN(model: string, n: number, excludedPeerIds?: Set<string>): Promise<ScoredProvider[]> {
    const providers = await this.findProviders(model);
    const filtered = excludedPeerIds
      ? providers.filter(p => !excludedPeerIds.has(p.announcement.peerId))
      : providers;
    return filtered.slice(0, n);
  }

  /**
   * 降权（未完全剔除），供 Phase 3 backpressure 使用；Phase 1 先声明接口，内部为空实现。
   */
  markDegraded(peerId: string, multiplier: number, durationMs: number): void {
    // Phase 3 实现
  }
}
```

**`router.ts` 其他不改动**。`selectBest`、`selectBestExcluding`、`markFailed` 等保留原逻辑，作为 legacy 路径。

---

### 3.5 `scheduler/scheduler.ts`（核心入口）

**职责**：封装 Phase 1 完整决策流程。这是 `local-server.ts` 唯一调用的新入口。

```typescript
// packages/consumer-gateway/src/scheduler/scheduler.ts

export interface SelectInput {
  model: string;
  requestId: string;
  body: ChatCompletionRequest;
  userMaxPrice?: number;
  excludedPeerIds: Set<string>;         // 本次请求已尝试的 peer
  logBuilder: DecisionLogBuilder;
}

export interface SelectOutput {
  provider: ScoredProvider | null;
  alternatives: ScoredProvider[];       // Top-N 的剩余备选
  source: 'sticky' | 'top_n' | 'legacy' | 'no_candidate';
}

export class Scheduler {
  constructor(
    private router: P2PRouter,
    private sticky: SessionStickyTable,
    private config: SchedulerConfigManager,
    private logger: SchedulerLogger,
  );

  /**
   * 选择一个 seller。保证在任何异常情况下都 fallback 到 legacy 路径。
   */
  async select(input: SelectInput): Promise<SelectOutput>;

  /** 请求成功完成时调用 */
  onSuccess(sessionKeyHash: string | null, peerId: string): void;

  /** 请求失败时调用 */
  onFailure(sessionKeyHash: string | null, peerId: string, errorKind: string): void;
}
```

**`select()` 的具体流程**（伪代码）：

```
function select(input):
  cfg = config.get()

  # 1. 模式门禁
  if cfg.killSwitch OR cfg.mode == 'legacy':
    return legacySelect(input)          # 完全走原路径

  if NOT requestIsRolledOut(input.requestId, cfg.rolloutPct):
    return legacySelect(input)

  # 2. 包一层 try/catch，任何异常都回退
  try:
    return await newSelect(input, cfg)
  catch (err):
    logger.error('scheduler.new path failed, falling back', err)
    return legacySelect(input)


function newSelect(input, cfg):
  # 2.1 session key
  keyResult = deriveSessionKey(input.body)
  input.logBuilder.setSessionKey(keyResult.key, keyResult.source)

  # 2.2 如果启用粘性,先查粘性表
  if cfg.enableSessionSticky AND keyResult.key != null:
    entry = sticky.get(hashSessionKey(keyResult.key))
    if entry AND entry.peerId NOT IN input.excludedPeerIds:
      # 检查粘定 seller 是否仍健康且非刚失败
      if Date.now() - (entry.lastFailureAt ?? 0) > cfg.stickyFailureIgnoreWindowMs:
        # 检查候选池是否还包含它
        topN = await router.selectTopN(input.model, cfg.topN, input.excludedPeerIds)
        hit = topN.find(p => p.peerId == entry.peerId)
        if hit:
          # TODO Phase 3:检查 inflight < maxConcurrent * overflowRatio
          input.logBuilder.setStickyResult(true, 'hit')
          alts = topN.filter(p => p != hit)
          input.logBuilder.setSelected(hit.peerId, avgPrice(hit), 'sticky', alts.peerIds)
          return { provider: hit, alternatives: alts, source: 'sticky' }
        else:
          input.logBuilder.setStickyResult(false, 'unhealthy')
          sticky.delete(entry.keyHash)
      else:
        input.logBuilder.setStickyResult(false, 'unhealthy')

  input.logBuilder.setStickyResult(false, 'miss')

  # 2.3 普通选择:Hard Filter + Top-N
  raw = await router.findProviders(input.model)
  input.logBuilder.setCandidates(raw.length, 0)

  filterResult = applyHardFilter({
    providers: raw,
    model: input.model,
    userMaxPrice: input.userMaxPrice,
    excludedPeerIds: input.excludedPeerIds,
  }, cfg)

  candidates = [...filterResult.candidates, ...filterResult.explorationCandidates]
  candidates.sort(by score desc)

  input.logBuilder.setCandidates(raw.length, candidates.length, filterResult.reasons)

  if candidates.empty:
    input.logBuilder.setSelected(null, 0, 'no_candidate', [])
    return { provider: null, alternatives: [], source: 'no_candidate' }

  topN = candidates.slice(0, cfg.topN)
  selected = topN[0]
  alts = topN.slice(1)

  input.logBuilder.setSelected(selected.peerId, avgPrice(selected), 'top_n', alts.peerIds)

  # 2.4 更新粘性表
  if cfg.enableSessionSticky AND keyResult.key != null:
    sticky.set(hashSessionKey(keyResult.key), selected.peerId)

  return { provider: selected, alternatives: alts, source: 'top_n' }
```

**`requestIsRolledOut()`**:
```
function requestIsRolledOut(requestId, pct):
  if pct >= 100: return true
  if pct <= 0: return false
  h = sha256(requestId) first 4 bytes as uint32
  return (h % 100) < pct
```

**关键实现要求**：
- `select` 必须**绝不抛错**。try/catch 包所有新代码，失败必须调用 `legacySelect` 兜底
- `legacySelect` 就是现在 `local-server.ts` 的现有逻辑：调用 `router.selectBest` 或 `router.selectBestExcluding`
- `onSuccess` / `onFailure` 只在新路径启用时才调用 sticky.markSuccess/markFailure。legacy 路径下这两个方法是 no-op
- **不要**在 scheduler 内部做 P2P / 支付 / 加密。scheduler 只做"选哪个 seller"

---

### 3.6 `local-server.ts` 的最小修改

**当前代码** (`local-server.ts:436`) 的 for 循环：
```typescript
for (let attempt = 0; attempt < MAX_PROVIDER_ATTEMPTS; attempt++) {
  const provider = attempt === 0
    ? await this.router.selectBest(body.model)
    : await this.router.selectBestExcluding(body.model, triedPeerIds);
  ...
}
```

**改造后**（diff 示意，逐步保守地改）：

```typescript
const logBuilder = this.schedulerLogger.startRequest(requestId, body.model);
logBuilder.setMode(this.config.get().mode, /* rolledOut 稍后设置 */ false);

let preselected: SelectOutput | null = null;

for (let attempt = 0; attempt < MAX_PROVIDER_ATTEMPTS; attempt++) {
  let provider: ScoredProvider | null;
  let alternatives: ScoredProvider[] = [];

  if (attempt === 0) {
    // 第一次:走 scheduler
    preselected = await this.scheduler.select({
      model: body.model,
      requestId,
      body,
      userMaxPrice: body.max_price_per_1m,  // Phase 2 才启用,Phase 1 可不传
      excludedPeerIds: triedPeerIds,
      logBuilder,
    });
    provider = preselected.provider;
    alternatives = preselected.alternatives;
  } else {
    // 后续尝试:优先用 Top-N 预选
    if (preselected && preselected.alternatives.length > 0) {
      provider = preselected.alternatives.shift() ?? null;
      alternatives = preselected.alternatives;
    } else {
      // 预选用完,退回到 router.selectBestExcluding
      provider = await this.router.selectBestExcluding(body.model, triedPeerIds);
    }
  }

  if (!provider) break;
  const peerId = provider.announcement.peerId;
  triedPeerIds.add(peerId);

  // ... 支付/加密/发送逻辑完全不变 ...

  try {
    // ... 发送请求 ...
    this.router.markSuccess(peerId);
    this.scheduler.onSuccess(sessionKeyHash, peerId);
    logBuilder.setOutcome('success').finalize();
    return;
  } catch (err) {
    this.router.markFailed(peerId);
    this.scheduler.onFailure(sessionKeyHash, peerId, classifyProviderFailure(err, body.model).kind);
    // ... 现有失败处理 ...
  }
}

logBuilder.setOutcome('error').finalize();
// ... 现有错误返回 ...
```

**变动要点**：
- `selectBest` 替换为 `scheduler.select`，失败时 scheduler 内部已自动回退 legacy（所以外层不需要额外 fallback）
- 后续重试优先用 alternatives，耗尽后退回 `selectBestExcluding`
- 失败和成功都通过 `scheduler.onSuccess/onFailure` 通知粘性表
- `logBuilder.finalize()` 务必在所有退出路径都调用（包括早退、异常）

**sessionKeyHash 的获取**：`scheduler.select` 返回后，从 logBuilder 或 scheduler 内部暴露一个 getter。简单做法是让 `select()` 一并返回 `sessionKeyHash`。

---

### 3.7 `ChatCompletionRequest` 类型扩展

```typescript
// packages/consumer-gateway/src/types.ts（或类似位置）

export interface ChatCompletionRequest {
  // ... 现有字段 ...
  session_id?: string;           // 新增：可选的会话 id，用于粘性
  user?: string;                 // OpenAI 兼容，已有时不需加
  max_price_per_1m?: number;     // 预留 Phase 2 使用，Phase 1 先接收但不用
}
```

**注意**：这是 buyer 内部字段，外部 OpenAI 客户端不会发送 `session_id`。为了复用 OpenAI 标准字段，**优先**从 `user` 派生 session；若 Phase 2 做 UI 再考虑显式 `session_id`。

---

### 3.8 Phase 1 验收清单

- [ ] 所有新文件的单测通过（Jest/Vitest 100% 关键分支覆盖）
- [ ] 全部现有单测不回归
- [ ] **灰度 0%（rolloutPct=0）时，行为与 Phase 0 完全一致**（使用 mock cluster 对比 log）
- [ ] 灰度 100% 时，`[SCHED]` 日志中 `selectionReason` 正确出现 `sticky` / `top_n` / `no_candidate`
- [ ] 场景 `session-stickiness` 通过：同 session 粘定率 ≥ 80%
- [ ] 场景 `seller-failover` 通过：20% seller 周期性 crash 时成功率 ≥ 95%
- [ ] 场景 `baseline` 退回灰度 0% 时成功率与 Phase 0 baseline 持平（±1%）
- [ ] 主动 kill switch 测试：灰度 100% 跑起来后，`POST /admin/scheduler/kill` 后 30 秒内 log 显示 `schedulerMode: legacy`
- [ ] 注入 bug 测试：在 `Scheduler.select` 里临时抛出异常，请求成功率不应下降（说明 fallback 生效）

---

## 4. 上线策略（灰度 + 回滚）

### 4.1 推荐的推出节奏

| 天 | 动作 | rolloutPct | 观察重点 |
|---|---|---|---|
| D1 | 升级本地开发机到新 buyer，测试连通性 | 0 | 无回归 |
| D2-D3 | 自己的 buyer 先跑，观察 SCHED 日志 | 5 | 是否有异常 fallback、粘性命中率 |
| D4-D5 | 少数受信用户灰度 | 5-25 | 成功率、延迟、错误分布 |
| D6-D7 | 放到 50% | 50 | 负载分布、无明显回归 |
| D8+ | 全量 | 100 | 持续观察 |

**任何一天发现异常 → 立即 `killSwitch=true`**，全量回 legacy。

### 4.2 监控什么

每天对比：
- 全量请求成功率（按请求数）
- P95 TTFB、P95 总延迟
- Top seller 流量占比（确认没因为 Phase 1 改变而失衡）
- Sticky hit rate（如果启用粘性）
- 异常 fallback 次数（正常应该是 0）

### 4.3 回滚方式

**三级回滚**（优先级从快到慢）：

1. **最快**：`echo '{"killSwitch":true}' > ~/.clawmarket/scheduler.json` — 5 秒内生效
2. **管理接口**：`curl -X POST http://localhost:9457/admin/scheduler/kill`
3. **彻底**：回滚部署到上个版本

---

## 5. 风险与对策清单

| 风险 | 对策 |
|---|---|
| Scheduler 代码有 bug 导致请求失败 | 所有新路径 try/catch + fallback 到 legacy；Fail-safe 测试作为 Phase 1 验收项 |
| 粘性表把流量压在少数 seller 上 | 粘性 TTL 10 分钟 + 冷启动例外；Phase 3 再加 overflow 阈值 |
| 日志过多撑爆 stdout/disk | logger 本身不做文件落盘（只 stdout + 内存 buffer）；部署时用 logrotate 管理 stdout |
| 本地 admin 端口被外部扫到 | 绑定 127.0.0.1 校验；启动时显式打印绑定地址 |
| Config 文件轮询影响性能 | 5 秒轮询 + 仅检查 mtime（O(1) 系统调用） |
| Mock seller 协议和真实 seller 不一致 | Mock 直接 import `@clawmarket/p2p-node` 的协议代码；避免二次实现 |
| 灰度 hash 分布不均 | 用 sha256 保证均匀；启动时打印示例 hash 分布供核验 |
| Session key hash 冲突 | 用 SHA-256，16 字节 hex，碰撞概率可忽略 |
| Exploration 概率在低 QPS 下偏差大 | Phase 1 接受此偏差；Phase 2 可改为确定性配额 |
| 粘定 seller 刚失败就又被选中 | `stickyFailureIgnoreWindowMs` 60 秒窗口过滤 |
| 并发请求同时更新粘性表产生竞态 | Node.js 单线程事件循环，Map 操作本身原子。异步路径之间不共享可变状态外的局部变量 |

---

## 6. 对 Codex 等编码 agent 的提示

如果你是 AI 编码 agent 在执行此文档，请遵守：

1. **按顺序实现**：必须 Phase 0 全部通过后再做 Phase 1。Phase 0 是安全网
2. **不要合并提交**：每个子模块（config / logger / sticky / filter / scheduler / mock）一个 PR / commit
3. **每写一个类，先写单测**：先写 `.test.ts`，明确预期行为，再实现
4. **不要扩大范围**：看到相关代码有问题不要顺手改，记录下来另开 task
5. **遇到设计未覆盖的细节**：优先选"最保守"的方案（例如：不确定该抛错还是静默忽略 → 选静默 + warn log）
6. **绝不修改**：`wallet.ts`, `pool-manager.ts`, `quality-monitor.ts`, `packages/p2p-node/**`, `packages/provider-gateway/**`, `packages/shared/src/types`（除新增 SchedulerConfig 外）
7. **任何涉及支付 nonce、加密、签名的代码路径一行都不要动**
8. **完成后运行**：`pnpm test` + `pnpm --filter @clawmarket/mock-seller scenario-runner baseline` + `scenario-runner seller-failover` + `scenario-runner session-stickiness`，全部绿色才算完

---

## 7. 交付物清单

**Phase 0**：
- [ ] `packages/consumer-gateway/src/scheduler/config.ts` + test
- [ ] `packages/consumer-gateway/src/scheduler/logger.ts` + test
- [ ] `packages/consumer-gateway/src/scheduler/admin-endpoint.ts` + test
- [ ] `tools/mock-seller/**`（seller、cluster、scenario runner、3+ 预设场景）
- [ ] `local-server.ts` 集成 logger（不启用新选择逻辑）

**Phase 1**：
- [ ] `packages/consumer-gateway/src/scheduler/session-key.ts` + test
- [ ] `packages/consumer-gateway/src/scheduler/session-sticky.ts` + test
- [ ] `packages/consumer-gateway/src/scheduler/hard-filter.ts` + test
- [ ] `packages/consumer-gateway/src/scheduler/scheduler.ts` + test
- [ ] `router.ts` 新增 `selectTopN` + test
- [ ] `local-server.ts` 集成 scheduler（带 fallback 保护）
- [ ] scenario `session-stickiness`、`seller-failover` 通过

---

**文档版本**：v1.0
**最后更新**：2026-04-21
**状态**：待实施

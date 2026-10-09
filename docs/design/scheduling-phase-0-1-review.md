# 调度系统 Phase 0 + Phase 1 代码审查

> **被审查范围**：`packages/consumer-gateway/src/scheduler/**`、`router.ts` / `local-server.ts` / `shared/types` 的调度相关改动、`tools/mock-seller/**`
> **审查依据**：`docs/design/scheduling-phase-0-1-implementation.md`
> **单测状态**：32 个 scheduler 单测全部通过 ✓
> **整体评价**：**代码质量良好，核心骨架正确**，有 1 个**必须修**的行为 bug，其他是观测精度和健壮性改进项。
> **可否上线**：修完 §1 的 3 个问题后可以进入 `mode=new, rolloutPct=0` 的空跑验证。**目前不要把 rolloutPct 调到 > 0。**

---

## 0. 先说做得好的地方

- ✅ `Scheduler.select()` 在新路径上有 try/catch，异常自动回退 legacy（[scheduler.ts:46-53](packages/consumer-gateway/src/scheduler/scheduler.ts:46)）
- ✅ `DecisionLogBuilder.finalize()` 内部 try/catch，日志失败不会带崩业务请求（[logger.ts:131-135](packages/consumer-gateway/src/scheduler/logger.ts:131)）
- ✅ `SchedulerAdminServer` 绑定 127.0.0.1 + Host header 校验（[admin-endpoint.ts:127-133](packages/consumer-gateway/src/scheduler/admin-endpoint.ts:127)）
- ✅ Config 文件读取失败/JSON 损坏都只 warn 不抛（[config.ts:135-139](packages/consumer-gateway/src/scheduler/config.ts:135)）
- ✅ 默认配置是安全的 `mode: 'legacy'`, `rolloutPct: 0`, `killSwitch: false`（[config.ts:13-31](packages/consumer-gateway/src/scheduler/config.ts:13)）
- ✅ Mock seller 平台齐全（cluster、scenario runner、5 个预设场景）
- ✅ 32 个单测通过，关键分支都有覆盖
- ✅ 协议层零改动（shared/types 只新增了字段，未修改现有结构）
- ✅ `local-server.ts` 的改动保持了现有支付/加密/重试结构，只替换了"选 seller"这一步

---

## 1. 必须修（阻塞 rolloutPct > 0 上线）

### 1.1 【高危】Sticky hit 路径的 alternatives 未经 Hard Filter

**位置**：[`scheduler.ts:87-115`](packages/consumer-gateway/src/scheduler/scheduler.ts:87)

**问题**：
Sticky hit 路径调用 `router.selectTopN(...)`，这个方法仅做 `findProviders().slice(0, n)` —— **没有应用 Hard Filter**（低成功率、低声誉、价格上限、exclusion 都不过滤）。

```typescript
// scheduler.ts:87-91
const topCandidates = await this.router.selectTopN(
  input.model,
  cfg.topN,
  input.excludedPeerIds,     // 仅排除已试过的
);
```

返回的 `alternatives` 在主 seller（sticky）失败时会被直接使用，绕过了：
- 成功率 < 95% 的 seller 会被选上
- 声誉分低于阈值的 seller 会被选上
- 超出 `userMaxPrice` 的 seller 会被选上

这与设计文档的 "hard filter 是硬约束" 冲突，也违反用户的价格承诺。

**影响**：
- 用户可能在 sticky 粘定 seller 失败后，付出超过 `max_price_per_1m` 的钱给备选 seller
- 烂 seller 通过 sticky 备选路径"偷渡"到合格候选池

**修复建议**：
- 方案 A（推荐）：在 sticky hit 路径里，用 `findProviders + applyHardFilter` 生成 "filteredTopCandidates"，从中找 sticky peer。hit 的备选也从这个集合里取
- 方案 B：sticky 命中时只返回主 seller，不带 alternatives。后续失败时 scheduler 的后续 attempts 走完整路径

**建议实施方案 A**，这样 sticky 保留了"备选也是 0 延迟"的好处。

---

### 1.2 【中】Sticky 路径的 `candidatesRaw` / `candidatesAfterFilter` 日志数字误导

**位置**：[`scheduler.ts:101`](packages/consumer-gateway/src/scheduler/scheduler.ts:101)

**问题**：
```typescript
input.logBuilder
  .setStickyResult(true, 'hit')
  .setCandidates(topCandidates.length, topCandidates.length)  // 二者相等
```

`topCandidates.length` 最多是 `topN`（默认 3），但实际 DHT 返回的 seller 可能有几十几百个。日志中 `candidatesRaw=3, candidatesAfterFilter=3` 完全掩盖了真实候选规模，把后续的分析（如"hard filter 的拒绝率"）彻底搞错。

**修复建议**：
在 sticky hit 路径也调用一次 `router.findProviders()` 获取真实 raw 数量（可以和 §1.1 的修复合并）。修复 §1.1 后这个问题自然解决。

---

### 1.3 【中】Sticky 条目在 "not in top-N" 时被过于激进地删除

**位置**：[`scheduler.ts:117`](packages/consumer-gateway/src/scheduler/scheduler.ts:117)

**问题**：
```typescript
if (hit) { ... return ...; }
input.logBuilder.setStickyResult(false, 'unhealthy');
this.sticky.delete(sessionKeyHash);  // ← 这里
```

当 sticky 粘定的 seller 不在当前 top-N 候选里时，直接删除 sticky 条目。但"不在 top-N"的原因可能只是：
- 该 seller 短暂离线后刚恢复，声誉分被重算，暂时排名靠后
- DHT cache 恰好刷新，短暂没返回它
- 其他 seller 的 score 短暂更高

一旦删除，后续同 session 的请求就再也粘不回这台了，cache 命中率归零。

**修复建议**：
- 不要立即删除，改为"这次绕过 sticky，走完整选择流程"
- 只有在连续 N 次（例如 3 次）都发现 sticky seller 不在候选里，才删除
- 或者保留一个 `stickySeenAtMs` 字段，30 分钟内都见不到才删除

---

## 2. 应该修（不阻塞初期灰度，但尽快修）

### 2.1 Config 变更不会传播到 Logger 和 StickyTable

**位置**：[`local-server.ts:97-102`](packages/consumer-gateway/src/local-server.ts:97), [`logger.ts:53`](packages/consumer-gateway/src/scheduler/logger.ts:53), [`session-sticky.ts:13`](packages/consumer-gateway/src/scheduler/session-sticky.ts:13)

**问题**：
`SchedulerLogger` 和 `SessionStickyTable` 在构造时一次性读取 config 值（`logRingBufferSize`、`stickyTableCapacity`、`stickyTTLMs`），之后永不更新。

这意味着：通过 admin endpoint `POST /admin/scheduler/config` 改 `stickyTTLMs`，对既有的粘性表**没有任何效果**。

**修复建议**：
让 `SessionStickyTable` 接受一个 `() => { capacity, ttlMs }` 函数或订阅 `configManager.onChange`，动态读取。或者显式声明这些参数"启动时生效，运行时不变"并在文档里写明。

---

### 2.2 `setStickyResult(false, 'miss')` 语义重载

**位置**：[`scheduler.ts:122, 125`](packages/consumer-gateway/src/scheduler/scheduler.ts:122)

**问题**：
目前 "miss" 涵盖了四种完全不同的情况：
- 粘性功能被 config 关闭
- 请求无法派生 session key（单轮无 user）
- 粘性表里没有这个 session
- 粘性表里有，但 peerId 已在 excludedPeerIds 中

运维看日志时无法区分"粘性根本没用"和"粘性命中率低"。

**修复建议**：
扩展 `stickyReason` 枚举：
```typescript
type StickyReason = 'hit' | 'miss' | 'disabled' | 'no_session_key'
                  | 'excluded' | 'recent_failure' | 'dropped_from_pool';
```
各路径分别打对应 reason。纯观测性改进，不影响功能。

---

### 2.3 Admin endpoint 测试用固定端口，CI 容易冲突

**位置**：[`admin-endpoint.test.ts:27, 44, 73`](packages/consumer-gateway/src/scheduler/admin-endpoint.test.ts:27)

**问题**：
测试固定写了端口 9461/9462/9463。如果 CI 机器上有其他服务占用，或并发跑测试，就会 flaky。

**修复建议**：
构造时传 `port: 0` 让 OS 自动分配端口，测试里从 `server.address()` 读出实际端口再发请求。需要在 `SchedulerAdminServer` 上暴露一个 `get url()` 或 `get port()` getter。

---

### 2.4 预选 alternatives 不检查健康度

**位置**：[`local-server.ts:483-492`](packages/consumer-gateway/src/local-server.ts:483)

**问题**：
主 seller A 失败 → `router.markFailed(A)` → 用 `preselectedAlternatives[0] = B`。但 B 可能刚好被另一个并发请求标记 failed。我们直接用 B 而不重查健康度。

**影响**：
小规模 / 低并发下几乎不会出现，但在 scenario `load-spike` 下可能放大。

**修复建议**：
取 alternative 前调用 `router.selectBestExcluding` 的同款过滤逻辑（失败计数 + 模型冷却），或在使用前 quick check：
```typescript
if (alternativeIsUnhealthy(provider.announcement.peerId)) {
  continue; // 取下一个 alternative
}
```

---

## 3. 小改进（次要，可放到后续 PR）

### 3.1 `legacySelect` 的 `sessionKeyHash` 参数永远是 null

**位置**：[`scheduler.ts:43, 52, 189-210`](packages/consumer-gateway/src/scheduler/scheduler.ts:189)

调用方全是 `this.legacySelect(input, null)`。参数没用，删掉或用起来。

---

### 3.2 成功路径下重复调用 `sticky.set`

**位置**：[`scheduler.ts:176`](packages/consumer-gateway/src/scheduler/scheduler.ts:176) + [`scheduler.ts:60`](packages/consumer-gateway/src/scheduler/scheduler.ts:60)

新路径的 top_n 分支里已经调了 `sticky.set(sessionKeyHash, provider.peerId)`。请求成功后 `onSuccess` 又调一次 `sticky.set` + `markSuccess`。不是 bug，但多余的一次 Map 操作 + LRU reorder。

**修复建议**：`onSuccess` 改为只 `markSuccess`，不再 `set`。sticky 的 "记录粘定关系" 交给 scheduler 的选择路径负责。

---

### 3.3 `Scheduler.select` 在 `rolledOut=true` 但 `selectionReason` 可能是 `'no_candidate'` 时仍把 `source='no_candidate'`

**位置**：[`scheduler.ts:151-160, 180-186`](packages/consumer-gateway/src/scheduler/scheduler.ts:151)

语义 OK，但 local-server 收到 `provider=null` 后会直接 break 重试循环，返回 503 "No provider available"。此时 `attempts=0` 日志里会看起来像"系统完全没试"，其实是"hard filter 全拒了"。

**修复建议**：观测维度上给 `no_candidate` 加一个明确的 errorKind（如 `no_candidate_after_filter`），便于区分"根本没 seller"和"有但都不合格"。

---

### 3.4 `scheduler.test.ts` 缺少关键用例

**建议补充**：

- **回归保护**：`rolloutPct=0` 时所有行为与 legacy 一致（对比决策输出）
- **Kill switch 抢占**：`rolloutPct=100` + `killSwitch=true` 必须走 legacy
- **onFailure 正确递增粘性 failure count**：目前测了 onSuccess 但没测 onFailure
- **Sticky entry 指向 excluded peer 时**：应走普通路径而不是 sticky（目前未覆盖）
- **`stickyFailureIgnoreWindowMs` 窗口内的粘性条目**：应跳过 sticky 路径（目前未覆盖）
- **多 session 交叉的稳定性**：5 个 session 并发各发 50 请求，每个 session 的粘定率 ≥ 80%

---

### 3.5 Logger 的 `filterReasons` 在 sticky 路径里可能丢失上下文

**位置**：[`scheduler.ts:100-102`](packages/consumer-gateway/src/scheduler/scheduler.ts:100)

Sticky hit 路径不调 `applyHardFilter`，所以 `filterReasons` 永远是 undefined。这是预期的（因为没做 filter），但结合 §1.1 的修复，建议也把 filter reasons 填上。

---

### 3.6 `deriveSessionKey` 对空字符串 user 的处理

**位置**：[`session-key.ts:18-21`](packages/consumer-gateway/src/scheduler/session-key.ts:18)

当前 `body.user?.trim()` 空字符串→`undefined`，会回退到 prompt_prefix。OK。但 `session_id` 也是同样处理。如果用户传 `session_id: "   "` 会被当作没传。合理，但文档里说一下更好。

---

### 3.7 Mock seller 测试平台未被 Phase 0 验收场景连上

**位置**：`tools/mock-seller/src/scenarios/*`

Phase 0 的验收清单要求 `scenario-runner baseline` 能端到端跑通（拉起 mock cluster + 本地 buyer + 发请求 + 断言）。目前 `scenarios/*.ts` 看起来结构齐全，但**没看到 README 或 runbook 描述怎么启动并连到真实 buyer**。

**建议**：
- 在 `tools/mock-seller/README.md` 里加一段 "5 分钟跑通 baseline 场景" 的命令清单
- 把场景跑通作为 Phase 0 验收项，而不仅是代码存在

---

### 3.8 `ChatCompletionRequest.user` 字段的语义冲突风险

**位置**：[`shared/src/types/index.ts:107`](packages/shared/src/types/index.ts:107)

新增了 `user` 字段（OpenAI 兼容）。但 OpenAI 的 `user` 字段用途是 "A unique identifier representing your end-user, which can help OpenAI to monitor and detect abuse"，和我们用它做 session key 的语义不完全对齐。

**影响**：
- 不同用户共享同一 API key 时，都可能用相同 `user` 值（比如应用的匿名 ID），导致粘性串错
- 或者同一用户跨会话，但 `user` 相同，会错误地粘到一起

**修复建议**：
- 短期：明确文档 `user` 字段应该随 session 变化（应用层负责）
- 长期：鼓励客户端用显式 `session_id`

---

## 4. Mock Seller 平台（未深入审查）

看了目录结构，文件齐全：
```
mock-seller.ts, mock-seller.config.ts, mock-cluster.ts,
scenario-runner.ts, scenarios/{baseline,seller-failover,
load-spike,dht-stale,session-stickiness}.ts
```

**未验证项**：
- 是否能真的起起来跑通（没看到 README 或 package.json script）
- scenario-runner 的退出码是否正确反映成败
- 是否和真实 libp2p 协议兼容（或只 stub 了协议）

**建议**：让同事提供一个"本机跑通 baseline 场景"的 demo 视频或输出截图，作为 Phase 0 验收的一部分。

---

## 5. 上线前必做的清单（给同事）

修完本审查的 §1（共 3 项）后，按如下节奏推进：

### Step 1：本地验证
- [ ] 修 §1.1（Hard Filter 应用到 sticky 路径）
- [ ] 修 §1.2（日志 candidatesRaw 用真实值）—— 随 §1.1 一起
- [ ] 修 §1.3（sticky not-in-top-N 不立即删除）
- [ ] 补 §3.4 的测试用例
- [ ] 本地跑通 `scenario-runner baseline` 和 `scenario-runner session-stickiness`

### Step 2：空跑验证（mode=new, rolloutPct=0）
- [ ] 部署到自己机器，跑 24 小时
- [ ] 检查 `[SCHED]` 日志：所有条目 `rolledOut: false`、`selectionReason: "legacy"`
- [ ] 检查请求成功率与 legacy 无差异
- [ ] 检查 `SchedulerConfigManager` 的 config 文件热加载能正确生效

### Step 3：5% 灰度
- [ ] 本地文件设 `rolloutPct: 5`，观察 1 小时
- [ ] 检查 5% 流量 `rolledOut: true`、`selectionReason: "top_n"` 或 `"sticky"`
- [ ] 检查无异常 fallback（`[SCHED] New scheduler path failed` 应该为 0）
- [ ] 检查 sticky hit rate 开始出现正值

### Step 4：kill switch 演练
- [ ] `echo '{"killSwitch":true}' > ~/.clawmarket/scheduler.json`
- [ ] 5 秒内确认日志显示 `rolledOut: false`
- [ ] 恢复 `killSwitch: false`

### Step 5：再放量
如上一步都 OK，按 25% → 50% → 100% 节奏放量，每级观察至少数小时。

---

## 6. 总评

| 维度 | 评分 | 备注 |
|---|---|---|
| 架构契合度 | ★★★★★ | 完全按照实施文档分层 |
| Fail-safe 保护 | ★★★★★ | 异常自动回退 legacy 做得很到位 |
| 代码风格 | ★★★★☆ | 清晰、现代 TS 风格，偶有可简化处 |
| 测试覆盖 | ★★★★☆ | 核心路径都有，缺几个边界用例（§3.4） |
| 协议兼容 | ★★★★★ | 零破坏性改动 |
| 功能正确性 | ★★★☆☆ | §1.1 是实质 bug，必须修 |
| 观测质量 | ★★★★☆ | 结构化日志完善，reason 枚举待细化（§2.2） |
| 文档/可维护性 | ★★★☆☆ | Mock seller 缺启动说明（§3.7） |

**结论**：
- 同事的实现**整体很靠谱**，骨架和安全机制都对
- §1.1 是唯一必须修的功能 bug（价格/声誉约束在 sticky 备选路径被绕过）
- §1.2、§1.3 是 sticky 路径的配套修正
- 其他 §2、§3 是观测精度和健壮性改进，不阻塞灰度

**修完 §1 可以安全进入 rolloutPct=0 的空跑阶段**；修完 §2 后可以进入 5% 灰度。

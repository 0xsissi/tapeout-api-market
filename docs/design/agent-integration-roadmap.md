# Agent 集成能力差距分析 + 改造路线

> **目的**：系统评估 Tapeout API Market 当前架构对 AI agent 的友好度，列出真实 blocker，给出 12 个月改造路线
> **结论**：架构方向正确（钱包 = 身份、EIP-712、USDC 结算都是 agent 原生），但今天的实现 agent 还用不起来。需要按 P0-P4 做五轮改造
> **为什么重要**：白皮书里 "Agent Economy 基础设施" 是我们最大的未来叙事。如果这条叙事不能在 Mainnet 启动时就有可演示的执行路径，叙事本身会失效

---

## 1. 评估框架

一个 AI agent 真正能用起来某个 AI API，需要在以下 10 个维度上都过关：

1. **Identity / Auth** — 机器能否生成/管理身份？
2. **Payment** — 机器能否无人干预地充值、签名、扣款？
3. **Transport** — agent 的运行环境能否承载这套通信协议？
4. **Latency** — 首次请求和稳态请求延迟是否在 agent 预算内？
5. **Cost Discovery** — agent 能否查询模型价格做预算规划？
6. **Streaming** — SSE 流式是否端到端可靠？
7. **Concurrency** — 一个 agent 并发打出 100 个请求不会崩？
8. **Retry / Idempotency** — 重试语义对 agent 清晰？
9. **Integration** — 主流 agent 框架有 adapter？
10. **Safety Boundary** — 钱包被攻破时损失可控？

---

## 2. 逐项打分（当前状态）

| 维度 | 状态 | 说明 |
|---|---|---|
| 1. Identity / Auth | ✅ 合格 | 钱包私钥即身份，无 KYC，机器友好 |
| 2. Payment (签名) | ✅ 合格 | EIP-712 Authorization 完全程序化 |
| 2. Payment (充值/gas) | ⚠️ 部分 | 首次 deposit 要 ETH，无 gasless onboarding |
| 3. Transport | ❌ 不合格 | **必须本地跑 libp2p**，serverless/edge/浏览器都不行 |
| 4. Latency (冷启动) | ❌ 不合格 | 首次 2-3 秒（DHT bootstrap + stream 建立） |
| 4. Latency (稳态) | ✅ 合格 | 缓存命中后 < 50ms 路由开销 |
| 5. Cost Discovery | ❌ 不合格 | 无 `/v1/models` pricing 聚合 API |
| 6. Streaming | ⚠️ 未验证 | SSE 透传路径存在但无测试覆盖 |
| 7. Concurrency | ⚠️ 未验证 | 调度器设计上支持，未做 100+ 并发压测 |
| 8. Retry / Idempotency | ⚠️ 部分 | 有 request_id 但无语义保证（重试是否会双扣？） |
| 9. Integration | ❌ 不合格 | LangChain / LlamaIndex / Vercel AI SDK 均无 adapter |
| 10. Safety Boundary | ❌ 不合格 | 无支出上限、无可疑行为熔断、无多签授权 |

**总体判断**：10 项中 2 项合格、3 项部分合格、5 项不合格。

**Mainnet 启动前必须至少补齐 "不合格" 项到 "部分合格"**，否则 agent 场景无法演示。

---

## 3. 最严重的 Blocker（按影响面排序）

### Blocker 1: 必须本地跑 consumer-gateway / libp2p【致命】

**影响**：这一条直接让我们无法进入 80% 的 agent 运行环境：
- Vercel Functions / AWS Lambda / Cloudflare Workers：不允许常驻进程
- OpenAI GPTs / Claude Projects / Cursor：只能发 HTTPS
- 容器化的短生命周期 worker：冷启动成本不可接受
- 浏览器内 agent：根本不能跑 libp2p

**根本原因**：DHT 发现需要常驻进程维持 peer 连接。冷启动 bootstrap 需要 3-10 秒，agent 调用预算通常 100ms。

**这是最大的 blocker，优先级 P0，其他问题都是次要的。**

### Blocker 2: 无 hosted gateway

跟 Blocker 1 一起出现。即便开发者愿意绕过 serverless 限制，也不愿自己运维 P2P 节点——那不是他们的核心业务。

OpenRouter 成功的 50% 来自**开发者只需要换一个 URL**。我们今天让他们装 Node + 跑 libp2p + 管 escrow。这个摩擦对人类开发者劝退 90%，对 agent 直接不可用。

### Blocker 3: 首次请求 2-3 秒延迟

冷启动路径：
```
agent 起 consumer-gateway
  → libp2p bootstrap (2s)
  → DHT findProviders 首次 (~500ms)
  → libp2p stream + Noise 握手 (~200ms)
  → 发第一个请求
```
总计 2-3 秒首字节，agent workflow 预期 <200ms（OpenAI 直连基准线）。

### Blocker 4: 无 agent-native SDK

开发者今天要接入只有两条路：
- 用 CLI（TUI 界面，agent 不可用）
- 自己读 HTTP API + 手写 EIP-712 + 管 DHT

没有像 `openai-python` / `anthropic-ts` 那样的一等 SDK。

### Blocker 5: Gas 管理

首次 deposit 要少量 ETH 付 gas。agent 全自动场景下这点 ETH 从哪儿来？没有现成的 gasless onboarding。

### Blocker 6: 钱包安全边界

agent 钱包被攻破 = 全部 escrow 余额被花光。今天无：
- 每个 agent session 支出上限
- 可疑行为熔断
- 大额授权的 human-in-loop 选项

给 agent 配私钥的默认行为今天是不安全的。

### Blocker 7: 无模型目录和价格发现

agent 做 cost-aware routing（困难问题用 Opus、简单的用 Haiku）需要：
- `/v1/models` 返回所有模型 + 实时最低价
- 估算本次请求成本（token × 单价）

今天定价是 **per-provider 独立定价、动态变化**，无统一查询接口。agent 无法做 budget 规划。

### Blocker 8: Streaming 未验证

agent 应用 streaming 是刚需。路径：
```
provider → libp2p stream → consumer-gateway → HTTP SSE → agent
```
中间经过 P2P 和 HTTP 两层缓冲，**端到端无 buffering 流式透传是否真能做到，无测试覆盖**。

### Blocker 9: Retry 语义不清

agent 框架通常会内置重试。如果 agent 框架重试 → consumer-gateway 也重试 → 同一逻辑请求可能被两个 provider 都执行并结算，**用户被双扣**。

今天的 `request_id` 字段存在，但**没有在合约层做 idempotency 保证**。Provider 端也未做 "已处理过的 request_id 拒绝重复执行"。

### Blocker 10: 框架生态未对接

LangChain、LlamaIndex、Vercel AI SDK、Anthropic MCP、OpenAI Agents SDK 这些主流 agent 框架，**没有一个有 Tapeout API Market 的 adapter**。开发者听说了我们也用不起来。

---

## 4. 改造路线：P0 → P4

### P0：Hosted Gateway 【必做，解决 Blocker 1 + 2 + 3】

**做什么**：我们自己运维公开的 hosted consumer-gateway，agent 通过纯 HTTPS 访问，不需要本地跑任何 P2P 进程。

**架构**：
```
Agent → https://gateway.clawmarket.xyz/v1/chat/completions
          │  headers:
          │    Authorization: Bearer <EIP-712-signed-permit>
          │    X-Claw-Request-Id: <uuid>
          ↓
       Hosted Gateway (我方运营)
          │  验证签名 → 选 provider → 转发 → 返回
          ↓ (libp2p)
       P2P Provider Network
```

**关键设计原则**：
- **不托管资金**：gateway 不持有用户私钥。所有扣款必须是用户预签的 EIP-712 Authorization。gateway 作恶最多只能 "路由到差 provider"，不能花用户钱
- **可替换**：代码开源，任何人可以自建 gateway。用户改 URL 就能切换。不形成单点依赖
- **无权限**：不做 KYC、不限制模型、不限制国家。任何持钱包的客户端都能用
- **透明收费**：收 0.1% 路由费补贴运营（原 1% 协议费之上），可关闭（开发者自建 gateway 时为 0）

**与"去中心化"叙事的一致性**：
- Ethereum 有 Infura / Alchemy 这些 hosted RPC，不妨碍它是去中心化协议
- Gateway 是**可选性能优化层**，不是**信任必要条件**
- 在白皮书 §3（协议设计）里明确说明："Gateway is optional infrastructure, not a protocol dependency"

**实施细分**：
- [ ] 部署一个可运行的 consumer-gateway（复用现有代码）在云服务器（AWS / Cloudflare）
- [ ] 把 EIP-712 签名从 CLI 抽出为独立 library（packages/auth），可被 gateway 验证
- [ ] HTTP API 扩展：支持 `Authorization: Bearer <signed-permit>` header 而不是只支持本地钱包
- [ ] Rate limiting 按签名者钱包地址做
- [ ] 监控 / alerting：gateway 下线时客户端能自动 fallback 到本地模式或其他 gateway

**工作量估计**：2-3 周（需要云基础设施 + 监控 + 高可用）

**验收**：
- 用纯 `curl` + 预签的 EIP-712 permit 能完成一次完整推理调用
- Vercel Functions 里的 agent 能接入，冷启动总延迟 < 300ms
- Gateway 本身宕机时，用户资金 100% 安全可提

### P1：Agent SDK (TypeScript + Python)【必做，解决 Blocker 4 + 6 + 9】

**目标**：让 agent 接入变成三行代码。

**TypeScript API**：
```ts
import { TAM } from '@clawmarket/agent-sdk';

const claw = new TAM({
  privateKey: process.env.AGENT_PRIVATE_KEY,
  gateway: 'https://gateway.clawmarket.xyz',   // 默认就是官方 gateway
  // Safety boundaries
  maxSpendPerHour: 10,       // USDC，超过熔断
  maxSpendPerRequest: 0.5,   // USDC，单次超过要 callback 确认
  onLargeSpend: (amount, details) => true,  // 可选 human-in-loop
});

// OpenAI 完全兼容
const response = await claw.chat.completions.create({
  model: 'gpt-4',
  messages: [...],
});

// Streaming 也一样
for await (const chunk of claw.chat.completions.createStream({...})) {
  process.stdout.write(chunk.choices[0].delta.content ?? '');
}

// Cost awareness
const estimate = await claw.estimateCost({
  model: 'claude-3-opus',
  inputTokens: 1500,
  expectedOutputTokens: 800,
});
// { usd: 0.042, provider_count: 47, cheapest_provider_region: 'apac' }
```

**SDK 内部处理**：
- 自动 deposit 管理（余额低于阈值时调用 signer 自动补仓；也可关闭改为手动）
- EIP-712 Authorization 自动预签 + 滚动刷新（5 min TTL）
- **幂等性保证**：每个请求生成 UUID v7，同一 UUID 重试在 gateway / provider 侧去重
- 内置重试策略（指数退避、circuit breaker）
- 支出上限熔断（本地计数 + 链上余额双检查）
- 错误类型分类：可重试 / 用户错误 / 网络错误 / 余额不足 / 版本过期

**Python API**（对等）：
```py
from clawmarket import TAM

claw = TAM(
    private_key=os.environ["AGENT_PRIVATE_KEY"],
    max_spend_per_hour=10,
)

response = claw.chat.completions.create(
    model="gpt-4",
    messages=[...],
)
```

**工作量估计**：TS 2 周，Python 1 周（API 镜像 TS 设计）

**验收**：
- `npm create clawmarket-agent` 模板一条命令起一个能跑的 agent demo
- SDK 在 jest / pytest 里覆盖所有错误路径
- 发 npm / pypi

### P2：幂等性 + 安全边界【关键，解决 Blocker 6 + 9】

这些要改到 gateway 和 provider 协议层，不是只改 SDK。

#### 2.1 链上幂等保证

**做什么**：EscrowPool 合约增加 `(buyer, nonce) → settled_amount` 映射。同一个 nonce 不能被 claim 两次。

```solidity
mapping(address => mapping(uint256 => uint256)) public settledNonces;

function claim(Authorization calldata auth, uint256 actualAmount) external {
    require(settledNonces[auth.buyer][auth.nonce] == 0, "already settled");
    require(actualAmount <= auth.maxAmount, "over cap");
    settledNonces[auth.buyer][auth.nonce] = actualAmount;
    // ... 转账
}
```

结合 SDK 的 UUID v7 → 每个 agent 请求一个 nonce。网络层重试不会产生双扣。

#### 2.2 Session 支出上限

**做什么**：EscrowPool 增加 `SpendingLimit` 结构，buyer 可以为某个 provider 签署"24 小时内累计不超过 X USDC"的规则。Provider claim 时合约强制检查。

```solidity
struct SpendingLimit {
    address buyer;
    address provider;  // 0x0 = 对所有 provider
    uint256 maxPerWindow;
    uint256 windowSeconds;
    uint256 expiresAt;
    bytes signature;
}
```

给 agent 一个"我永远不会一次花超过 10 USDC"的合约级保证，即使私钥被偷、SDK 被劫持。

**工作量估计**：合约改动 1 周 + 审计 + 客户端/SDK 适配 1 周

### P3：LangChain / LlamaIndex / Vercel AI SDK Adapter【大幅降低接入门槛】

**做什么**：向三大主流 agent 框架提 PR，让 `ChatClawMarket` 成为 `ChatOpenAI` 的同等选项。

```ts
// LangChain
import { ChatClawMarket } from '@langchain/clawmarket';
const model = new ChatClawMarket({ model: 'claude-3-opus' });

// Vercel AI SDK
import { clawmarket } from '@ai-sdk/clawmarket';
const result = await generateText({
  model: clawmarket('gpt-4'),
  prompt: '...',
});
```

**为什么这一步收益极大**：
- LangChain 有 10 万+ 周下载开发者
- Vercel AI SDK 是 Next.js 生态默认选择，Vercel 官方推广
- 这些框架的 agent 用户基本上就是 Tapeout API Market 的完美目标用户

**工作量估计**：每个框架 3-5 天（包括 review 和 merge 周期，总周期 1-2 个月）

### P4：Gasless Onboarding【摩擦终极消除，解决 Blocker 5】

**做什么**：agent 首次 deposit 时，我方 gateway 代付 gas，从 deposit 金额里扣回。

**技术路径**：
1. USDC 本身支持 EIP-2612 permit（Circle 官方实现）。agent 签一个 permit → gateway 用该 permit 调 `transferFrom` 存入 EscrowPool → gateway 付这笔 gas
2. Deposit 10 USDC → 实际入账 9.98 USDC，0.02 USDC 补偿 gateway gas 成本（透明显示）
3. 对 agent：**"我签个名就 onboard 了"，零 ETH 负担**

这不是原创设计，是 Aave / Uniswap 的现代标准做法。需要的基础设施（meta-transaction relayer）成熟。

**工作量估计**：1 周（合约改动 + gateway relayer 逻辑）

### P5：Model Catalog API【Nice-to-have，但显著提升 agent 能力】

**做什么**：`GET /v1/models` 返回聚合统计。

```json
{
  "data": [
    {
      "id": "gpt-4",
      "display_name": "OpenAI GPT-4",
      "pricing": {
        "input_per_1m_usd": 8.5,
        "output_per_1m_usd": 25.0,
        "cheapest_provider_region": "apac"
      },
      "performance": {
        "median_ttft_ms": 180,
        "p95_ttft_ms": 850,
        "availability_30d": 0.998
      },
      "market": {
        "active_providers": 47,
        "total_volume_30d_usd": 120000
      }
    }
  ]
}
```

实现：对 DHT announcements 做聚合统计，gateway 侧缓存 1 分钟。

**工作量估计**：1 周

---

## 5. 交付时间表

对应白皮书 §7 的 Roadmap，调整后的正确顺序：

### Phase 1.5（夹在 Phase 1 和 Phase 2 之间）：Hosted Gateway + SDK

**时间**：Q2-Q3 2026，**必须在 Mainnet TGE 前完成**

- P0 Hosted Gateway
- P1 Agent SDK (TS)
- P2 合约幂等 + 支出上限
- P5 Model Catalog API

**验收**：一个演示 video，内容是 Vercel Functions 里跑的 agent 用三行 SDK 代码调用 Tapeout API Market，全程无本地 P2P 进程。

### Phase 2：Mainnet v1（重定义）

- 所有 Phase 1.5 能力在主网可用
- CLAW TGE
- **能演示 agent 用例**，不只是人类用户

### Phase 3：Framework Integration（重定义）

**时间**：Q4 2026

- P3 LangChain + LlamaIndex + Vercel AI SDK 官方 adapter
- P1 Python SDK
- P4 Gasless onboarding

### Phase 4：Agent 经济扩展

**时间**：2027+

- Python SDK 全量功能对齐 TS
- Anthropic MCP server（让 Claude 直接调用 Tapeout API Market 作为 tool）
- OpenAI Agents SDK 适配
- AgentPay 标准：agent-to-agent 结算协议

---

## 6. 不做什么（明确边界）

避免路径散开，明确**我们不做**的事：

- ❌ 不做类似 Infura 的付费 RPC 服务（gateway 是基础设施不是产品）
- ❌ 不做 agent 框架本身（已有太多成熟选择，我们做适配器就好）
- ❌ 不做账户抽象（ERC-4337 钱包）—— 借用生态已有的（Biconomy、Safe）
- ❌ 不做自建 chain / rollup —— Base 就是最好的选择（低费、EVM 兼容、已集成）
- ❌ 不做 agent 身份系统（Soulbound、DID）—— EOA 钱包就够用

---

## 7. 成功度量

12 个月后评估以下指标：

| 指标 | 目标 |
|---|---|
| Hosted gateway 月活钱包地址 | > 1,000 |
| Agent SDK 月下载量 (npm + pypi) | > 10,000 |
| 通过 hosted gateway 的月请求数 | > 10M |
| LangChain / Vercel AI SDK 官方 registry 有我们 | ✅ |
| 至少 3 个公开的 agent 产品以 Tapeout API Market 为默认 backend | ✅ |
| Gateway 是否有过托管用户资金？ | ❌（安全红线） |

---

## 8. 与白皮书叙事的对齐

白皮书 §2.3(3) "承载 AI agent 自主交易" 叙事必须**同时更新**，不再是纯未来画饼：

> "今天 Tapeout API Market 已经在协议层具备 agent 原生的所有基础能力（钱包身份、EIP-712 预签、USDC 结算、无 KYC、链上 idempotency）。正在建设的 hosted gateway 和 agent SDK 将让这些能力在 Mainnet 启动时对 agent 开发者一键可用。我们的路线图把 agent 场景从 2027 年的 'nice to have' 提前到 2026 年 Mainnet 启动时的 'day-one feature'。"

这让 agent economy 从**概念叙事**变成**可验证的执行路径**——对投资人、开发者、合作伙伴都是更可信的沟通。

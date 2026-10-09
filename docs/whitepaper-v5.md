# Tapeout API Market Whitepaper V5

## 去中心化 AI 推理市场协议
### A Permissionless Market Protocol for AI Inference

---

## 0. 一句话定位

**Tapeout API Market 是一个无需许可、链上结算、AI agent 原生可参与的 AI 推理服务市场协议。**

它不是"区块链版 OpenRouter"，而是一个在 AI 供给长尾化、agent 自主交易成为主流的未来，**唯一能够承载该市场的基础设施层**。

---

## 1. 摘要

过去两年，AI API 聚合市场（OpenRouter、AI/ML API 等中心化中转站）已经证明这是一个**年交易额数十亿美元、增速超过 10x / 年**的真实市场。但所有现有玩家都是中心化公司，这在一个正在快速演化的行业中存在三个无法逾越的结构瓶颈：

1. **供给端封闭**：只有能通过 KYC/合规审核的机构才能成为供给方。全球存量数百万个闲置的 ChatGPT Team 座席、未使用的 Anthropic 额度、私人自托管的 Llama 节点，全部无法进入市场。
2. **需求端受限**：缺乏银行服务、被支付渠道拒绝、所在司法辖区被制裁的用户（全球 20 亿人口量级）无法消费这些服务。
3. **Agent 经济不兼容**：自主 AI agent 无法完成 KYC、无法持有信用卡、无法处理 chargeback 争议——它们需要一个**机器原生的市场**。

Tapeout API Market 用四个具体的技术决策（P2P 发现、EIP-712 Authorization 预签授权、EscrowPool 链上托管、Claim Batching 清算）解决这些结构问题，并通过四阶段递减发行的 CLAW 代币 bootstrap 供给侧。

**核心数据目标**（24 个月内）：
- 月活 seller 节点 ≥ 10,000
- 月结算额 ≥ 5,000 万美元
- 协议年化收入（1% 费率）≥ 600 万美元
- 覆盖模型 ≥ 200 个（含 OpenAI/Anthropic/Google 官方 + 开源自托管）

---

## 2. 市场：一个被低估的结构性机会

### 2.1 现状数字

- **全球 LLM API 市场**：2024 年约 65 亿美元，预计 2027 年达 360 亿美元（CAGR 77%）
- **API 聚合中转市场**：已知公开数据的 OpenRouter 2024 年月处理量从 Q1 的 6B token/天，到 Q4 的 40B+ token/天，**一年 6 倍**
- **未被服务的长尾供给**：全球 ChatGPT Team 活跃座席 ≈ 200 万，平均月闲置 quota 价值 ≈ 30 美元，**年化潜在价值 7.2 亿美元**，目前 0% 变现
- **未被服务的长尾需求**：受 OpenAI 服务限制国家 20+（中国、俄罗斯、伊朗、朝鲜、古巴等），仅中国开发者群体年 API 支出保守估算 > 10 亿美元

### 2.2 中心化聚合器已经做到什么

必须诚实承认：OpenRouter、AI/ML API、Together.ai 等玩家已经提供了：
- 统一 OpenAI 兼容接口
- 多模型路由
- 使用 Stripe/信用卡结算
- 基础的故障切换

**如果你只想做"一个便宜的 OpenRouter"，那没有意义**。中心化聚合器在既有赛道上有运营效率优势，我们不需要在这个维度竞争。

### 2.3 中心化聚合器做不到什么

以下四件事，**中心化玩家在任何现实假设下都不可能做到**，这就是 Tapeout API Market 的价值源泉：

#### (1) 允许闲置 API 额度持有人自由进入供给侧

OpenRouter 签约上游必须走 B2B 合规流程：实体审查、KYC、合同签订、美元银行账户。一个持有 ChatGPT Team 座席、想把闲置额度变现的个人用户，**永远不可能成为 OpenRouter 的供给方**——这在合规上不可行（违反上游 ToS 的责任谁来承担？法律主体是谁？）。

Tapeout API Market 不同：**供给方自己质押 USDC 作为信誉担保，自己承担上游 ToS 风险，协议只负责撮合和结算**。这不是"钻空子"，而是把合规责任**从协议层下移到参与者层**——这是区块链协议（Uniswap、Aave）都采用的成熟模式。

#### (2) 服务无银行账户 / 被制裁 / 跨境用户

全球约 14 亿成年人没有银行账户。另有约 20 亿人生活在被美国主流支付渠道限制的国家。这些人中有开发者、有企业，他们对 AI API 有真实的付费需求。中心化聚合器走 Stripe/Visa 的路径**无法服务他们**——不是不想，是做了会被切断支付通道。

Tapeout API Market 用稳定币（USDC）直接结算。只要用户能持有 USDC（全球几乎无门槛），就能消费服务。

#### (3) 承载 AI agent 自主交易

**这是最重要的一条，也是 5-10 年维度最大的叙事。**

未来 3-5 年，AI agent 会大规模自主调用其他 AI 服务。一个 coding agent 会自己决定把困难问题 route 给 Claude Opus，简单问题自己解决；一个 research agent 会实时购买不同专家模型的 opinion 做 ensemble。

这些 agent 的行为模式是：
- 秒级决策、小额支付（0.01 美元 / 请求）
- 7x24 无人值守
- 需要建立短期信任（第一次交互就要能交易）
- 可能跨越数千个供给方

**中心化聚合器给不了**：
- 不能给 agent 发信用卡
- 不能给 agent 做 KYC
- 不能处理 agent 和聚合器之间的合同纠纷
- 小额高频的 Stripe 手续费（2.9% + 0.3 美元）经济上不成立

**Tapeout API Market 协议层天然契合**：
- agent 用钱包私钥即身份，毫秒完成签名授权
- EIP-712 Authorization 允许 agent 一次预签 5 分钟授权额度，期间所有请求免签名开销
- 链上结算不可赖账，信任在协议层自动建立
- 单笔 gas 摊到上百次调用（通过 Claim Batching），边际成本趋近于零

**接入层正在建设中**（Phase 1.5，详见 `docs/design/agent-integration-roadmap.md`）：今天的 libp2p 本地节点模式不适合 serverless / edge / 浏览器等典型 agent 运行环境。Mainnet 启动（Phase 2）前必须交付的三件东西：
- **Hosted Gateway**（HTTPS 入口，agent 无需跑本地 P2P 进程）
- **Agent SDK**（TypeScript + Python，三行代码接入，内置支出熔断 + 链上幂等）
- **Gasless Onboarding**（EIP-2612 permit，agent 零 ETH 即可开户）

这一步完成后，agent 场景从"白皮书未来叙事"变成"Mainnet day-one 可演示用例"。

今天我们做的不是"更好的 OpenRouter"，而是**未来 agent 经济的默认结算层**。Visa 之于人类经济，Tapeout API Market 之于 agent 经济。

#### (4) 可验证、可审计、可编程

企业采购 AI 服务有两个隐痛：
- **审计**：某条违规输出是哪个模型、哪次调用产生的？中心化黑盒无法自证
- **SLA 证明**：服务商说自己 99.9% 可用，如何验证？

Tapeout API Market 每次请求的 (request_hash, provider_id, price, latency, success) 四元组上链（聚合后批量上链以节省 gas），企业可以用链上数据独立审计、用智能合约自动执行 SLA 罚则。

---

## 3. 协议设计：已经落地的技术决策

这一节不是"未来愿景"，是**已经写进 Base Sepolia 合约、已经跑在 libp2p 节点上**的设计。

### 3.1 四层架构

```
┌─────────────────────────────────────────────────┐
│  Application Layer                              │
│  OpenAI-compatible HTTP API │ CLI │ SDK │ Agent │
├─────────────────────────────────────────────────┤
│  Market Layer                                   │
│  Scheduler (Hard Filter + Soft Rank + Sticky)   │
│  Reputation & Quality Scoring                   │
├─────────────────────────────────────────────────┤
│  Transport Layer                                │
│  libp2p DHT Discovery │ E2EE Inference Stream  │
├─────────────────────────────────────────────────┤
│  Settlement Layer                               │
│  EscrowPool │ EIP-712 Authorization │ Mining   │
└─────────────────────────────────────────────────┘
```

### 3.2 结算层：EIP-712 Authorization + EscrowPool

**挑战**：AI 推理请求频率极高（一个 agent 可能每秒发多个请求），每次请求都上链结算在 gas 费上不可行；但完全链下结算又失去了不可赖账性。

**Tapeout API Market 的解法**：双层状态机。

```
用户 (buyer)
  │
  │ 1. deposit USDC to EscrowPool (链上，一次)
  │
  │ 2. 对每个 provider 预签 Authorization (EIP-712, 链下)
  │    {buyer, provider, nonce, max_amount, expires_at}
  │    有效期 5 分钟，额度 ≤ 已存余额
  │
  ▼
Provider (seller)
  │
  │ 3. 收到请求 + 签名 → 验证授权 → 执行推理 → 累积 claim
  │
  │ 4. 批量结算：N 次请求累积为一个 claim batch (最多 100 条)
  │    一次交易结算上百次推理，gas 摊平到 ~ $0.001 / 请求
  │
  ▼
EscrowPool 合约
  - 验证签名有效性
  - 从 buyer 余额扣款
  - 转入 provider 可提现余额
  - 提取 1% 协议费
  - 发射事件供链下索引
```

**为什么这个设计关键**：
- Buyer 不需要每次请求上链，体验等同 Web2 API
- Provider 的收款不可赖账：只要授权签名有效，合约强制转账
- 协议无法 rug pull：EscrowPool 是不可升级合约，协议方无法挪用资金
- 48 小时提现延迟给了争议处理窗口（信誉系统检测到恶意行为可触发仲裁）

（已部署合约地址：`EscrowPool = 0xE3cb7b0F...DCb5`，Base Sepolia；主网上线见 §8 Roadmap）

### 3.3 传输层：libp2p + DHT + E2EE

**发现**：Provider 通过 Kademlia DHT 广播自己的 `Announcement`（peerId, 模型列表, 定价, 质押, 地区）。Buyer 在本地 DHT 缓存中查询 `findProviders(model)`，返回候选节点列表。

**为什么不用中心化服务发现**：
- 中心化列表可被审查 / 下线
- 新 Provider 接入无需许可（不需要向中心化注册表申请）

**端到端加密**：Buyer 和 Provider 的推理流在 libp2p 之上运行一层 Noise Protocol 加密。即使协议运营方、网络中的 relay 节点、Provider 的 ISP，都无法窥探请求内容。

这不是可选项，是**服务受限地区用户能放心使用**的前提。

### 3.4 市场层：Hard Filter + Soft Rank + Session Sticky

这一层决定了用户体验和单位经济学。设计原则：

- **Hard Filter（硬过滤）**：任何不满足用户价格上限、成功率 > 95%、质押金额 > 100 USDC、信誉分 > 阈值的 Provider，**绝对排除**。保证用户承诺的价格、质量下限始终成立。
- **Soft Rank（软排序）**：在硬过滤后的池子里，综合价格、延迟、历史成功率、KV cache 命中预期打分。
- **Session Sticky（会话粘性）**：同一个用户会话（识别方式：显式 session_id > API user 字段 > prompt prefix hash）优先路由到上一次成功的 Provider。**提升 KV cache 命中率 30-60%，直接降低成本**。
- **Top-N 预选**：预计算 3 个候选，主 Provider 失败时零延迟切换备选。

（详细算法和工程 trade-off 见内部设计文档 `docs/design/scheduling-design.md` 和 `scheduling-phase-0-1-implementation.md`，已实现并通过 40 项单元测试）

### 3.5 信誉系统

每次结算的质量数据（TTFT、成功/失败、争议率）通过链下聚合 + 定期上链的方式更新 Provider 信誉分。低分 Provider 自动被调度层排除，高分 Provider 获得更多流量和挖矿权重。

质量乘数（已实现在 mining 合约）：
- TTFT < 300ms → 1.5x
- TTFT < 500ms → 1.2x
- TTFT < 1000ms → 1.0x
- TTFT > 1000ms → 0.5x

---

## 4. 代币经济学

### 4.1 CLAW 的三个功能

1. **Provider 质押担保**：最低 100 USDC 等值的 CLAW 才能加入供给侧。作恶时被 slash。
2. **流动性挖矿奖励**：Buyer 每支付 1 USDC 结算，协议按当前阶段发行率 mint CLAW 奖励给 Provider。
3. **治理**：协议参数（费率、质押门槛、仲裁规则）由 CLAW 持有者投票决定（Phase 4 启用）。

### 4.2 四阶段递减发行（已编码在 Mining 合约）

| 阶段 | 累计结算额门槛 | 发行率 (1 USDC → CLAW) |
|---|---|---|
| Phase 1 | < $1M | 100 |
| Phase 2 | $1M – $5M | 50 |
| Phase 3 | $5M – $20M | 25 |
| Phase 4 | > $20M | 10（长期均衡） |

**设计理由**：
- 早期高发行率补贴供给侧，解决冷启动问题（供给方愿意赔本或低毛利进入）
- 随着网络规模增长，代币补贴自然降低，引导经济向"真实手续费收入"驱动切换
- 总发行上限由累计结算额决定，不是时间——**代币发行与真实经济活动严格绑定**，不存在凭空稀释

### 4.3 协议收入与代币价值捕获

- 每笔结算提取 1% 作为协议费（PROTOCOL_FEE_BPS = 100 bps）
- 协议费流向：70% 进入 Staking Reward Pool（分给质押 CLAW 的参与者）、20% 进入 Treasury（由 DAO 支配）、10% 回购销毁
- 这意味着 **CLAW 持有者是协议的经济终局受益人**：网络结算额 = 协议收入 = 持币者价值

### 4.4 单位经济学示例

假设网络达到月结算 500 万美元（24 个月目标的 1/10）：
- 月协议费：50,000 USDC
- 年化：600,000 USDC（约 60 万美元）
- 回购销毁：60,000 USDC / 年（持续通缩压力）
- Staking 分红：420,000 USDC / 年

在 10 亿 CLAW 流通假设下，年分红 = ~$0.00042 / token，支撑代币估值有数学基础。

---

## 5. 竞争格局与壁垒

### 5.1 位置

```
                  专业 / 垂直
                      ▲
                      │
     Bittensor ●      │      ● TAM
     (训练+推理,        │      (推理市场协议,
      模型主观评分)      │       客观结算)
                      │
  ────────────────────┼────────────────────
    中心化             │             去中心化
                      │
     OpenRouter ●     │      ● Akash / io.net
     (聚合商, 人类用户) │      (raw compute, 自建模型)
                      │
                      ▼
                  通用 / 基础
```

**关键差异**：
- vs **OpenRouter**：我们是协议不是公司，供给侧无许可，能服务 OpenRouter 法律上不能服务的用户和 agent
- vs **Akash / io.net**：他们卖 GPU 时间，用户要自己部署模型；我们卖"即用的 AI API"，UX 高一个量级
- vs **Bittensor**：他们的 subnet 机制在客观评估（"这个回答好吗"）上有噪声；我们直接绑定可度量的商业指标（结算额、成功率、延迟）
- vs **自建协议的聚合器**（若有）：我们的先发优势 + 已落地的技术栈

### 5.2 长期壁垒（Moat）

**(1) 双边网络效应**
Provider 越多 → 价格越有竞争力 + 可用性越高 → Buyer 越多 → 更多 Provider 愿意加入。先达到最小可行规模的协议获得自我强化的增长。

**(2) 信誉数据累积**
两年内累积的数亿条 (request, provider, quality) 数据构成 fork 不走的资产。Fork 一份代码容易，fork 不走的是"谁的模型在哪些场景下表现最好"的实战数据。

**(3) Agent 原生 → 切换成本指数增长**
一旦 agent 生态把 Tapeout API Market 集成为默认市场层，迁移意味着每个 agent 开发者都要改接入。与此类比：Uniswap V2 之后，新 fork 即使费率更低也难以撼动，因为整个 DeFi 基础设施（aggregator、lending、衍生品）都 integrate 了 Uniswap。

**(4) 合规套利的时间窗口**
中心化公司越走向成熟，合规负担越重（2025 年欧盟 AI Act 已实施）。去中心化协议在这个维度上有持续扩大的差距——这不是"有优势"，这是**只有去中心化架构才能承接的那部分需求**。

---

## 6. 风险与应对

坦诚写出来，比遮掩好：

### 6.1 监管风险

**风险**：代币可能被认定为证券；协议可能被认定为未注册的金融基础设施。

**应对**：
- 协议本身不运营、不收款、不做客户服务——所有功能在链上合约，发起人无法关停
- 代币发行与真实经济活动绑定，不是 pre-sale ICO
- 治理早期逐步下放到 DAO（Phase 4）
- 预留 legal opinion 预算，Delaware 或新加坡设立基金会持有协议早期权益

### 6.2 上游 ToS 风险

**风险**：OpenAI/Anthropic 可能封禁大批量转售的账号。

**应对**：
- 协议本身不关心上游是谁，只匹配供需
- 供给方自行承担账号风险，协议的 slashing 机制让"作恶被上游封禁导致服务中断"的损失由作恶方承担
- 长期：引导供给侧向自托管开源模型倾斜（Llama、Qwen、DeepSeek），降低对 API 转售的依赖

### 6.3 冷启动风险

**风险**：供给和需求双边市场，没有任何一边会因为对面不存在而先来。

**应对**：
- Phase 1 CLAW 发行率 100x：供给方净毛利 - 运营成本 + 100x CLAW 挖矿奖励 → 即使亏 5% 运营，挖矿覆盖
- 我方做 "founding seller" 保证最低供给（自持 OpenAI/Anthropic 账号作 bootstrap provider）
- Buyer 侧：CLI + OpenAI 兼容 SDK 让开发者一行代码接入（`OPENAI_BASE_URL=https://...`）

### 6.4 技术风险

**风险**：EIP-712 签名漏洞、escrow 合约 bug、P2P 网络攻击。

**应对**：
- 合约经 Spearbit / Trail of Bits 审计后才上主网（预算已规划）
- 测试网 6 个月真实用户测试期
- 版本强制升级机制（见 `docs/design/client-auto-update.md`）应对紧急 bug
- 白盒挑战赏金 bug bounty

---

## 7. 进展与路线图

### 已完成（Testnet 阶段）

- ✅ EscrowPool 合约（Base Sepolia 部署）
- ✅ EIP-712 Authorization 预签授权
- ✅ Claim Batching（每笔最多 100 条结算）
- ✅ libp2p 节点 + DHT 发现
- ✅ E2EE 推理流
- ✅ OpenAI 兼容 HTTP API
- ✅ CLI 客户端（`@clawmarket/cli`）
- ✅ Hard Filter + Soft Rank + Sticky 调度器（40 项单测通过）
- ✅ 信誉系统骨架 + 质量乘数
- ✅ Mock seller 测试平台 + 5 个压测场景

### Phase 1 (Q2 2026)：公开 Testnet

- 对外邀请 100+ 真实 seller
- 跑通 $10K 月结算量
- 客户端自动更新 + 紧急版本拦截（见 `docs/design/client-auto-update.md`）
- 合约第三方审计 round 1

### Phase 1.5 (Q2–Q3 2026)：Agent 接入基础设施【Mainnet 前置】

**核心认知**：今天的 libp2p + 本地 gateway 架构对 agent 不友好（serverless / edge 环境不能跑常驻 P2P 进程）。必须在 Mainnet 启动前建好 agent 可用的接入层。详见 `docs/design/agent-integration-roadmap.md`。

- **Hosted Gateway**：公开的 HTTPS 入口，agent 通过纯 REST 访问 P2P 网络（gateway 不托管资金，代码开源、可自建、可替换）
- **Agent SDK (TypeScript)**：三行代码接入，内置支出上限、幂等性、自动 Authorization 刷新
- **合约幂等性**：EscrowPool 增加 nonce 去重，杜绝重试双扣
- **Session 支出上限**：用户可签署"24h 累计不超过 X USDC"的链上级约束
- **Model Catalog API**：统一的 `/v1/models` pricing 聚合，支持 agent cost-aware routing
- **验收**：Vercel Functions 里跑的 agent 用 SDK 调用 Tapeout API Market，冷启动 < 300ms，零本地 P2P 进程

### Phase 2 (Q3 2026)：Mainnet v1

- Base 主网部署
- CLAW TGE（Token Generation Event）
- Phase 1 挖矿启动（100x 发行率）
- **Day-one agent 友好**：SDK、Hosted Gateway、Cost API 同步可用
- 目标：月结算 $100K

### Phase 3 (Q4 2026 – Q1 2027)：生态集成与规模化

- **Agent 框架官方适配**：LangChain、LlamaIndex、Vercel AI SDK 官方 registry 收录
- **Python SDK** 对等 TS 功能
- **Gasless onboarding**：EIP-2612 permit + gateway relayer，agent 零 ETH 即可开户
- **Anthropic MCP server**：让 Claude 直接把 Tapeout API Market 当作 tool 调用
- 跨链扩展（Arbitrum）
- 治理 v1（CLAW 持有者投票协议参数）
- 目标：月结算 $1M

### Phase 4 (2027+)：Agent 经济基础设施

- 完整 DAO 治理
- **AgentPay 标准**：agent-to-agent 自主结算协议（agent 可以作为 provider，不只是 buyer）
- 私有模型市场（企业内部部署的私有 Llama 也能挂单变现）
- 目标：月结算 $50M+

---

## 8. 团队的独特能力（Why Us）

（这一节根据实际情况填写。一份合格的白皮书必须说清楚 "为什么是你们做这件事"：

- 团队成员在 AI / 分布式系统 / 密码学 / 代币经济学方向的履历
- 已经跑过的前序项目 / 数据
- 为什么这个时间点我们的执行路径比别人快

没有这一节的白皮书，投资人和战略伙伴读完只会问 "不错，但为什么是你们而不是别人？"）

---

## 9. 愿景

2030 年，全球 AI 服务市场的主要消费者不再是人类，而是 AI agent。一个 agent 每天发起数千次跨 agent 调用是常态。

在那个世界里：
- **没有**一个中心化聚合器能服务所有 agent（agent 无法 KYC）
- **没有**一个中心化 API 提供商能垄断所有模型（模型变得丰富且专业化）
- **必须有**一个协议层承担撮合、结算、信誉、争议仲裁

**那个协议要么是 Tapeout API Market，要么是 Tapeout API Market 之后的 fork。**

今天我们做的不是"给几万个开发者提供便宜的 API 中转"。今天我们做的是**押注一个特定的未来，并成为那个未来的基础设施**。

---

## 10. 结语

Tapeout API Market 不是为当前市场做微创新的玩家，它是为即将到来的 agent 经济、为被现有体系排除的长尾供需双方、为 AI 服务不可避免的去中心化浪潮，准备的**协议层基础设施**。

这不是一个 "better mousetrap"。这是一个不同的游戏。

---

*本白皮书为 V5 版本。技术细节、合约地址、路线图时间点可能根据实际进展更新。最新版本见 `docs/whitepaper-v5.md`。*

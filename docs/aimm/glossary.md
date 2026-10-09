# AIMM 术语表

> 四个 AIMM 原生术语的正式定义。
> 它们之于 AIMM，就像 Slippage / Impermanent Loss / LP Token / TVL 之于 AMM——**后续所有博客、推文、白皮书、采访都用这些词**，反复使用才能变成行业标准。

---

## 1. Inference Slippage（推理滑点）

### 一句话定义
**买家下单时看到的报价和最终实际支付价之间的差值，通常由单次请求过程中做市商容量利用率变化导致。**

### 为什么会产生
一个长 prompt 的生成过程不是瞬时的。比如生成 5000 tokens 需要 15 秒，在这 15 秒内：
- 其他买家可能同时发起了请求
- 做市商的 u（利用率）从 0.4 爬升到 0.7
- 按 CUC 公式，价格自然上涨

**结果**：买家看到的开盘报价和闭盘结算价不同。差值 = 推理滑点。

### 计算公式
```
Inference Slippage = (实际成交价 - 下单时报价) / 下单时报价
```

### 类比
类似 Uniswap 的价格滑点——大笔交易会把价格推高。区别在于：
- AMM 滑点由**这笔交易本身**引起
- AIMM 滑点由**生成期间的其他并发流量**引起

### 实际数据
目前观测值（仿真）：
- 小 prompt（<1000 tokens）：典型 <1%
- 中 prompt（1000-5000 tokens）：典型 2-5%
- 长 prompt（>5000 tokens）：典型 5-15%

### 如何保护买家
V1 协议支持 **max_slippage 参数**：买家下单时声明"滑点超过 X% 就取消请求"，像 Uniswap 的滑点保护。

### 推文模板
> "Just served a 3000-token Claude request with 3.2% inference slippage. Normal range on a busy AIMM market."

---

## 2. Capacity Decay（容量衰减）

### 一句话定义
**做市商所持有的订阅容量按固定周期重置，未售出部分归零的现象。**

### 为什么存在
AI 订阅（ChatGPT Plus、Claude Max、Codex Pro）的额度都是**期内有效**：
- 日订阅：每 24 小时重置
- 周订阅：每 7 天重置
- 月订阅：每 30 天重置

**如果在重置前没卖出去，就永久消失。** 这是 AIMM 独有的时间压力。

### 和 AMM LP 的区别
| 维度 | AMM LP | AIMM Maker |
|---|---|---|
| 资产类型 | 永久持有（ETH/USDC） | 周期性重置（LLM 额度） |
| 不提供流动性 | 只是少赚手续费 | **本金直接归零** |
| 决策压力 | 慢节奏 | **高频调整 p₀/α 逼着卖出** |

### 对定价策略的影响
Capacity Decay 会**压低**做市商的 p₀（底价）。因为：
- 如果坚持高价 → 重置前卖不完 → 血亏
- 宁可低价出清 → 保底收益

这是为什么 AIMM 的均衡价格通常**低于**官方 API 价格——做市商被迫要在重置前卖出。

### 衍生指标
- **Decay Rate**：未售出容量 / 总容量（越低越健康）
- **Fire Sale Zone**：距离重置时间 < 20% 时，做市商典型大降价区间

### 推文模板
> "AIMM makers face daily capacity decay—unsold Claude tokens evaporate at reset. This is why prices dip 30% in the last 2 hours before daily reset. Free alpha."

---

## 3. Quote Depth（报价深度）

### 一句话定义
**在某个价格水平以下，全网累计可以提供的容量。类似订单簿深度，但由 CUC 曲线自动生成。**

### 计算方式
给定价格水平 `p*`，对每个做市商 i 解出其愿意以 `p*` 卖出的容量上限：

```
由 p* = p₀_i / (1 - u*)^α_i 解出 u*
则该做市商在 p* 的可用容量 = C_i × u*
Quote Depth(p*) = Σ 所有做市商 i 的可用容量
```

### 直观理解
画一条"累计供应曲线"：
- X 轴：价格
- Y 轴：累计可供容量
- 曲线从左下向右上单调递增

**价格越高，愿意卖的容量越多**——和传统订单簿的供应曲线形状一致。

### 为什么重要
1. **给买家看透明度**：下单前知道"如果我愿意多付 10%，能多买多少"
2. **给做市商看竞争**：看到自己在深度图的哪个位置，调整 p₀/α
3. **给协议看健康度**：浅深度 = 供给不足 = 市场需要更多 maker

### 类比
- 订单簿里的 **order book depth**
- 期权市场里的 **implied volatility surface**
- DeFi 里没有严格对应物（AMM 里 depth 由 k 值直接决定，没这么多维）

### Dashboard 示例
```
Claude Sonnet Quote Depth

$2.0  (p_floor)    | ████                         50K tokens/hr
$3.0  (+50%)       | ████████                     120K
$5.0  (+150%)      | ██████████████               340K
$10.0 (+400%)      | ████████████████████████     800K
$20.0 (+900%)      | ██████████████████████████   1.1M (near cap)
```

### 推文模板
> "Live Quote Depth snapshot for Claude Sonnet on AIMM: 340K tokens/hr available at <$5/1M, 1.1M at <$20/1M. Market is thick today."

---

## 4. Maker TTL（做市商存活周期）

### 一句话定义
**一个做市商从上线到被耗尽（订阅额度用完 / 账号被封 / 主动下线）的平均生命周期。**

### 为什么是 AIMM 独有的
传统 AMM 的 LP 可以永久存在（只要不主动提取）。AIMM 做市商的生命周期受三重约束：

1. **订阅周期**：月订阅到期必须续费
2. **上游限流/封号风险**：被 OpenAI/Anthropic 识别异常使用可能封号
3. **经济性**：订阅费 - 卖出收入 < 0 时主动下线

### 观测到的典型值（模拟数据，等 V1 上线补真实数据）

| 上游 | 典型 Maker TTL | 主要风险 |
|---|---|---|
| Codex (ChatGPT Plus) | ~14 天 | 共享检测、IP 风控 |
| Claude Pro/Max | ~21 天 | 速率限制 → 订阅到期 |
| Gemini (Advanced) | ~30 天 | 相对宽松 |
| AI Studio | ~60 天 | 最宽松 |

### 对协议的含义
1. **Maker 池需要持续补充**：不能指望"老客户"撑场子
2. **推荐奖励要设计**：老 maker 拉新 maker 分成，维持供给
3. **声誉系统不能太依赖长历史**：否则新人永远建不起来
4. **买家要预期到 maker 更替**：信任是对"池"的，不是对"个人"的

### 扩展指标
- **Maker Half-Life**：做市商池中有一半被替换的时间
- **Maker Churn Rate**：每周新增 / 流失比例
- **Recovery TTL**：被封号的 maker 换号后重新回到网络的平均时间

### 类比
- 电信行业的 **customer lifetime（客户生命周期）**
- 电池里的 **cycle life（循环寿命）**
- 星际里的 **recruitment ratio（征兵率）**

### 推文模板
> "Codex Maker TTL on AIMM is ~14 days avg. That's why protocol rewards recruiting new makers. Churn is a feature, not a bug."

---

## 使用规范

### 在文档/博客/推文中引用时

- **第一次出现用全称**：Inference Slippage（推理滑点）
- **之后用缩写或简称**：Slippage、IS
- **中文语境优先中文译名**：推理滑点 / 容量衰减 / 报价深度 / 做市商存活周期
- **正式论文/白皮书用英文全称**

### 不要这样用（反例）

❌ "这笔交易有滑点" —— 太模糊，分不清是 AMM 滑点还是 Inference Slippage
✅ "这笔交易有 3% 推理滑点（Inference Slippage）"

❌ "做市商会死" —— 不专业
✅ "做市商 TTL 平均 14 天"

❌ "市场深度不够" —— 对齐 AMM 用词不准
✅ "Quote Depth 在 $5 价位以下只有 80K tokens/hr"

### 推广策略

1. **每周一篇内容用 1 个术语作核心**（四个月可以轮两圈）
2. **Dashboard 用这四个词作主要 KPI**（一图胜千言）
3. **邀请其他项目也用这些词**——定义者吃复利，不要保护术语
4. **做一个 learn.aimm.xyz 词典站**，做官方正典来源

---

*文档版本：v0.1 · 2026-04-22*

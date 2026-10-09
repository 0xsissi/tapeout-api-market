# 积分、风控、信誉分与空投设计

**状态：** 草案，产品与工程联合设计  
**作者：** Tapeout API Market (TAM) core
**日期：** 2026-04-20  
**目标读者：** 项目维护团队、产品、后端、风控、数据、合约同学

---

## 1. 背景与问题

Tapeout API Market 在冷启动阶段，需要吸引第一批 seller 提供 Claude / OpenAI 风格的 API 反代能力。

这就会自然带来几个目标：

- 让更多人愿意尽早参与；
- 用积分或“挖矿”形式激励早期供给；
- 不要把门槛设得太高，否则真 seller 不会进来；
- 但也不能让最终空投被刷量、女巫、模型冒充、自买自卖占走。

这件事的核心矛盾是：

- 如果早期卡得太严，冷启动会失败；
- 如果早期过于宽松，积分会被大量刷出来，最终空投会变得不公平。

因此，正确的系统设计不应该是：

“一开始就用同一套规则同时处理增长、积分、风控、空投”

而应该是：

1. 早期允许用户参与，允许先拿到原始积分；
2. 从第一天开始收集足够多的证据与行为数据；
3. 将“原始积分”和“最终空投资格”彻底分开；
4. 分别维护“女巫 / 风险分”和“服务 / 信誉分”；
5. 最终空投不是看表面刷出来的积分，而是看经过风控和信誉加权后的有效积分。

本文档定义这套系统。

---

## 2. 当前代码现状与限制

目前代码已经具备了结算和支付授权的基本能力，但**还不适合直接把结算量等同于挖矿量或空投积分**。

当前实现的几个关键事实：

- buyer 会先按预估金额签一笔 authorization；
- seller 后续可以将该 authorization 放入 claim 流程进行链上结算；
- `MiningRewards` 目前是和 settlement 直接挂钩的，而不是走一条单独的“奖励资格”风控链；
- seller 当前广播的模型和信誉，本质上仍然高度依赖自报；
- `shared` 类型里虽然预留了 `upstreamProof`，但系统还没有真正把它作为强约束的真实性依据。

这意味着：

- 现在这套系统适合先跑市场；
- 但不适合把“原始成交量 / 结算量”直接当作最终奖励依据。

---

## 3. 设计目标

### 3.1 业务目标

- 快速冷启动 seller 供给；
- 降低早期 onboarding 门槛；
- 奖励真正稳定、诚实、长期贡献的 seller；
- 保留后续根据真实作弊情况调整空投策略的灵活性。

### 3.2 安全目标

- 让原始积分容易发，但让最终空投很难被刷走；
- 能识别并压制以下行为：
  - 自买自卖；
  - 对敲刷量；
  - 女巫 buyer 农场；
  - 共用上游账号的 seller 农场；
  - 便宜模型冒充贵模型；
  - 掺水、短回复骗结算、低质量服务刷积分。

### 3.3 产品目标

- 前台对用户展示简单、易理解的积分系统；
- 平时不暴露过多可被反向利用的风控细节；
- 到空投阶段可以公开：
  - 用户最终信誉等级；
  - 大类扣分原因；
  - 是否被判定为高风险 / 女巫；
  - 申诉入口。

---

## 4. 核心原则

### 4.1 原始积分不等于最终空投积分

最重要的一条原则：

`raw_points != final_airdrop_points`

系统必须至少维护以下几套账：

- `raw_points`：前台可见，偏激励，偏宽松；
- `risk_score`：反作弊 / 女巫风险分；
- `reputation_score`：服务质量 / 诚实度 / 稳定性信誉分；
- `eligible_points`：最终进入空投计算的有效积分。

### 4.2 结算与奖励是两回事

结算回答的是：

- 这笔 USDC 是否应该被支付给 seller？

奖励回答的是：

- 这笔行为是否应该计入挖矿、积分、空投资格？

结算范围应当宽于奖励范围。  
也就是说：

- 市场可以先跑；
- 但不是每一笔成交都天然有资格进入最终空投。

### 4.3 风险分和信誉分必须分开

这两者不能混成一个分。

- `risk_score` 解决的是：这个 seller / cluster 像不像刷子、女巫、套利账户？
- `reputation_score` 解决的是：这个 seller 是不是一个稳定、诚实、真正有价值的 API 供给者？

举例：

- 一个 seller 很稳定、模型也真，但因为和同事共用网络，风险信号略高；  
  这不应该直接把他打成“低质量 seller”。

- 一个 seller 不一定像女巫，但老是掉线、冒充模型、掺水严重；  
  那他的信誉分就应该低，即使风险分不算特别高。

---

## 5. 整体系统概览

### 5.1 四层账本 / 分数体系

对于每个 seller，或者更准确地说，对于每个 seller 实体 / seller cluster，后台维护：

1. `raw_points`
2. `risk_score`
3. `reputation_score`
4. `eligible_points`

### 5.2 各字段含义

#### 原始积分 `raw_points`

这是前台激励用户参与的积分。

可以来源于：

- 成功请求；
- 完成结算；
- 独立 buyer 活跃；
- uptime；
- 早期 onboarding milestone。

原始积分的作用是增长激励，不是最终空投承诺。

#### 风险分 `risk_score`

这是反作弊 / 反女巫分。

它关注的信号包括：

- 自买自卖；
- buyer 集中度；
- seller 小团伙互刷；
- 共用上游账号；
- 共用设备 / 网络；
- claim 异常；
- 快照前突击刷量。

风险越高，最终空投越应该打折甚至清零。

#### 信誉分 `reputation_score`

这是隐藏运行的 seller 服务质量分。

它关注的信号包括：

- 模型真实性；
- 稳定性；
- 服务诚实度；
- 买家反馈；
- 是否真的服务了独立 buyer；
- 是否长期稳定贡献。

信誉越高，最终空投越应该额外奖励。

#### 有效积分 `eligible_points`

这是经过风控和信誉加权后，真正进入空投结算的积分账本。

最终空投应该按它来算，而不是按原始积分算。

---

## 6. 最终空投公式

推荐采用：

`final_airdrop = raw_points * anti_sybil_factor * reputation_factor`

其中：

- `anti_sybil_factor` 来自 `risk_score`
- `reputation_factor` 来自 `reputation_score`

### 6.1 反女巫倍率示例

- 低风险：`1.0`
- 中风险：`0.5`
- 高风险：`0.1`
- 明确女巫 / 明确作弊：`0.0`

### 6.2 信誉倍率示例

- 极优 seller：`1.30`
- 优秀 seller：`1.10`
- 普通 seller：`1.00`
- 一般 seller：`0.60`
- 低信誉 seller：`0.20`

### 6.3 为什么用倍率而不是简单发 / 不发

倍率机制更灵活：

- 真正优质 seller 可以获得正向加成；
- 边界可疑但未坐实的账户可以打折，而不是直接归零；
- 只有最明确的女巫或严重作弊，才需要完全剔除。

### 6.4 积分发行不采用线性模型，采用递减模型

不建议采用“每天固定发多少分”的线性模型。

原因是：

- 冷启动阶段的 seller 承担更高的不确定性；
- 早期供给更稀缺，边际价值更高；
- 如果后期和前期单位贡献拿到的积分差不多，会削弱早期参与者的激励；
- 线性发放会鼓励后期大户等系统跑顺后再集中进场刷分。

因此建议采用：

`递减发行 + 每期按质量与风控结算`

### 6.5 推荐的时间发行系数

建议以 epoch 为单位设置时间发行倍率 `epoch_multiplier`。

第一版建议值：

- `Epoch 1`: `1.00`
- `Epoch 2`: `0.80`
- `Epoch 3`: `0.65`
- `Epoch 4`: `0.50`
- `Epoch 5`: `0.40`
- `Epoch 6+`: `0.30`

这个模型比“比特币式硬减半”更适合产品运营，原因是：

- 用户更容易理解；
- 不会因为某一个固定时间点突然腰斩而引发预期冲击；
- 团队后续仍然可以按阶段微调；
- 更适合配合风控、信誉分、buyer 贡献等综合因子。

### 6.6 递减系数作用在有效积分上，而不是裸成交量上

为了避免前期风控不成熟时被刷子吃走最高倍率，不建议直接按 raw volume 或 raw points 乘时间系数。

建议最终计算方式为：

`final_airdrop = Σ(epoch_raw_points * anti_sybil_factor * reputation_factor * epoch_multiplier)`

如果需要更严格，也可以在实现中等价处理为：

`epoch_eligible_points = epoch_raw_points * anti_sybil_factor * reputation_factor`

`final_airdrop = Σ(epoch_eligible_points * epoch_multiplier)`

原则上，时间递减应该作用在经过风控与信誉修正后的积分上。

---

## 7. 隐藏信誉分系统

### 7.1 目的

隐藏信誉分的意义是：

把真正对网络有价值的 seller 识别出来，并在空投时给予更高权重。

你们最终想奖励的，不应该是“最会刷量的人”，而应该是：

- 提供真实模型的人；
- 服务稳定的人；
- 不掺水的人；
- 被独立 buyer 持续使用的人；
- 长期维护网络供给的人。

### 7.2 建议的信誉分维度

#### A. 模型真实性

这是最重要的维度，建议权重最高。

正向信号：

- 宣称模型与真实上游模型一致；
- 存在有效 `upstreamProof`；
- 抽检通过；
- 模型投诉率低；
- 输出与延迟特征符合所宣称模型家族。

负向信号：

- 便宜模型冒充高价模型；
- 重复出现“模型不符”投诉；
- 高价模型结算但 usage / 输出模式明显异常；
- 在要求 proof 的阶段缺失 proof。

#### B. 稳定性

正向信号：

- uptime 高；
- 请求成功率高；
- timeout 低；
- error 率低；
- 延迟分布稳定。

负向信号：

- 经常离线；
- 经常掉单；
- 高峰期非常不稳定；
- latency 抖动严重。

#### C. 服务诚实度

这个维度专门打击“掺水 seller”。

正向信号：

- `actual_usage` 与实际结算金额相对匹配；
- 不经常出现“极短回复高额结算”；
- 不长期吃满 authorization ceiling；
- 输出质量和 claim 规模基本一致。

负向信号：

- 反复出现高 claim、低输出；
- 空回复 / 很短回复却结算很高；
- claim-to-usage 比例长期异常。

#### D. 买家质量反馈

正向信号：

- buyer 复购率高；
- 投诉率低；
- quality attestation 稳定；
- buyer 不会很快弃用该 seller。

负向信号：

- dispute / 投诉率高；
- 买家很快流失；
- 只有很小的封闭 buyer 群在反复交易。

#### E. 独立客户贡献

正向信号：

- buyer 来源分散；
- 有多个独立 buyer；
- 不是只靠一两个 buyer 撑起交易量。

负向信号：

- 高度依赖单一 buyer；
- 明显 buyer-seller 小圈子；
- 大量交易都来自疑似关联 buyer。

#### F. 长期贡献

正向信号：

- 活跃周期长；
- 连续多个 epoch 有稳定供给；
- 不是只在快照前冲量。

负向信号：

- 快照前突然放大刷量；
- 生命周期过短，但交易异常高；
- 高活跃仅集中在激励窗口。

### 7.3 建议初始权重

- 模型真实性：`35%`
- 稳定性：`20%`
- 服务诚实度：`20%`
- 买家质量反馈：`10%`
- 独立客户贡献：`10%`
- 长期贡献：`5%`

这些权重应由后台配置控制，便于后续调整。

---

## 8. 反女巫 / 反作弊系统

### 8.1 必须显式建模的威胁

系统应当默认以下几类行为一定会发生，并围绕它们设计：

1. 自买自卖；
2. seller 和 seller 之间互刷；
3. 批量造 buyer 地址刷“独立客户”；
4. 多个 seller 共用同一个 Claude / OpenAI 上游账号农场；
5. 便宜模型冒充贵模型；
6. 用低成本低质量请求刷积分；
7. 快照前突击刷量；
8. seller 环 / buyer 环式的对敲；
9. 伪装成多个独立实体的同一操作者。

### 8.2 风险标签体系

建议不要只做一个黑名单，而是做多标签系统。

推荐标签：

- `self_trade`
- `wash_trading`
- `shared_upstream_account`
- `shared_device_cluster`
- `shared_ip_cluster`
- `single_buyer_dependency`
- `seller_ring`
- `model_spoof_suspected`
- `cheap_model_high_claim`
- `empty_response_high_settlement`
- `abnormal_latency_pattern`
- `abnormal_claim_ratio`
- `farm_like_growth`

每个标签建议记录：

- `confidence`
- `first_seen_at`
- `last_seen_at`
- `evidence_count`
- `notes`

### 8.3 风险分解释区间

建议把 `risk_score` 归一化到 `0-100`：

- `0-30`：低风险
- `31-70`：可疑，需要打折或人工复核
- `71-100`：高风险，默认不参与空投，待人工复核

### 8.4 以 cluster 为单位而不是只看单钱包

空投作弊通常不是单钱包行为，而是 cluster 行为。

后台需要支持多层视角：

- wallet
- seller identity
- buyer identity
- 设备 cluster
- 上游账号 cluster
- 提现地址 cluster

如果 10 个钱包明显是同一个人控制，就不应该因为它们拆得足够细就逃过风控。

---

## 9. 数据采集要求

这一节非常关键。  
如果第一天不把证据存下来，几个月后回头做女巫识别，基本会失真。

### 9.1 身份与绑定信息

建议至少记录：

- `seller_wallet`
- `buyer_wallet`
- `peer_id`
- `p2p_identity`
- `e2ee_public_key`
- `install_instance_id`
- `payout_address`
- `deposit_source_address`
- `device_fingerprint_hash`
- `ip_prefix`
- `asn`
- `country_or_region`
- `openai_account_binding_hash`
- `claude_account_binding_hash`
- 内部 seller 账号 ID

注意：

- 只存哈希或稳定指纹，不存明文敏感凭证；
- 指纹格式必须稳定，便于后续聚类；
- 能做隐私保护的尽量做隐私保护。

### 9.2 请求与结算数据

每一笔请求、每一笔可结算单元，建议记录：

- `request_id`
- `authorization_nonce`
- `buyer_wallet`
- `seller_wallet`
- `advertised_model`
- `requested_model`
- `claimed_model`
- `authorization_amount`
- `actual_usage_input_tokens`
- `actual_usage_output_tokens`
- `actual_settlement_amount`
- `response_size_bytes`
- `ttft_ms`
- `total_latency_ms`
- `success`
- `error_code`
- `created_at`
- `completed_at`

### 9.3 上游证明数据

如果有 `upstreamProof`，建议至少记录：

- `upstream_provider`
- `upstream_real_model`
- `upstream_request_id`
- `upstream_account_binding_hash`
- `proof_hash`
- `proof_status`

### 9.4 聚合行为数据

建议按 seller、按 cluster 持续做 rollup：

- 每日 settlement volume
- 每日 request count
- 独立 buyer 数
- buyer concentration ratio
- 中位 response length
- 中位 claim-to-usage ratio
- success rate
- timeout rate
- dispute rate
- uptime percentage

---

## 10. 对外产品策略

### 10.1 冷启动阶段前台展示什么

前台可以展示：

- raw points；
- milestone；
- 活跃度、稳定供给等基础参与指标。

前台不建议展示：

- 完整 risk score；
- 完整 reputation 公式；
- 精确的反作弊阈值。

### 10.2 应该提前公开的原则

在快照前，就应该明确告诉用户：

- 原始积分不等于最终空投积分；
- 会做 anti-Sybil 审核；
- 服务信誉会影响最终空投；
- 自买自卖、模型冒充、刷量、伪独立 buyer 会被处罚或剔除；
- 团队有权按 cluster 合并多个相关地址。

### 10.3 临近空投时公开什么

建议在快照前后公开：

- 存在 reputation 加权；
- 存在 anti-Sybil 过滤；
- 大致倍率区间；
- 哪些行为属于高危；
- 申诉路径。

### 10.4 结果公布建议

对于 seller，可以在空投时公开：

- 信誉等级或分段；
- 加分原因大类；
- 扣分原因大类；
- 是否被视为 eligible / discounted / review / excluded。

但**不建议**公布完整细粒度公式，否则下一轮大家会按规则反向刷。

---

## 11. 奖励阶段设计

### 阶段一：宽松冷启动期

目标：

- 快速吸引 seller；
- 尽量简化 onboarding；
- 多发原始积分；
- 开始收证据。

策略：

- 展示 raw points；
- 后台运行 risk / reputation，但不全面公开；
- 信誉分 bonus 从第一期开始生效，但用户平时看不到具体分值；
- 明确说明原始积分不等于最终空投承诺。

### 阶段二：半约束增长期

目标：

- 开始压制明显刷子；
- 引导 seller 重视稳定性和模型真实性。

策略：

- 强化 account binding；
- 强化 cluster 识别；
- 强化独立 buyer 贡献权重；
- 对高风险账户开始明显打折。

### 阶段三：空投前清算期

目标：

- 冻结快照；
- 做 cluster 合并；
- 完成 eligible points 计算；
- 应用 reputation bonus 和 anti-Sybil 折扣；
- 对边界 case 进入人工复核。

---

## 12. 建议的 MVP 规则

这是推荐的第一版最小可行策略。

### 12.1 积分发放

允许发 raw points 给：

- 成功完成的请求；
- 成功的结算；
- uptime；
- onboarding milestone。

同时建议：

- 积分按 epoch 结算；
- 不同 epoch 使用递减发行倍率；
- 同一行为在早期 epoch 获得的积分高于后期 epoch；
- 但最终是否进入空投，仍要经过 anti-Sybil 与 reputation 修正。

### 12.2 可计入有效积分的条件

如果一笔行为要 100% 计入最终空投资格，建议尽量满足：

- 没有明显 self-trade 信号；
- 没有强 seller-buyer cluster 关联；
- 没有严重模型真实性警告；
- 没有严重 claim honesty 警告；
- 有足够遥测数据支撑判断。

### 12.3 需要打折的情形

建议打折而不是立刻清零的场景：

- buyer 过于集中；
- 请求模式高度机械；
- 共用上游账号但未完全坐实为作弊；
- 快照前活跃异常上升。

### 12.4 需要清零的情形

建议直接清零 eligible points 的场景：

- 坐实自买自卖；
- 坐实模型冒充；
- 坐实协调型女巫 cluster；
- 多次严重作弊；
- 在 proof 强制期拒绝提供 required proof。

---

## 13. 工程拆分建议

### 13.1 工作流 A：遥测与证据采集

要做的事情：

- 请求级日志；
- 结算级日志；
- 身份绑定采集；
- 上游 proof 采集；
- seller 日聚合。

交付物：

- 稳定的 request / settlement 事件 schema；
- 后台 ingestion pipeline；
- 按天 rollup 的 metrics 数据。

### 13.2 工作流 B：风险图谱与女巫标签

要做的事情：

- wallet 聚类；
- device 聚类；
- 上游账号聚类；
- payout 聚类；
- buyer-seller 关系图谱；
- 风险标签打标；
- `risk_score` 计算任务。

交付物：

- `risk_entities`
- `risk_links`
- `risk_labels`
- `risk_score` job

### 13.3 工作流 C：信誉分引擎

要做的事情：

- seller 质量指标聚合；
- 模型真实性检查；
- 稳定性评分；
- 服务诚实度评分；
- buyer 反馈汇总；
- `reputation_score` 计算。

交付物：

- `seller_metrics_daily`
- `seller_reputation_scores`
- 可配置权重表

### 13.4 工作流 D：积分与有效积分账本

要做的事情：

- 原始积分账本；
- pending 积分账本；
- eligible 积分账本；
- 倍率应用；
- 快照导出。

交付物：

- raw points API；
- 内部 eligibility API；
- snapshot export pipeline。

### 13.5 工作流 E：运营 / 审核后台

要做的事情：

- review dashboard；
- cluster explorer；
- seller 详情页；
- 证据视图；
- override 和 appeal 流程。

交付物：

- 内部风险审核后台。

---

## 14. 建议的数据表 / 模型

推荐至少准备这些表或等价模型：

- `participants`
- `participant_bindings`
- `requests`
- `settlements`
- `upstream_proofs`
- `seller_daily_metrics`
- `seller_reputation_scores`
- `risk_entities`
- `risk_links`
- `risk_labels`
- `points_ledger_raw`
- `points_ledger_pending`
- `points_ledger_eligible`
- `airdrop_snapshots`
- `review_cases`

### 14.1 `seller_reputation_scores` 最小字段建议

- `seller_wallet`
- `epoch_id`
- `model_authenticity_score`
- `stability_score`
- `settlement_honesty_score`
- `buyer_quality_score`
- `independent_buyer_score`
- `long_term_contribution_score`
- `reputation_score`
- `reputation_multiplier`
- `computed_at`

### 14.2 `risk_labels` 最小字段建议

- `entity_id`
- `entity_type`
- `label`
- `confidence`
- `evidence_count`
- `first_seen_at`
- `last_seen_at`
- `notes`
- `created_by`
- `updated_by`

### 14.3 `points_ledger_eligible` 最小字段建议

- `seller_wallet`
- `epoch_id`
- `raw_points`
- `anti_sybil_factor`
- `reputation_factor`
- `eligible_points`
- `status`
- `computed_at`

---

## 15. 仍需明确的产品决策

以下事项本版先按既定决策执行：

### 15.1 信誉分 bonus 何时生效

结论：

- `reputation_score` 和其 bonus 从第一期就开始参与积分结算；
- 但用户平时看不到完整信誉分细节；
- 前台只展示 raw points 或有限的外显等级，不展示完整 reputation score。

这样做的好处是：

- 早期就能鼓励稳定、诚实的 seller；
- 不需要等到空投前再一次性做大幅修正；
- 同时不会过早暴露细节，让人按规则反向刷分。

### 15.2 seller 是否显示 badge / rank

结论：

- seller 平时应该有可见 badge / rank。

建议第一版采用较粗的等级展示，而不是展示精确分值：

- `新卖家`
- `稳定卖家`
- `优质卖家`
- `认证卖家`

注意：

- 外显 badge 不应直接暴露完整 reputation formula；
- badge 可以基于 reputation score 分段、proof 覆盖率、稳定性、争议率等综合决定；
- badge 是产品激励与 buyer 选择辅助，不等于最终空投倍率明细。

### 15.3 upstreamProof 何时强制

结论：

- `upstreamProof` 在第一阶段可选；
- 从第二阶段开始，对高价值模型、核心奖励池、以及高信誉 badge 申请场景设为强制；
- 到后续成熟阶段，可以逐步过渡到“无 proof 的交易可以结算，但不能获得完整挖矿 / 空投资格”。

采用这个方案的原因：

- 第一阶段如果立刻全量强制，可能会显著提高接入门槛；
- 但如果长期不强制，模型冒充会成为系统性漏洞；
- 因此最稳妥的策略是“先可选、后半强制、再逐步收紧”。

建议产品与工程按以下规则实现：

- Phase 1：proof optional
- Phase 2：premium model / 高奖励资格 / 高级 badge 强制 proof
- Phase 3：没有 proof 的交易默认只能获得打折后的 eligible points，严重依赖人工复核

### 15.4 是否引入 stake / slash

结论：

- 冷启动初期暂不引入 stake / slash 作为挖矿资格门槛；
- 但系统设计上要预留 stake / slash 的接入空间；
- 中后期随着 reward 价值上升，建议逐步引入 stake 机制。

原因：

- 早期最重要的是降低供给门槛；
- 太早上 stake 会压制冷启动；
- 但长期如果没有 stake，职业套利者的作弊成本不够高。

建议工程侧提前预留：

- seller staking state；
- slash reason 枚举；
- 审核后触发 penalty 的接口设计；
- “只有 stake seller 才能参与更高等级奖励池”的扩展位。

### 15.5 边界 case 是否人工复核

结论：

- 不建议所有边界 case 都人工复核；
- 建议只对“大户、关键 seller、重要 cluster、高争议 case”做人审；
- 其余边界 case 默认使用自动打折或自动降级处理。

推荐策略：

- 小体量可疑账户：自动折扣
- 中体量边界账户：进入轻量 review queue
- 大体量账户 / 头部 seller / 复杂 cluster：必须人工复核

这样做的原因：

- 全量人工复核工作量不可控；
- 全量自动决策又容易误伤高价值账户；
- 因此应采用“自动为主，人审兜底”的模型。

### 15.6 buyer 是否也有积分与风控体系

结论：

- buyer 也应该有积分与风控体系；
- 但 buyer 是否参与最终空投，可以后续再单独决定。

原因：

- 如果 buyer 完全没有积分与风控体系，就很难识别“伪独立 buyer”“buyer 农场”“seller 自建 buyer 账号刷量”；
- 即使最终空投只发给 seller，buyer 侧数据仍然是 anti-Sybil 的关键输入；
- 因此 buyer 侧至少要有：
  - raw activity points
  - buyer risk score
  - buyer identity / cluster graph

后续可以再决定：

- buyer 是否单独空投；
- buyer 空投是否需要独立 reputation 逻辑；
- buyer 在 seller 激励中的贡献权重如何体现。

### 15.7 仍待后续拍板的次级事项

虽然以上核心规则已定，但仍有一些次级实现细节可后续补充：

1. seller badge 的具体命名与 UI 呈现方式；
2. proof 的数据格式与校验方式；
3. 哪类模型优先进入 proof mandatory 范围；
4. buyer points 是否在前台展示，还是只做后台风控数据；
5. stake 上线的具体阈值与时间点。

---

## 16. 推荐开发顺序

为了尽快落地，同时不把团队拉进过深的复杂度，建议按这个顺序做：

### 第一步

先补全遥测与证据采集：

- request logs
- settlement logs
- identity bindings
- upstream proof 占位与存储结构

### 第二步

做 raw points 和 pending points 账本。

### 第三步

做风险标签体系和第一版女巫聚类。

### 第四步

做 seller 信誉分引擎。

### 第五步

做 eligible points 计算和 snapshot 导出。

### 第六步

做内部 review 工具和 seller 申诉流程。

---

## 17. 最终建议

Tapeout API Market 在冷启动期应该对参与者“发积分要慷慨”，但对最终空投“结算要严格”。

因此，建议系统长期遵守以下原则：

- 早期允许发 `raw_points`；
- 第一时间开始收集证据；
- 后台持续计算 `risk_score` 和 `reputation_score`；
- 在空投阶段再计算 `eligible_points`；
- 最终空投按“有效积分 + 信誉奖励 - 女巫折扣”结算，而不是按表面刷出来的积分结算。

这样既不会压死冷启动，也能最大程度保护最终空投不被低质量 seller、女巫 cluster 和伪造成交量掏空。

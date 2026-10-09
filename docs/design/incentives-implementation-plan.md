# 积分、风控、信誉分与空投实施拆分

**状态：** 实施草案  
**作者：** Tapeout API Market (TAM) core
**日期：** 2026-04-20  
**关联文档：** [积分、风控、信誉分与空投设计](./incentives-risk-reputation-airdrop.md)

---

## 1. 文档目的

本文档不是讲原则，而是把上层设计进一步拆成：

- 可以分给不同同学的开发任务；
- 建议的数据表与字段；
- 建议的后台模块；
- 建议的 job / 定时任务；
- 分阶段上线顺序；
- 第一版接口边界。

目标是让团队可以直接按模块开工，而不是每个人再自行理解一次大方案。

---

## 2. 总体模块划分

建议把整个系统拆成 6 个子系统：

1. **事件采集层**
2. **积分账本层**
3. **风控与聚类层**
4. **信誉分引擎**
5. **空投结算层**
6. **运营审核后台**

对应的团队分工建议如下：

- 后端：事件采集、积分账本、空投结算 API
- 数据 / 风控：聚类、标签、评分、规则任务
- 前端：seller badge、积分页、状态页、管理后台页面
- 运维 / 平台：日志链路、任务调度、数据归档、审计留痕

---

## 3. 推荐分阶段上线

## 3.1 Phase 1：先把数据存下来

**目标：**

- 不急着把评分系统做得很复杂；
- 先保证所有关键证据能被记录；
- 同时让 raw points 能跑起来。

**本阶段要完成：**

- request / settlement 事件落库
- seller / buyer 基础身份绑定
- raw points 账本
- seller 基础 badge
- 基础风控标签占位

**不要求本阶段完成：**

- 完整 cluster 图谱
- 完整 reputation score
- 完整 eligible points 快照逻辑
- stake / slash

---

## 3.2 Phase 2：把风控和信誉跑起来

**目标：**

- 把“只是记录数据”升级为“开始自动判断风险和信誉”；
- 开始对 seller 的积分做隐式修正；
- 对高价值模型逐步要求 proof。

**本阶段要完成：**

- risk labels 自动生成
- 第一版 cluster 聚类
- reputation score job
- buyer risk score
- 高级 seller badge 与 rank
- 高价值模型 proof mandatory

---

## 3.3 Phase 3：准备空投快照

**目标：**

- 形成完整的 eligible points；
- 支持复核与申诉；
- 输出最终 airdrop snapshot。

**本阶段要完成：**

- eligible points 计算
- review case 工作流
- 人工 override
- snapshot 导出
- seller 结果说明页

---

## 4. 后端任务拆分

## 4.1 事件采集服务

### 职责

- 接收 buyer / seller / gateway 上报的请求与结算事件
- 做基础清洗与幂等
- 写入主存储

### 输入事件

至少包括：

- `request_created`
- `request_completed`
- `request_failed`
- `settlement_queued`
- `settlement_claimed`
- `settlement_skipped`
- `proof_received`
- `proof_verified`
- `seller_binding_updated`
- `buyer_binding_updated`

### 要求

- 事件必须幂等
- 所有事件要带 `request_id`
- 所有事件要带 `event_time`
- 允许异步补全字段

### 交付物

- 事件写库接口
- 幂等处理
- 死信队列或错误重试机制

---

## 4.2 积分账本服务

### 职责

- 计算并记录 raw points
- 计算 pending points
- 预留 eligible points 写入能力

### 记账原则

建议账本必须可追溯，不要直接覆盖累计值。

建议采用流水表：

- 每次加分 / 扣分都是一条 ledger entry
- 聚合值通过 job 或视图汇总

### 交付物

- `points_ledger_raw`
- `points_ledger_pending`
- 汇总接口
- seller / buyer 积分查询接口

---

## 4.3 资格结算服务

### 职责

- 读取 raw points
- 读取 risk score 与 reputation score
- 按 epoch 计算 eligible points
- 生成 snapshot

### 计算公式

推荐第一版：

`epoch_eligible_points = epoch_raw_points * anti_sybil_factor * reputation_factor`

`final_airdrop_basis = Σ(epoch_eligible_points * epoch_multiplier)`

### 交付物

- eligible points job
- snapshot export job
- 内部审计导出接口

---

## 5. 数据与风控任务拆分

## 5.1 风险实体与聚类

### 职责

- 把看起来属于同一操作者的 seller / buyer 连接成 cluster
- 为 cluster 打风险标签

### 聚类输入

- 钱包地址
- 提现地址
- 设备指纹哈希
- IP 前缀
- ASN
- 上游账号绑定哈希
- peer_id / install_instance_id

### 聚类输出

- `entity_id`
- `cluster_id`
- `cluster_type`
- `cluster_confidence`

### 第一版建议

第一版不必追求非常复杂的图算法，先实现规则聚类即可：

- 共享同一 `openai_account_binding_hash` -> 强连接
- 共享同一 `claude_account_binding_hash` -> 强连接
- 共享同一 payout address -> 强连接
- 共享 device fingerprint -> 强连接
- 共享 IP 前缀 + 高度同步行为 -> 中连接

---

## 5.2 风险标签引擎

### 职责

- 根据规则与聚类结果生成风险标签
- 输出 risk score

### 第一版重点标签

- `self_trade`
- `wash_trading`
- `shared_upstream_account`
- `single_buyer_dependency`
- `seller_ring`
- `model_spoof_suspected`
- `cheap_model_high_claim`
- `empty_response_high_settlement`
- `farm_like_growth`

### 第一版评分策略

建议规则分两层：

1. 标签层：是否命中某个风险模式
2. 分数层：多个标签综合出 risk score

不要一开始就做完全黑箱模型，先做规则驱动，后续再升级。

### 交付物

- 风险标签生成 job
- risk score 计算 job
- 风险标签明细查询接口

---

## 5.3 买家风控

### 职责

- 识别伪独立 buyer
- 识别 buyer 农场
- 识别 seller 控制的 buyer 集群

### 第一版规则建议

- buyer 长期只与一个 seller 交易且金额结构异常 -> 风险上升
- 一批 buyer 共享强绑定信号并服务于同一 seller -> 风险上升
- buyer 活动时间高度同步且请求结构相似 -> 风险上升

### 输出

- buyer risk score
- buyer cluster
- “独立 buyer”判定结果

---

## 6. 信誉分引擎任务拆分

## 6.1 seller 日指标聚合

### 职责

- 汇总 seller 每日的稳定性、真实性、诚实度、buyer 质量等指标

### 建议每日输出字段

- `seller_wallet`
- `date`
- `request_count`
- `success_rate`
- `timeout_rate`
- `median_ttft_ms`
- `median_total_latency_ms`
- `uptime_percent`
- `unique_buyer_count`
- `buyer_concentration_ratio`
- `median_response_size`
- `median_claim_usage_ratio`
- `model_spoof_warning_count`
- `proof_coverage_ratio`
- `complaint_count`

### 交付物

- `seller_daily_metrics`

---

## 6.2 reputation score 计算

### 职责

- 基于日指标计算 reputation score
- 生成 reputation factor
- 同时产出 seller badge / rank 的基础分层

### 第一版输入维度

- 模型真实性
- 稳定性
- 服务诚实度
- 买家反馈
- 独立 buyer 贡献
- 长期贡献

### 第一版输出字段

- `reputation_score`
- `reputation_factor`
- `reputation_tier`
- `badge_level`

### 推荐 seller badge

建议第一版 badge 不要太花，先做 4 档：

- `新卖家`
- `稳定卖家`
- `优质卖家`
- `认证卖家`

说明：

- `认证卖家` 可要求更高 proof 覆盖率；
- badge 是产品信号，不直接暴露精确分数；
- badge 更新可以按日跑，不需要实时。

---

## 7. 前端任务拆分

## 7.1 Seller 端页面

### 需要展示的内容

- raw points
- badge / rank
- 基础运营指标
- 近期请求表现
- 是否进入 review

### 不建议直接展示

- 完整 risk score
- 完整 reputation score
- 精确风控标签权重

### 可展示的卖家摘要

- 稳定性摘要
- 证明覆盖率摘要
- 最近 7 天服务表现
- 是否存在需要修复的问题

---

## 7.2 Buyer 端页面

### 需要展示的内容

- buyer 活跃积分，可选
- 使用统计
- seller 选择参考信息

### buyer 侧前台建议

buyer 是否展示完整积分可以后续再定，但 buyer 的行为数据必须进入风控。

第一版前台可以先只展示基础使用统计，buyer points 即使不展示，也要在后台先记录。

---

## 7.3 管理后台页面

### 必做页面

1. seller 列表页
2. seller 详情页
3. risk case 列表页
4. cluster 图谱页
5. snapshot 管理页
6. rule 配置页

### seller 详情页建议模块

- 基本身份信息
- badge / rank
- raw points / eligible points
- risk labels
- reputation 维度拆分
- buyer 分布
- proof 覆盖率
- claim 与 usage 对比

---

## 8. 建议数据表

下面给出第一版可落地的数据表建议。

## 8.1 `participants`

用于存 seller / buyer 基本主体信息。

建议字段：

- `id`
- `role` (`seller` / `buyer` / `both`)
- `wallet_address`
- `status`
- `created_at`
- `updated_at`

---

## 8.2 `participant_bindings`

用于存身份绑定与聚类输入。

建议字段：

- `id`
- `participant_id`
- `binding_type`
- `binding_hash`
- `source`
- `confidence`
- `first_seen_at`
- `last_seen_at`

`binding_type` 示例：

- `device_fingerprint`
- `ip_prefix`
- `asn`
- `openai_account`
- `claude_account`
- `payout_address`
- `install_instance`

---

## 8.3 `requests`

建议字段：

- `id`
- `request_id`
- `buyer_wallet`
- `seller_wallet`
- `advertised_model`
- `requested_model`
- `claimed_model`
- `authorization_nonce`
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

---

## 8.4 `settlements`

建议字段：

- `id`
- `request_id`
- `buyer_wallet`
- `seller_wallet`
- `authorization_nonce`
- `authorization_amount`
- `settlement_amount`
- `claim_status`
- `tx_hash`
- `claimed_at`
- `created_at`

---

## 8.5 `upstream_proofs`

建议字段：

- `id`
- `request_id`
- `seller_wallet`
- `upstream_provider`
- `upstream_real_model`
- `upstream_request_id`
- `upstream_account_binding_hash`
- `proof_hash`
- `proof_payload_ref`
- `proof_status`
- `verified_at`
- `created_at`

---

## 8.6 `seller_daily_metrics`

建议字段：

- `id`
- `seller_wallet`
- `date`
- `request_count`
- `success_rate`
- `timeout_rate`
- `median_ttft_ms`
- `median_total_latency_ms`
- `uptime_percent`
- `unique_buyer_count`
- `buyer_concentration_ratio`
- `median_response_size`
- `median_claim_usage_ratio`
- `proof_coverage_ratio`
- `complaint_count`
- `created_at`

---

## 8.7 `seller_reputation_scores`

建议字段：

- `id`
- `seller_wallet`
- `epoch_id`
- `model_authenticity_score`
- `stability_score`
- `settlement_honesty_score`
- `buyer_quality_score`
- `independent_buyer_score`
- `long_term_contribution_score`
- `reputation_score`
- `reputation_factor`
- `reputation_tier`
- `badge_level`
- `computed_at`

---

## 8.8 `risk_entities`

建议字段：

- `id`
- `entity_type`
- `entity_key`
- `cluster_id`
- `status`
- `created_at`
- `updated_at`

---

## 8.9 `risk_links`

建议字段：

- `id`
- `from_entity_id`
- `to_entity_id`
- `link_type`
- `weight`
- `confidence`
- `source`
- `created_at`

---

## 8.10 `risk_labels`

建议字段：

- `id`
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

---

## 8.11 `points_ledger_raw`

建议字段：

- `id`
- `participant_role`
- `wallet_address`
- `epoch_id`
- `point_type`
- `delta`
- `request_id`
- `source_ref`
- `created_at`

`point_type` 示例：

- `request_success`
- `settlement_volume`
- `unique_buyer_bonus`
- `uptime_bonus`
- `manual_adjustment`

---

## 8.12 `points_ledger_eligible`

建议字段：

- `id`
- `wallet_address`
- `participant_role`
- `epoch_id`
- `raw_points`
- `anti_sybil_factor`
- `reputation_factor`
- `epoch_multiplier`
- `eligible_points`
- `status`
- `computed_at`

---

## 8.13 `review_cases`

建议字段：

- `id`
- `case_type`
- `entity_id`
- `cluster_id`
- `priority`
- `status`
- `owner`
- `summary`
- `decision`
- `decision_notes`
- `created_at`
- `resolved_at`

---

## 9. 定时任务建议

建议至少准备以下 jobs：

1. `ingest_request_events`
2. `ingest_settlement_events`
3. `verify_upstream_proofs`
4. `build_identity_links`
5. `build_clusters`
6. `compute_risk_labels`
7. `compute_risk_scores`
8. `rollup_seller_daily_metrics`
9. `compute_reputation_scores`
10. `compute_raw_points`
11. `compute_eligible_points`
12. `generate_airdrop_snapshot`

### 9.1 执行频率建议

- request / settlement ingest：实时或准实时
- proof verify：准实时
- cluster / risk labels：每小时或每日
- seller daily metrics：每日
- reputation scores：每日
- raw points：每小时或每日
- eligible points：每个 epoch 结束时
- snapshot：人工触发 + 审计确认

---

## 10. 接口建议

## 10.1 内部写入接口

建议提供内部事件接口：

- `POST /internal/events/request-created`
- `POST /internal/events/request-completed`
- `POST /internal/events/request-failed`
- `POST /internal/events/settlement-queued`
- `POST /internal/events/settlement-claimed`
- `POST /internal/events/proof-received`

---

## 10.2 Seller 前台接口

- `GET /seller/me/points`
- `GET /seller/me/badge`
- `GET /seller/me/summary`
- `GET /seller/me/metrics`

返回时不建议直接暴露完整 `risk_score` 和 `reputation_score` 数值。

---

## 10.3 管理后台接口

- `GET /admin/sellers`
- `GET /admin/sellers/:wallet`
- `GET /admin/risk/cases`
- `GET /admin/risk/clusters/:clusterId`
- `GET /admin/snapshots`
- `POST /admin/review-cases/:id/assign`
- `POST /admin/review-cases/:id/resolve`
- `POST /admin/points/override`

---

## 11. proof 策略落地建议

结合上层设计，建议工程按以下方式落地：

### Phase 1

- `upstreamProof` 可选；
- 数据结构和存储先建好；
- proof 缺失只作为一个风险信号。

### Phase 2

- 对高价值模型和高级 badge 申请流程要求 proof；
- proof 缺失会影响 reputation factor；
- 某些 reward pool 可以要求 proof mandatory。

### Phase 3

- 没有 proof 的交易仍可结算，但 eligible points 明显打折；
- 头部 seller 若长期无 proof，应进入 review。

---

## 12. 人工审核策略

建议采取：

`自动规则为主 + 人工审核兜底`

### 自动处理对象

- 小体量可疑账户
- 低风险边界 case
- 明显低价值刷量样本

### 人工处理对象

- 大户 seller
- 高 badge seller
- 复杂 seller / buyer cluster
- 涉及大额 points 或 snapshot 争议的 case

### 审核结果类型

- `pass`
- `discount`
- `exclude`
- `needs_more_evidence`

---

## 13. buyer 侧的实现建议

既然 buyer 也纳入积分和风控体系，建议至少做这三件事：

1. buyer raw activity points
2. buyer risk score
3. buyer cluster 图谱

第一版 buyer 不一定要有复杂前台页面，但后台数据结构要先有。

buyer 侧最关键的作用不是发分，而是：

- 提供“独立 buyer”判定依据；
- 反推出 seller 是否自刷；
- 为 seller reputation 提供真实买家维度。

---

## 14. 推荐开发顺序与责任人类型

## 14.1 第一批必须先做

### 后端

- 事件采集接口
- requests / settlements / proofs 基础表
- raw points ledger

### 数据 / 风控

- participant bindings
- 第一版风险标签规则
- buyer / seller 基础聚类

### 前端

- seller badge 展示
- seller points 概览页

---

## 14.2 第二批跟进

### 后端

- seller daily metrics job
- reputation score job
- eligible points job

### 数据 / 风控

- cluster explorer
- buyer risk score
- proof coverage rule

### 前端 / 后台

- seller 详情页
- risk case 列表
- review case 页面

---

## 14.3 第三批空投前完成

### 后端

- snapshot 导出
- override 机制

### 数据 / 风控

- 大户复核规则
- cluster 合并确认

### 前端 / 运营

- seller 结果说明页
- appeal 流程页

---

## 15. 团队协作建议

为了防止后面大家做出来的东西互相接不上，建议先统一这几件事：

1. 统一 `request_id` 贯穿 buyer、seller、gateway、proof、settlement 全链路；
2. 统一 epoch 定义；
3. 统一 badge 枚举；
4. 统一 risk label 枚举；
5. 统一 reputation 维度枚举；
6. 统一 points ledger 的 `point_type` 枚举；
7. 所有 override 都必须留审计日志。

---

## 16. 本文档对应的直接开发清单

如果要马上开工，建议拆成下面这些 issue：

### 后端

1. 新增 requests / settlements / upstream_proofs 表
2. 新增 internal event ingest API
3. 新增 raw points ledger 与汇总接口
4. 新增 seller daily metrics job
5. 新增 eligible points 计算 job

### 风控 / 数据

6. 新增 participant_bindings 表与采集逻辑
7. 新增 risk_entities / risk_links / risk_labels 表
8. 第一版规则聚类与 risk score job
9. 第一版 buyer risk score
10. 第一版 reputation score job

### 前端

11. seller badge / rank UI
12. seller 积分概览页
13. 管理后台 seller 详情页
14. 管理后台 risk case 列表页

### 运营后台

15. review case 工作流
16. 人工 override 与审计日志
17. snapshot 导出页

---

## 17. 结论

这套系统真正要做到的不是“把积分发出去”，而是：

- 先把参与激励做起来；
- 再把证据、风险、信誉、快照四条链补齐；
- 最后确保真正有价值、稳定、诚实的 seller 获得更高回报，而不是让最会刷的人拿走最多空投。

因此，工程实施顺序上应当优先保证：

1. 数据先落；
2. raw points 先跑；
3. 风控和信誉尽快补；
4. 空投快照最后再做强结算。


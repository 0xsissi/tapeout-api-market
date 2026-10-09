# AIMM 文档

这个文件夹是 **AIMM (Automated Inference Market Maker)** 协议的核心文档。

> AIMM 是一种链上协议，让 AI 推理能力像资产一样被做市。
> 它之于 AI 推理，就像 AMM 之于代币交易。

## 文件说明

| 文件 | 用途 | 给谁看 |
|---|---|---|
| `primer.md` | AIMM 技术入门（机制、公式、设计思路） | 技术用户、开发者、投资人 |
| `architecture.md` | 系统架构图 + 数据流 + 核心数据结构 | 工程师、架构师 |
| `engineering-spec.md` | V1 工程实施文档（T1-T20 代码级细节） | **开发同事 → 对着写代码** |
| `test-plan.md` | 测试与验证计划（T21-T25，对照实验 + 上线 gate） | **测试同事 → 对着跑实验** |
| `glossary.md` | 四个核心术语的正式定义 | 所有人，作为后续内容的引用来源 |
| `simulation.py` | CUC 定价与路由的 Python 仿真脚本 | 工程师、博客配图 |

## 阅读顺序

### 给理解协议的人
1. `primer.md` —— 了解 AIMM 是什么、怎么工作
2. `glossary.md` —— 建立标准术语
3. `simulation.py` —— 想看实证的跑一下

### 给实施代码的开发同事
1. 先扫 `primer.md` 第 1-4 章建立概念
2. 读 `architecture.md` 全文理解数据流和类型
3. **按 `engineering-spec.md` 开干**（T1 到 T20）

### 给跑测试的同事
1. 先读 `primer.md` 的 "三根柱子" 和 "羊群效应解药" 两节，理解我们在验证什么
2. **按 `test-plan.md` 开干**（T21 TestKit → T22 单元 → T23 对照实验 → T24 E2E → T25 混沌）
3. 实验 C（封号保护）的对照图是白皮书核心证据，跑出来立刻发群里看

## 当前实现状态

- T1-T23 已落地并有本地测试 / 实验脚本覆盖。
- T24 真账号 E2E smoke 已提供 `pnpm aimm:smoke` 入口，并已生成最新真实环境报告 `report/e2e-smoke-20260423.md`（运行记录仅保存在本地）。
  当前 live 状态：
  1. AIMM quote 路由已命中 seller，连续 5 次真实请求返回 HTTP 200。
  2. buyer / seller 已切到新 `EscrowPool` `0x8A392a77eb88f477FeF060033937a2e4692Eb56E`。
  3. 历史 claim 队列已成功 flush，旧 ABI 兼容与新池子部署都已验证。
  4. T24 当前可视为通过；若要进 mainnet，仍需继续完成 T25 混沌长跑和更长时间窗口观察。
- T25 24h 混沌长跑已提供 `pnpm aimm:chaos` 入口；默认跑加速 mock 版，设置 `AIMM_CHAOS_REALTIME=true` 可按真实 24h 窗口运行。加速版最新报告见 `report/chaos/chaos-24h-20260423.md`（运行记录仅保存在本地）。

## 术语约定

- **做市商 (Maker)**：向 AIMM 注入推理容量的一方，通常是有闲置 LLM 订阅的个人
- **买家 (Taker)**：通过 AIMM 购买推理能力的一方，CLI 用户 / 开发者 / AI agent
- **CUC (Constant Utilization Curve)**：AIMM 的核心定价公式
- **TTL (Time-To-Live)**：报价在多少秒内有效，之后做市商必须重新报价

---

*最后更新：2026-04-23*

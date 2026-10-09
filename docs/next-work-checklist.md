# Next Work Checklist

这份清单用于把当前 testnet MVP 收口成可交付状态。每完成一项，就把对应复选框打勾。

## 当前优先级

- [x] 1. 代码状态收口：清理 P2P 排查期间留下的临时调试日志、实验路径和一次性测试残留，保留稳定性修复。
- [x] 2. Buyer 入口：补齐本机 buyer 的余额、充值、提现和 API token/额度购买体验。
- [x] 3. Seller 入口：补齐 seller 收益、claim 队列、挖矿积分/CLAW 状态展示。
- [x] 3.5 CLI 入口：补上第一版交互式 `clawmarket` 界面，至少覆盖 buyer status/chat/purchase、seller status/flush 和 doctor。
- [x] 4. 文档同步：把 Base Sepolia 当前部署、EscrowPool 实际状态、buyer/seller/bootstrap 启动方式同步到文档。
- [x] 5. 回归验证：跑核心构建和测试，整理剩余 blocker。

## 已修复的网络 blocker

- [x] P2P request stream 生命周期问题：根因是 provider sidecar 对同一条 sink-only libp2p stream 重复调用 `stream.sink()`，第一帧后写端被 half-close。现在 provider sidecar 使用单一长生命周期 sink writer，`stream_start`、加密 chunk 和 `stream_end` 都走同一个写队列。
- [x] Buyer 到公网 seller 的提前断流问题：根因是 buyer 节点启用的 libp2p `AutoNAT` 会复用并关闭正在承载业务请求的连接。现在 `packages/p2p-node` 默认不启用 `autoNAT`，只有显式传 `enableAutoNAT: true` 才会开启。

## 2026-04-20 已验证

- [x] 本机 buyer -> `203.0.113.30` seller 非流式 `gpt-5.4` 返回真实正文：`ok`
- [x] 本机 buyer -> `203.0.113.30` seller 流式 `gpt-5.4` 返回真实 `stream_chunk` 和 `stream_end`
- [x] seller 侧 `cliproxy` 上游返回 `HTTP 200`，并成功提交一笔 `EscrowPool.claim`

## 下一步

- [x] 把 `autoNAT` 默认关闭这版变更同步部署到远端长期运行节点：`203.0.113.30` 的 bootstrap / buyer 已更新并重启；远端 seller 当前未运行，后续启动会使用同一份已同步代码。
- [x] 清理这轮 P2P 排障期间新增的高噪声调试日志，保留必要的关闭栈和错误上下文
- [x] 增加回归测试，覆盖“业务流进行中不应被节点内部 NAT 探测关闭连接”这类连接生命周期问题
- [x] 在第一版 CLI 上继续补 `init`、提款/提现引导、seller 启停与更清晰的交互式状态面板

# Tapeout API Market CLI 重构设计方案

> 更新：CLI Onboarding V2 已落地在阶段 0，首跑流程现在会展示 buyer/seller 钱包地址二维码、检查 Base Sepolia USDC/ETH 余额，并支持 Codex / Claude / Gemini 三类上游。

## 1. 背景与现状

当前 `packages/cli/src/index.ts` 是一个 **2370 行** 的单文件，混合了三种交互模式：

1. **Commander 子命令模式**（`clawmarket buyer status` / `seller start` / `init` / `doctor` 等）
2. **交互式 Dashboard 模式**（无参调用时进入 `runInteractiveHome`）
3. **轻量 wizard**（`runInitWizard`、`runWithdrawWizard`，其实只是几行菜单问答）

### 现状问题

| # | 问题 | 说明 |
|---|---|---|
| 1 | 无参进入的 Dashboard 不是真正的"引导" | 用户一上来看到 `i/1/2/3/4/5/6/7/8/9/w/l/d/0` 混合数字字母的菜单，需要记忆 |
| 2 | `init` 命令是独立子命令，不是默认首跑体验 | 新用户不知道要打 `init`，直接 `clawmarket` 就被扔进 dashboard |
| 3 | 手写 ANSI 渲染，闪烁、窗口 resize 不自适应 | 每 3 秒 `\x1b[2J\x1b[H` 全屏清屏重绘 |
| 4 | 大色块背景 + 多种前景色，视觉噪音重 | `bgDarkBlue` / `bgCyan` / `bgMagenta` 满屏 |
| 5 | 命令行模式和 Dashboard 模式功能重叠 | `buyer status` 和 dashboard 里按 `5` 做的是同一件事，维护两份 |
| 6 | 15+ 个 `CLAWMARKET_*` 环境变量当配置 | 没有持久化 config，重装一次全丢 |
| 7 | 单文件 2370 行，commands / render / services / runtime 混在一起 | 无法单元测试，改一处怕动全局 |
| 8 | Wizard 太薄，真正要做的"引导"（生成钱包、Codex 登录、充值、选模型）被拆散在各入口 | 用户需要自己串起来 |

---

## 2. 设计目标

1. **第一次打开 = 引导**：新用户执行 `clawmarket` → 自动进 onboarding wizard。
2. **二次及以后 = 控制台**：已完成 onboarding 的用户 → 直接进 TUI 控制台。
3. **所有操作菜单化**：不再让用户记 `1/2/w/l/d`，一律上下键 + Enter + Tab 切视图。
4. **脚本友好**：保留非交互命令行（CI、远程 run）。
5. **视觉克制**：主色 + 强调色 + 错误色三色系，单色框线替代背景色块。
6. **可测试**：拆分 services / UI / runtime，每层独立单测。

---

## 3. 技术栈建议

| 层 | 选型 | 理由 |
|---|---|---|
| 命令行解析 | **commander**（保留） | 已在用，非交互入口够用 |
| TUI 渲染 | **Ink 5**（React for CLI）+ `ink-select-input` / `ink-text-input` / `ink-spinner` / `ink-gradient` | 差分渲染、自动 resize、组件化；取代手写 ANSI |
| 持久化配置 | `~/.clawmarket/config.json`，用 **conf** 或自写一个轻量 wrapper | 取代散乱的 `CLAWMARKET_*` env（env 仅用于覆盖） |
| 状态管理 | Ink 自带 `useState` + 一个 `useBackendStatus` hook（3s 轮询） | 不引入 zustand/redux |
| 测试 | **ink-testing-library** + vitest | 与仓库现有 vitest 一致 |

> 不引入 blessed/tui 类重型库；Ink 已经够用并且与仓库 ts+pnpm 技术栈匹配。

---

## 4. 新的交互模型

### 4.1 入口判定逻辑

```
clawmarket [args?]
├── 有 args  → 走 commander（非交互模式）
└── 无 args  → 读 ~/.clawmarket/config.json
              ├── onboarding 未完成 → 进 <OnboardingWizard>
              └── onboarding 已完成 → 进 <Console>
```

用户也可以显式：
- `clawmarket init` 强制重跑引导
- `clawmarket console` 强制进控制台（即便未引导）

### 4.2 Onboarding Wizard（首次体验）

全屏单列、上下键选择、Enter 下一步，Esc 上一步。每步顶部显示进度条 `Step 2 / 6`。

**买家引导流程**：
1. **选择角色**：`[ ] 买家` / `[ ] 卖家` / `[ ] 两者都要`
2. **钱包**：检测 `~/.clawmarket/buyer-testnet.key` → 存在就复用 / 不存在则自动生成并显示地址 & 助记词提醒
3. **启动节点**：显示 spinner + 实时日志尾巴（调用现在的 `startBuyerInternal`）
4. **选模型**：从 `/v1/network/status` 拉列表，列表渲染 `gpt-5.4 (3 个 seller, 60/60 USDC/1M)`
5. **充值**（可跳过）：输入金额 → 调 `/v1/credits/purchase`
6. **完成**：显示"下一步可以：按 Enter 进入控制台 / 在外部客户端填 `http://127.0.0.1:18080/v1`"

**卖家引导流程**：
1. 角色选择（同上）
2. 钱包导入/生成（统一使用 `~/.clawmarket/wallet.json`；旧 `seller-wallet.json` 仅做迁移兼容）
3. **Codex 登录**：检测 auth 目录 → 若缺失，内嵌跑 `seller login-codex`，显示 device-code 流程
4. 定价（默认 `60/60 USDC/1M`，可改）
5. 启动（spinner + reachability 探测：`public_direct` / `relay` / `not_reachable`，后者给出端口转发指引）
6. 完成

**两者都要**：依次跑买家 6 步 + 卖家 6 步。

### 4.3 Console（稳态控制台）

布局：

```
┌─ TAM ──────────────────────────────── buyer ● seller ● p2p ● ─┐
│                                                                      │
│  ┌─ Nav ─────────┐  ┌─ Current View ────────────────────────────┐   │
│  │  Dashboard    │  │                                           │   │
│  │  Chat         │  │     (dashboard / chat / network / ... )   │   │
│  │  Network      │  │                                           │   │
│  │  Seller       │  │                                           │   │
│  │  Claims       │  │                                           │   │
│  │  Logs         │  │                                           │   │
│  │  Settings     │  │                                           │   │
│  └───────────────┘  └───────────────────────────────────────────┘   │
│                                                                      │
├─ Events ─────────────────────────────────────────────────────────────┤
│  12:03:21 买家  已就绪，余额 42.1 USDC                                │
│  12:03:19 网络  发现 3 个 seller                                      │
└─ Tab 切换  ↑↓ 选择  Enter 进入  /  命令搜索  q 退出 ────────────────┘
```

**关键交互**：
- **Tab / Shift-Tab**：切换左侧 Nav 条目
- **↑↓ + Enter**：在当前视图内操作
- **`/`**：唤起命令面板（类似 VS Code Cmd-P / k9s），模糊搜索 "purchase / flush / login-codex"
- **`?`**：弹出快捷键帮助
- **`q` / Ctrl-C**：退出（带确认）

### 4.4 各视图

| 视图 | 核心内容 | 主要动作 |
|---|---|---|
| Dashboard | 买家余额 + 卖家 queue + p2p 连通性 + 最近一次问答 | 无，纯展示 |
| Chat | REPL 风格输入框 + 历史对话 + token 用量 | 回车发送，↑↓ 翻历史 |
| Network | Seller 列表（peerId / 钱包 / 模型 / 价格 / 评分） | `Enter` 置顶某 seller，`Enter` on model 切模型 |
| Seller | 本机卖家 status + claim 预览 + reachability | `f` flush claims，`l` 看日志 |
| Claims | 单独一屏把 claim 表格化展示 | `f` flush |
| Logs | `tail -f` buyer/seller 子进程 log | `Tab` 切 buyer/seller |
| Settings | 显示所有配置项（来自 config.json），可就地编辑 | 回车编辑 |

---

## 5. 非交互命令行（精简版）

现有子命令太碎。建议压缩成：

```
clawmarket init                       # 强制重跑引导
clawmarket console                    # 进控制台
clawmarket doctor                     # 健康检查
clawmarket config <get|set|path>      # 看/改 ~/.clawmarket/config.json

clawmarket buyer <up|down|status|chat|purchase|withdraw>
clawmarket seller <up|down|status|flush|login>
```

对比现状，砍掉：`buyer credits`（= status 别名）、`buyer guide`、`buyer watch`、`seller watch`（都移进 Console 视图）。

---

## 6. 代码结构

```
packages/cli/
├── package.json
├── src/
│   ├── index.ts                    # bin 入口：判定走 commander 还是 TUI
│   ├── commands/                   # 非交互命令，每条一个文件
│   │   ├── init.ts
│   │   ├── doctor.ts
│   │   ├── buyer/
│   │   │   ├── up.ts down.ts status.ts chat.ts purchase.ts withdraw.ts
│   │   └── seller/
│   │       ├── up.ts down.ts status.ts flush.ts login.ts
│   ├── tui/
│   │   ├── app.tsx                 # Ink 根组件
│   │   ├── onboarding/
│   │   │   ├── index.tsx
│   │   │   └── steps/              # 每步一个组件
│   │   ├── console/
│   │   │   ├── index.tsx
│   │   │   ├── Nav.tsx
│   │   │   ├── EventsBar.tsx
│   │   │   ├── CommandPalette.tsx
│   │   │   └── views/
│   │   │       ├── Dashboard.tsx Chat.tsx Network.tsx
│   │   │       ├── Seller.tsx Claims.tsx Logs.tsx Settings.tsx
│   │   └── components/             # Panel, Pill, ProgressBar, Spinner...
│   ├── hooks/
│   │   ├── useBuyerStatus.ts       # 3s 轮询 buyer /v1/...
│   │   ├── useSellerStatus.ts
│   │   └── useNetwork.ts
│   ├── services/                   # 纯函数 HTTP client，可单测
│   │   ├── buyer.ts seller.ts http.ts
│   ├── runtime/                    # 现有 startBuyerInternal/startSellerInternal 抽出来
│   │   ├── buyer-runtime.ts seller-runtime.ts cliproxy.ts
│   ├── config/
│   │   ├── schema.ts               # zod schema
│   │   └── store.ts                # 读写 ~/.clawmarket/config.json
│   └── theme.ts                    # 颜色常量，替代 ANSI 对象
└── tsconfig.json
```

---

## 7. 视觉规范

- **三色系**：`primary` (cyan)、`accent` (yellow)、`danger` (red)；其余用灰阶。
- **零大块背景色**，改用单色边框 `─│┌┐└┘`。
- **状态徽章**用符号 + 颜色：`● 在线`（绿）、`◆ 待启动`（黄）、`✕ 离线`（红）。
- **动效**：只在等待后端时显示 spinner；稳态下不要每 3s 全屏重绘（Ink 会做差分）。
- **窄终端 fallback**（宽 < 80）：Nav 折叠为顶部 Tab 栏。

---

## 8. 配置迁移

```ts
// ~/.clawmarket/config.json
{
  "onboarding": { "completedAt": "2026-04-21T...", "role": "buyer" },
  "buyer": {
    "url": "http://127.0.0.1:18080",
    "identityPath": "...",
    "selectedModel": "gpt-5.4"
  },
  "seller": {
    "url": "http://127.0.0.1:8787",
    "walletPath": "...", "identityPath": "...", "p2pPort": 19190,
    "cliproxy": { "sourceDir": "...", "workDir": "...", "authDir": "...", "port": 4310 },
    "pricing": { "input": 60, "output": 60 },
    "models": ["gpt-5.4", "gpt-5.4-mini"]
  },
  "network": {
    "bootstrapPeers": ["/ip4/203.0.113.30/tcp/9090/..."],
    "seedProvidersFile": "/tmp/clawmarket-remote-seller-seed-tcp.json"
  }
}
```

- 所有 `CLAWMARKET_*` env 仍生效，但只用作 **一次性覆盖**（debug / CI）。
- `clawmarket config path` 打印配置文件位置，方便用户直接改。

---

## 9. 实施路线（建议分 4 个 PR）

| PR | 范围 | 估时 |
|---|---|---|
| **PR 1** | 抽 `services/` + `runtime/` + `config/`，原有功能不动 | 1d |
| **PR 2** | 用 Ink 重写 Onboarding Wizard，替换 `runInitWizard` + `runInitCommand` | 2d |
| **PR 3** | 用 Ink 重写 Console，替换 `runInteractiveHome` + `renderDashboard` | 3d |
| **PR 4** | 精简 commander 子命令；迁移 env → config.json；文档更新 | 1d |

每个 PR 都要：
- 保留旧 `pnpm cli -- ...` 脚本兼容（别人的 CI 在用）
- 带 vitest 单测（services / hooks / onboarding step 组件）
- 过一遍 `pnpm tsc --noEmit`

---

## 10. 验收标准（交付给实现同事）

- [ ] `clawmarket`（无参）首次运行进入 onboarding；onboarding 完成写 `config.json`；二次运行进入 Console。
- [ ] Onboarding 支持买家 / 卖家 / 两者都要三条路径；每步可 Esc 返回上一步。
- [ ] Console 支持 Tab 切 7 个视图，`/` 唤起命令面板，`?` 显示帮助，`q` 带确认退出。
- [ ] 终端窗口 resize 时布局自动重排，宽 < 80 时 Nav 折叠为顶 Tab。
- [ ] Ctrl-C 能干净结束子进程（买家 / 卖家 / cliproxy），无僵尸。
- [ ] 所有 `CLAWMARKET_*` env 行为保留；新增 `clawmarket config get/set` 入口。
- [ ] 非交互命令 `clawmarket buyer up/status/...` 等仍能 headless 跑（无 TTY 时自动降级为纯文本输出，供 CI 用）。
- [ ] `pnpm test --filter @clawmarket/cli` 通过，覆盖 services / onboarding / console 主要组件。

## 11. 未来工作

- `seller.pricing` 目前保持一组共享的 `{ input, output }`，对 `seller.models` 中所有模型生效。后续如需支持分模型定价，可迁移为 `Record<model, { input, output }>`，并在 onboarding / Seller 视图 / provider announcement 里同步支持逐模型编辑与展示。

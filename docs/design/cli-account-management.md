# CLI 账号管理与上游登录修复计划

**背景**：当前 Seller 视图的"换 Codex 账号 / 登录 Claude / 登录 Gemini"三个入口都是**断的**——点了什么都不会发生，只在之后重启 seller 时抛一条误导性提示"请使用 seller login --upstream ..."。同时 Claude / Gemini 从来没真正跑通过。

本文修三件事：

1. **P0**：Console → seller login 的实际执行链路（现在完全没接上）。
2. **P0**：Claude / Gemini 端到端走通（CLIProxyAPI flag 验证 + 模型动态发现）。
3. **P1**：把"账号管理"做成控制台里一级功能（列账号、切换、登出、备份/恢复），普通用户不用离开 Console。

---

## 1. P0 — 接通 Console seller login 链路

### 1.1 症状复盘

`SellerView.openLoginConfirm` → `onRequestSellerLogin` → `exit({action:'seller_login', upstream, replaceAuth, restartSeller})` → `runInteractiveHome` **不认这个 action**（`packages/cli/src/index.ts:400`），直接退出 CLI。Login 从未执行。

### 1.2 修复

**文件**：`packages/cli/src/index.ts` `runInteractiveHome`

```ts
async function runInteractiveHome(options: { buyerUrl: string; sellerUrl: string }): Promise<void> {
  let keepRunning = true;
  while (keepRunning) {
    const result = await runConsoleApp({ /* 同现状 */ });
    cliConfig = await loadCliConfig();

    if (result.action === 'onboarding') {
      const onboarding = await runOnboardingWizard({ /* 同现状 */ });
      cliConfig = await loadCliConfig();
      keepRunning = onboarding.completed && onboarding.openConsole;
      continue;
    }

    if (result.action === 'seller_login') {
      await handleSellerLoginFromConsole({
        upstream: result.upstream,
        replaceAuth: result.replaceAuth,
        restartSeller: result.restartSeller,
        sellerUrl: options.sellerUrl,
      });
      cliConfig = await loadCliConfig();
      // 登录流程结束后自动回到控制台，不要退出 CLI
      continue;
    }

    keepRunning = false;
  }
}
```

**新函数** `handleSellerLoginFromConsole`：

```ts
async function handleSellerLoginFromConsole(args: {
  upstream: SellerUpstream;
  replaceAuth: boolean;
  restartSeller: boolean;
  sellerUrl: string;
}): Promise<void> {
  // 1. 若 seller 在跑，先停；login 期间 cliproxy 会被登录流程独占
  const wasRunning = (await getServiceStatus(`${args.sellerUrl}/health`, 'seller')).online;
  if (wasRunning) {
    console.log('正在停止 seller 以便释放 cliproxy ...');
    await stopSellerRuntime((line) => console.log(line));
  }

  // 2. replaceAuth=true 时把现有 auth 备份（不是删除）
  const authDir = cliConfig.seller.cliproxyAuthDir;
  let backupPath: string | null = null;
  if (args.replaceAuth) {
    backupPath = await backupAuthDir(authDir); // 返回 auth.bak-<upstream>-<ISO> 路径
    if (backupPath) console.log(`已备份当前登录到：${backupPath}`);
  }

  // 3. 跑 login（stdio: 'inherit'；此时 Ink 已 unmount，不冲突）
  try {
    await loginSellerUpstream({
      upstream: args.upstream,
      device: false,
      cliproxySource: cliConfig.seller.cliproxySourceDir,
      cliproxyWorkDir: cliConfig.seller.cliproxyWorkDir,
      cliproxyAuthDir: authDir,
    });
  } catch (error) {
    console.error(`登录失败：${error instanceof Error ? error.message : String(error)}`);
    // 登录失败且我们备份了旧的，自动恢复，避免用户陷入"两头落空"
    if (backupPath) {
      console.log('正在恢复之前的登录文件 ...');
      await restoreAuthDir(authDir, backupPath);
    }
    return; // 不自动重启 seller；回到控制台
  }

  // 4. login 成功后动态发现模型并回写 config（P0-2 的一部分，见 §2.3）
  await refreshSellerModelsFromCliproxy(args.upstream);

  // 5. restartSeller=true 或之前就在跑的，把 seller 重新拉起
  if (args.restartSeller || wasRunning) {
    console.log('正在重启 seller 应用新账号 ...');
    await startSellerRuntime({
      ...getDefaultSellerRuntimeOptions(await loadCliConfig()),
      report: (line) => console.log(line),
    });
  }
}

async function backupAuthDir(authDir: string): Promise<string | null> {
  if (!(await directoryHasRealFiles(authDir))) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${authDir}.bak-${ts}`;
  await rename(authDir, backupPath);
  await mkdir(authDir, { recursive: true });
  return backupPath;
}

async function restoreAuthDir(authDir: string, backupPath: string): Promise<void> {
  await rm(authDir, { recursive: true, force: true });
  await rename(backupPath, authDir);
}
```

**要点**：
- login 失败**必须自动回滚**，否则用户点一次"换账号"出错就进退失据。
- 备份命名 `auth.bak-<ISO>`，便于后续"切回老账号"功能识别（§3.3）。
- login 期间 Ink 已经 unmount（`ConsoleApp` exit 走出来了），stdio inherit 不会和 TUI 冲突。

### 1.3 修复错误提示文案

`runtime/seller-runtime.ts:97-99` 的错误现在会误导用户去敲命令行：

```ts
throw new Error(
  [
    `没有找到 ${options.upstream} 登录文件，所以 seller 不能启动上游代理。`,
    `请在 Seller 视图里选择 "登录 ${upstreamLabel(options.upstream)}"，或命令面板输入 login。`,
    '（登录文件目录：' + options.cliproxyAuthDir + '）',
  ].join('\n'),
);
```

---

## 2. P0 — Claude / Gemini 真正跑通

### 2.1 先验证 CLIProxyAPI 的 login flag 实际名字

**动手前必须做**：

```bash
cd <CLIProxyAPI 源码目录>
grep -rn "claude-login\|gemini-login\|anthropic-login\|google-login" cmd/server/
grep -rn "flag.Bool\|flag.String" cmd/server/main.go | grep -iE "claude|gemini|anthropic|google"
```

把实际 flag 名记下来。如果当前 `scripts/lib/embedded-cliproxy.mjs:233-236` 里的 `-claude-login` / `-gemini-login` 和源码对不上，**第一件事是改这两行**。若 CLIProxyAPI 本身没有对应 flag，需要先去 CLIProxyAPI 仓库加。

### 2.2 验证 CLIProxyAPI 支持这些上游的 build

CLIProxyAPI 可能用 Go build tag 区分后端。手工验证：

```bash
# 在 CLIProxyAPI 目录
go build -o /tmp/cliproxy ./cmd/server
/tmp/cliproxy --help 2>&1 | grep -iE "claude|gemini|anthropic"
```

如果帮助里看不到 Claude / Gemini 选项，就是 build 没开。找 CLIProxyAPI 的文档确认是否需要 `-tags claude,gemini` 之类。

### 2.3 登录后动态拉模型列表回写 config

**问题**：onboarding v2 的 `SELLER_MODEL_PRESETS` 是猜的（`claude-4.6-sonnet` 等），CLIProxyAPI 实际 `/v1/models` 返回的 id 可能是 `claude-3-5-sonnet-20241022` 这种。猜错了 seller 启动后 `CLIPROXY_EXPOSE_MODELS` 过滤掉所有模型，Network 面板空白。

**解法**：login 成功后，启动一个**临时 CLIProxyAPI 实例**拉一次 `/v1/models`，取 id 列表回写 `config.seller.models`。

新函数 `runtime/cliproxy.ts`：

```ts
export async function discoverUpstreamModels(options: {
  upstream: SellerUpstream;
  cliproxySource: string;
  cliproxyWorkDir: string;
  cliproxyAuthDir: string;
  port?: number;
}): Promise<string[]> {
  const port = options.port ?? 4399; // 临时端口，避免和 seller cliproxy 冲突
  const child = spawn('node', ['scripts/run-cliproxy-probe.mjs'], { /* 传 env */ });
  // scripts/run-cliproxy-probe.mjs 启动 cliproxy、等 /v1/models 可用、打印 JSON、退出
  // 超时 20s
  // parse stdout 最后一行 JSON -> string[]
}
```

或者直接在 JS 里 spawn cliproxy + fetch，不走 scripts/。**推荐后者**，减少对 `scripts/` 的依赖（方便将来二进制分发）。

回写逻辑（`handleSellerLoginFromConsole` 第 4 步）：

```ts
async function refreshSellerModelsFromCliproxy(upstream: SellerUpstream): Promise<void> {
  try {
    const discovered = await discoverUpstreamModels({ upstream, /* ... */ });
    if (discovered.length === 0) {
      console.log(`警告：${upstream} 的 CLIProxyAPI 没返回任何模型。保持当前 config.seller.models 不变。`);
      return;
    }
    const { paths, ...body } = await loadCliConfig();
    await saveCliConfig({
      ...body,
      seller: { ...body.seller, models: discovered },
    });
    console.log(`已写入 ${discovered.length} 个可卖模型：${discovered.join(', ')}`);
  } catch (error) {
    console.log(`模型发现失败，跳过自动回写：${error instanceof Error ? error.message : error}`);
  }
}
```

onboarding 的 `seller_models` 步骤也应该调这个函数，取代 `SELLER_MODEL_PRESETS`。preset 只作为最终兜底（discovery 失败时用）。

### 2.4 端到端手工验证脚本

`docs/qa/seller-upstream-e2e.md`：

```
场景 A：全新机器登 Claude
  1. 清 ~/.clawmarket
  2. clawmarket → onboarding role=seller → upstream=claude
  3. seller_login 走 Anthropic OAuth 登录成功
  4. seller_models 看到真实的 claude-* id 列表（不是 preset 猜的）
  5. seller_start 启动
  6. curl http://127.0.0.1:8787/v1/seller/status | jq .backend.models
     → models 非空，且和 seller_models 步骤选的一致
  7. 另一台机器的 buyer 对这些模型发 chat 请求成功

场景 B：Console 里从 Codex 切到 Claude
  1. 已有 Codex seller 在跑
  2. 进 Seller 视图，选 "登录 Claude / 卖 Claude"
  3. Confirm Modal 确认 → Ink unmount → OAuth 流程 → 成功
  4. 自动回控制台；Events 栏看到 "已写入 N 个可卖模型"
  5. Seller 视图显示新的上游 + 模型列表
  6. ~/.clawmarket/auth.bak-<ts> 目录存在（老 Codex auth 的备份）

场景 C：登录失败回滚
  1. 已有 Codex auth
  2. 选 "换 Codex 账号"，OAuth 流程里 Ctrl-C 中断
  3. 控制台提示"登录失败，已恢复之前的登录"
  4. auth 目录内容还是原来那份（diff 对比）
  5. 原 seller 可以直接重启成功

场景 D：Gemini（同 A，跑一遍）
```

任何一个场景不过就不能合。

---

## 3. P1 — 在 Console 里做完整的账号管理

现状只有"切换上游"，缺"列当前账号、登出、在多个已登录账号间切换"。目标：**普通用户在 Console 里按上下键就能完成所有账号操作，不需要命令行**。

### 3.1 新增 `views/Accounts.tsx`（或并入 Seller 视图顶部）

建议做成独立 view，Nav 加一项 `Accounts`（钥匙图标）。Settings 视图里 `seller.cliproxyAuthDir` 那行的编辑入口可以去掉（用户不该手改这个路径）。

UI：

```
┌─ 账号 ─────────────────────────────────────────┐
│                                                │
│ 当前使用：Codex  ·  user@example.com           │
│ 状态：登录有效 · 上次使用 3 小时前              │
│ 登录文件：~/.clawmarket/auths                   │
│                                                │
│ 备份（可恢复）：                               │
│   • Claude  (anthropic-org-xxx)  5 天前        │
│   • Codex   (old@example.com)    10 天前       │
│                                                │
│ ┌──────────────────────────────────────────┐  │
│ │ [↵] 切换到 Claude 备份                    │  │
│ │     切换到 Codex 备份                     │  │
│ │     ────────────────                      │  │
│ │     登录新的 Codex 账号                   │  │
│ │     登录新的 Claude 账号                  │  │
│ │     登录新的 Gemini 账号                  │  │
│ │     ────────────────                      │  │
│ │     登出当前账号                          │  │
│ │     删除某个备份                          │  │
│ └──────────────────────────────────────────┘  │
└────────────────────────────────────────────────┘
```

### 3.2 识别"当前账号"

CLIProxyAPI 的 auth 文件通常是 JSON 或 yaml，含 email / org 等标识。**同事需要做的**：

1. 打开 `~/.clawmarket/auths/` 看 Codex / Claude / Gemini 登录后各自生成什么文件、结构是什么。
2. 在 `runtime/auth-inspector.ts` 写 `inspectAuthDir(dir: string)` 返回 `{ upstream, identity, lastUsedAt }`，规则按实际文件格式写。
3. identity 取不到就显示 "unknown (auth 文件存在)"，不要崩。

### 3.3 备份 / 恢复 / 切换

目录约定：
- 当前使用：`~/.clawmarket/auths/`（不变）
- 备份：`~/.clawmarket/auths.bak-<upstream>-<ISO>/`
- 每次"切换到新上游"自动备份当前；每次"切换回某个备份"会把当前再备份一次然后 rename 过来

函数：

```ts
// runtime/auth-manager.ts
export async function listAuthBackups(): Promise<Array<{
  path: string;
  upstream: SellerUpstream;
  identity: string | null;
  savedAt: string;
}>>;

export async function switchToBackup(backupPath: string): Promise<void>;
  // 1. 把当前 auths/ 备份为 auths.bak-<current-upstream>-<ts>
  // 2. rename backupPath → auths/
  // 3. 探测 upstream + 模型，回写 config.seller.{upstream, models}
  // 4. 调用方决定是否重启 seller

export async function logoutCurrent(): Promise<void>;
  // rename auths/ → auths.loggedout-<ts>（不物理删，保留 7 天兜底）
  // config.seller.upstream 保持不动（便于下次同上游登录复用）

export async function deleteBackup(backupPath: string): Promise<void>;
  // 物理删，带 ConfirmModal 二次确认
```

### 3.4 自动清理策略

后台 hook（`ConsoleApp` mount 时跑一次）：清理 `auths.loggedout-*` 里超过 7 天的目录，避免无限累积。输出到 Events 栏让用户知情。

### 3.5 命令面板 + CLI 子命令同步扩

- 命令面板加：
  - `Account: Switch backup` → 弹 SelectInput 列所有备份
  - `Account: Logout` → 确认后调 `logoutCurrent`
  - `Account: Login new Codex / Claude / Gemini`（= 现在已有的）
- CLI 子命令：
  - `clawmarket seller accounts list`
  - `clawmarket seller accounts switch <backup>`
  - `clawmarket seller accounts logout`
  - `clawmarket seller accounts delete <backup>`

非交互用户也能用。

---

## 4. 配额告警（锦上添花，P2）

用户说"额度用完了要换账号"——当前没有"提醒额度快用完了"的机制，用户只能从 chat 失败反推。CLIProxyAPI 调用上游失败时 HTTP 状态里通常能拿到 quota-exceeded 的明确信号（OpenAI 429 + specific code / Anthropic overloaded）。

在 seller-runtime 里 tail cliproxy 子进程 stderr，匹配关键词（`quota`, `billing`, `insufficient_quota`, `rate_limit_exceeded` 等），超过阈值（比如 5 分钟内 3 次）就往 Events 栏推：

```
[warn] Codex 账号可能额度用完（近 5 分钟 3 次 quota 错误）。建议在 Accounts 视图切换账号。
```

同时 Dashboard 顶部显示一个 ⚠️ 徽章。用户不用猜为什么 chat 一直失败。

这块依赖"tail cliproxy 日志到 seller-runtime 内存"的机制，工作量中等，放 P2。

---

## 5. 工期与 PR 拆分

| PR | 范围 | 估时 |
|---|---|---|
| **PR C1** | §1 接通 seller_login 链路 + §1.3 错误文案；手工过场景 C（回滚） | 0.5 d |
| **PR C2** | §2.1 CLIProxyAPI flag 验证 + §2.2 build 验证 + §2.3 动态模型发现；过场景 A/B/D | 1.5 d |
| **PR C3** | §3 Accounts 视图 + auth-manager + CLI 子命令 | 1.5 d |
| **PR C4**（可选） | §4 配额告警 | 0.5 d |
| **合计** | | **~4 人日**（C4 可选） |

**建议顺序**：C1 先合（修掉最刺眼的 bug），C2 紧跟（让 Claude/Gemini 真的能用），C3 再上（把体验做完整）。C4 看时间。

## 6. 交付 checklist

### PR C1
- [ ] `runInteractiveHome` 处理 `action === 'seller_login'`，带 wasRunning 判断 + restart
- [ ] `backupAuthDir` / `restoreAuthDir` 辅助函数（加单测）
- [ ] 登录失败自动 restore（场景 C 通过）
- [ ] `seller-runtime.ts:97-99` 错误文案改成指向 Console 操作
- [ ] Events 栏推"正在登录 … / 登录成功 / 已重启 seller"三条事件

### PR C2
- [ ] CLIProxyAPI 源码 grep 确认 Claude / Gemini 真实 flag，必要时发 PR 到 CLIProxyAPI
- [ ] `scripts/lib/embedded-cliproxy.mjs` flag 对齐实际名
- [ ] `runtime/cliproxy.ts` 新增 `discoverUpstreamModels`
- [ ] onboarding `seller_models` 步骤改为先 discover 后 preset 兜底
- [ ] `handleSellerLoginFromConsole` 成功后调 `refreshSellerModelsFromCliproxy` 并回写 config
- [ ] 场景 A/B/D 三个全过

### PR C3
- [ ] `runtime/auth-inspector.ts` 识别 Codex / Claude / Gemini auth 文件格式
- [ ] `runtime/auth-manager.ts` list/switch/logout/delete + 单测
- [ ] `views/Accounts.tsx` 新视图 + Nav 加项
- [ ] 命令面板 4 条新命令
- [ ] `clawmarket seller accounts {list,switch,logout,delete}` 子命令
- [ ] `auths.loggedout-*` 7 天清理策略
- [ ] Settings 视图去掉 `seller.cliproxyAuthDir` 的可编辑入口（改成只读显示）

### PR C4（可选）
- [ ] cliproxy stderr tail + quota 关键词匹配
- [ ] Events + Dashboard 徽章
- [ ] 单测 mock 子进程日志流

---

## 7. 不做的事

- ❌ 不做多账号并行出售（"同时用两个 Codex 账号做 round-robin"）。CLIProxyAPI 本身是单账号设计，改动太大。一次一个账号，备份里的是历史。
- ❌ 不做账号安全加密（auth 文件用户目录权限自行保护，CLI 不加密码）。
- ❌ 不在 Console 里做 OAuth UI 自绘。登录流程还是 Ink unmount → cliproxy stdio inherit → 完成后重挂。
- ❌ 不改 CLIProxyAPI 的 auth 文件格式。

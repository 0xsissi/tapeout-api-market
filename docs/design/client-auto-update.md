# Tapeout API Market 客户端自动更新系统 实施文档

> **适用范围**：`@clawmarket/cli`（Node CLI，命令名 `clawmarket`）
> **背景**：测试期需要真实用户参与，客户端 bug/协议变更需要能快速触达所有用户
> **设计哲学**：**不做"真·自动更新"（自动下载替换二进制），只做"版本检查 + 强制升级线 + 一键升级"**。原因见 §8。
> **优先级**：Step 1（服务端拦截）> Step 2（启动检查）> Step 3（self-update 糖）
> **预计工作量**：Step 1 约 0.5 天，Step 2 约 1 天，Step 3 约 0.5 天，合计 2 天

---

## 0. 名词约定

| 术语 | 含义 |
|---|---|
| `CLI_VERSION` | 客户端语义化版本号，从 `packages/cli/package.json` 读 |
| `minClientVersion` | 服务端强制的最低版本号。低于此版本的客户端请求会被 consumer-gateway / provider 拒绝 |
| `recommendedVersion` | 服务端建议的最新稳定版本。用于启动时 "有新版本可用" 的软提示 |
| `releasesFeed` | GitHub Releases 的 latest JSON，用于启动时版本检查 |

---

## 1. 总体架构

```
  ┌─────────────────────────────────────────────────────────┐
  │ CLI 启动                                                │
  │   ↓                                                     │
  │  1) 异步 fetch releasesFeed（2s 超时）                  │
  │  2) 本地 CLI_VERSION 与 latest 比对                    │
  │     - 低于 latest → 黄字软提示（不阻塞）                │
  │  3) 正常进入业务                                        │
  └─────────────────────────────────────────────────────────┘
                   │
                   ↓ 发起推理请求
  ┌─────────────────────────────────────────────────────────┐
  │ 请求头带 X-Claw-Client-Version: <CLI_VERSION>           │
  └─────────────────────────────────────────────────────────┘
                   │
                   ↓
  ┌─────────────────────────────────────────────────────────┐
  │ consumer-gateway / provider 侧                          │
  │  检查 CLI_VERSION >= minClientVersion ?                 │
  │   否 → 426 Upgrade Required + 升级指引                  │
  │   是 → 正常路由                                         │
  └─────────────────────────────────────────────────────────┘
```

**三道防线，各司其职**：
- **Step 1 服务端强制线（必做）**：出严重 bug 时全局拉闸
- **Step 2 启动软提示（必做）**：日常引导用户跟上版本
- **Step 3 `claw self-update` 子命令（可选）**：体验糖，一条命令完成升级

---

## 2. Step 1：服务端最低版本拦截【最高优先级】

**目标**：任何一台机器发版异常（比如 EIP-712 签名格式错），我们能在 5 分钟内全局禁掉该版本，避免污染 escrow 结算。

### 2.1 版本号在请求上如何传递

**buyer（CLI / consumer-gateway）→ consumer-gateway 本地 server**：
HTTP 层已经存在，直接加 header。

**buyer 的 consumer-gateway → seller 的 provider-gateway**（走 libp2p）：
在握手 metadata 里带 `clientVersion`。

#### 2.1.1 HTTP 本地 server 侧（local-server.ts）

`packages/consumer-gateway/src/local-server.ts`：
- 在 `/v1/chat/completions` 入口读取 request header `X-Claw-Client-Version`
  - 若 header 不存在：视为 `0.0.0`（老版本无 header 的兜底）
  - 日志带上该字段，便于事后统计
- 和本地配置 `minClientVersion`（见 §2.3）对比
  - 低于 → 立即返回 `426 Upgrade Required`，body 见 §2.4
  - 否则正常进入调度

> 注意：consumer-gateway 本身也是用户侧进程，这一步对自家 CLI 意义不大（CLI 和 consumer-gateway 一起升级）。**真正重要的是 §2.1.2 的 P2P 握手版本检查**，防止陈旧 buyer 端用错误协议打坏 seller。

#### 2.1.2 libp2p 握手 metadata（p2p-node）

`packages/p2p-node/src/index.ts`：
- 在建立 inference stream 的第一个 message 里附带：
  ```ts
  {
    clientVersion: CLI_VERSION,      // 0.2.0
    protocolVersion: PROTOCOL_VERSION, // 2.0.0
  }
  ```
- seller 侧 provider-gateway 收到后：
  - `clientVersion < minClientVersion` → 回 `{ error: 'client_upgrade_required', minClientVersion, upgradeUrl }`，并 `stream.close()`
  - 记录拒绝计数到本地 metrics

**兼容性兜底**：老版本 buyer 不会发这个字段。为了不直接把所有老用户打死，**灰度期 minClientVersion 设为 `0.0.0`（放行所有）**。等新客户端都升级后再上调。

### 2.2 服务端版本配置来源

和 scheduler config 复用同一套机制（`SchedulerConfigManager`），避免重复造轮子。

`packages/shared/src/types/index.ts` 扩展：
```ts
export interface ClientVersionPolicy {
  minClientVersion: string;       // 例: "0.2.0"
  recommendedVersion: string;     // 例: "0.2.3"
  upgradeUrl: string;             // 例: "https://github.com/xxx/clawmarket/releases"
  bannedVersions?: string[];      // 例: ["0.2.1"]  明确黑名单（比上下限更精细）
  upgradeMessage?: string;        // 展示给用户的中文文案
}
```

配置位置（和 scheduler config 同一文件或平级）：
- 本地文件：`~/.clawmarket/client-policy.json`
- 环境变量覆盖：`CLAW_MIN_CLIENT_VERSION`, `CLAW_RECOMMENDED_VERSION`
- 默认值（安全默认）：`minClientVersion = "0.0.0"`, `recommendedVersion = CLI_VERSION`

**运维操作路径**：
1. 发现 0.2.1 有 bug → 编辑 `~/.clawmarket/client-policy.json`
2. 设 `"bannedVersions": ["0.2.1"]` 或 `"minClientVersion": "0.2.2"`
3. 配置热加载生效（参照 scheduler config 的 polling 机制，1s 生效）
4. 新请求立即被拦截

### 2.3 版本比较工具函数

新建 `packages/shared/src/version.ts`：

```ts
/**
 * 比较两个 semver（不支持 prerelease、build metadata）
 * 返回 -1 / 0 / 1
 */
export function compareVersion(a: string, b: string): -1 | 0 | 1;

/**
 * 判断 client 版本是否被策略放行
 * - 低于 minClientVersion → false
 * - 在 bannedVersions 中 → false
 * - 其他 → true
 */
export function isClientVersionAllowed(
  clientVersion: string,
  policy: ClientVersionPolicy,
): { allowed: boolean; reason?: 'below_min' | 'banned' };
```

**必须单元测试覆盖**：
- `0.1.9` vs `0.2.0` → -1
- `0.2.0` vs `0.2.0` → 0
- `1.0.0` vs `0.9.99` → 1
- `0.2.0-dev` 当作 `0.2.0` 处理（去掉 prerelease 后缀）
- 非法输入（如空字符串、`abc`）→ 返回 0 并打 warn（不阻塞）

### 2.4 426 响应体格式（HTTP 侧）

```json
{
  "error": {
    "type": "client_upgrade_required",
    "message": "客户端版本过低，请升级到 v0.2.3 及以上",
    "minClientVersion": "0.2.2",
    "recommendedVersion": "0.2.3",
    "upgradeUrl": "https://github.com/<org>/clawmarket-releases/releases/latest",
    "upgradeCommand": "tam self-update"
  }
}
```

CLI 侧收到 426 时特殊处理：**打印醒目的中文升级提示后 exit(2)**，不进入重试逻辑。

### 2.5 Step 1 验收清单

- [ ] `packages/shared/src/version.ts` + 单测（至少 8 个用例）
- [ ] `ClientVersionPolicy` 类型定义
- [ ] `ClientPolicyManager`（参照 `SchedulerConfigManager` 写法，含热加载）+ 单测
- [ ] `local-server.ts` 的 `/v1/chat/completions` 入口读 header + 拦截
- [ ] `p2p-node` 握手带 `clientVersion` + seller 侧拦截
- [ ] 老 CLI 无 header 场景（视为 `0.0.0`）兼容性测试
- [ ] 426 响应对应的 CLI 展示测试（ink 快照）

---

## 3. Step 2：启动时版本软检查

**目标**：用户启动 CLI 时，如果有新版本就友好提示，但不阻塞启动。

### 3.1 版本源：公开 release 仓库（Public Release Repo）

**核心思路**：在 GitHub 上**另建一个空仓库**专门存放编译产物，设为 public。**源码仓库继续保持私有**。

```
github.com/<org>/clawmarket           ← 私有，存源码（当前仓库）
github.com/<org>/clawmarket-releases  ← 公开，只存编译产物 + Release 说明
```

**为什么选这个方案**：
- **源码零暴露**：release 仓库里只有编译后的 tarball，连 commit history 都是干净的（只有 release 自动提交）
- **不需要 npm 公开发布**：避免把 `@clawmarket/cli`、`consumer-gateway`、`shared` 等包推到 npm
- **零成本**：GitHub Releases 自带 CDN，完全免费
- **API 公开可访问**：release 仓库是 public 的，`/releases/latest` 接口不需要 token
- **零自建基础设施**：不用买服务器、不用买对象存储

**对比其他方案**：
- ❌ **直接发 npm**：会把 workspace 里所有依赖包也必须公开，源码相当于被间接暴露
- ❌ **私有仓库 Releases**：API 需要 PAT token，不能随客户端分发
- ❌ **自建 CDN**：要额外买/维护服务器
- ✅ **公开 release 仓库**：最简单、零泄漏、零成本

### 3.1.1 版本查询 API

**endpoint**：
```
GET https://api.github.com/repos/<org>/clawmarket-releases/releases/latest
```

**无需认证**（公开仓库）。返回示例：
```json
{
  "tag_name": "v0.2.3",
  "name": "TAM CLI v0.2.3",
  "body": "## Changelog\n- Fix EIP-712 ...",
  "published_at": "2026-04-22T10:00:00Z",
  "html_url": "https://github.com/<org>/clawmarket-releases/releases/tag/v0.2.3",
  "assets": [
    {
      "name": "clawmarket-macos-arm64.tar.gz",
      "browser_download_url": "https://github.com/<org>/clawmarket-releases/releases/download/v0.2.3/clawmarket-macos-arm64.tar.gz",
      "size": 12345678,
      "digest": "sha256:..."
    },
    {
      "name": "clawmarket-linux-x64.tar.gz",
      "browser_download_url": "..."
    },
    {
      "name": "clawmarket-win-x64.zip",
      "browser_download_url": "..."
    },
    {
      "name": "SHA256SUMS",
      "browser_download_url": "..."
    }
  ]
}
```

**CLI 里拿到这个 JSON 之后**：
- 从 `tag_name` 去掉前缀 `v` → 版本号 `0.2.3`
- 和本地 `CLI_VERSION` 比对
- 若有新版本，把 `html_url`（Release 页面链接）展示给用户

### 3.1.2 release 仓库的内容结构

**是什么**：
- 一个完全独立的公开仓库，只用来挂 Releases
- `main` 分支可以只放一个 README 说明这是发布分发仓库，指向主站
- 所有实质内容都通过 GitHub Releases 的 Assets 挂载（二进制/tarball）

**不要做**：
- ❌ 不要把主仓库的 source 推过来（`git push --mirror`）
- ❌ 不要把 `dist/` 目录用 git 管理（文件大、churn 多）
- ✅ 只用 `gh release create` 上传 asset，不 commit 任何编译产物到 git

### 3.1.3 Release 产物（Assets）

每次发版必须上传这几个文件：

| 文件名 | 内容 | 用途 |
|---|---|---|
| `clawmarket-macos-arm64.tar.gz` | 解压后是 `dist/` 目录（编译后的 JS）+ 一个启动脚本 | Apple Silicon Mac |
| `clawmarket-macos-x64.tar.gz` | 同上 | Intel Mac |
| `clawmarket-linux-x64.tar.gz` | 同上 | 大多数 Linux 桌面/服务器 |
| `clawmarket-linux-arm64.tar.gz` | 同上 | ARM 服务器（树莓派、AWS Graviton） |
| `clawmarket-win-x64.zip` | 同上（换成 `.cmd` 启动脚本） | Windows |
| `SHA256SUMS` | 所有上述文件的 sha256 校验和清单 | 完整性校验 |
| `install.sh` | 一键安装脚本（curl \| bash 入口） | 首次安装便利 |

**现阶段推荐**：先只打 **"通用 Node tarball"** 一种——里面放编译后的 JS + `node_modules/`（或 `package.json` 让用户自己 `npm i`）。这样不用处理跨平台编译。用户需要自己本地装 Node 18+。等稳定后再用 `bun build --compile` 做成独立二进制，免 Node 依赖。

**首版就一个文件就够了**：
- `clawmarket-v0.2.3.tar.gz` —— 解压后是完整可运行的 Node 项目
- `SHA256SUMS`

### 3.1.4 tarball 里的目录结构

```
clawmarket-v0.2.3/
├── dist/                        # 编译后的 JS（所有 workspace 包都 bundle 进来）
│   └── index.js
├── package.json                 # 精简版，只列运行时必需的 npm 依赖
├── node_modules/                # 可选：一起打进来省去用户 npm install
├── bin/
│   └── clawmarket               # 启动脚本：exec node "$DIR/../dist/index.js" "$@"
├── LICENSE
└── README.md                    # 简短安装说明
```

**install.sh 做的事**（用户执行 `curl -L <url>/install.sh | bash`）：
1. 探测平台（uname -sm）
2. 下载对应的 tarball
3. 校验 sha256（从 `SHA256SUMS` 读）
4. 解压到 `~/.clawmarket/releases/v0.2.3/`
5. 创建软链 `~/.local/bin/clawmarket → ~/.clawmarket/releases/v0.2.3/bin/clawmarket`
6. 提示用户把 `~/.local/bin` 加到 PATH

### 3.2 实现细节

新建 `packages/cli/src/update-check.ts`：

```ts
export interface UpdateCheckResult {
  current: string;          // 0.2.0
  latest: string | null;    // 0.2.3 或 null（查询失败）
  hasUpdate: boolean;
  releaseUrl?: string;      // Release 页面链接，可以给用户点
  tarballUrl?: string;      // 供 self-update 子命令下载用
  sha256?: string;          // 从 assets 里的 SHA256SUMS 文件解析
  releaseNotes?: string;    // 截断到 200 字符
}

export async function checkForUpdate(options?: {
  feedUrl?: string;         // 默认 https://api.github.com/repos/<org>/clawmarket-releases/releases/latest
  timeoutMs?: number;       // 默认 2000
  cacheFilePath?: string;   // 默认 ~/.clawmarket/update-cache.json
  cacheTTLMs?: number;      // 默认 6 * 60 * 60 * 1000（6 小时）
  skip?: boolean;           // --skip-update-check 或 CLAW_SKIP_UPDATE_CHECK=1
}): Promise<UpdateCheckResult>;
```

**默认 feed URL**（常量写死在代码里，环境变量可覆盖）：
```
https://api.github.com/repos/<org>/clawmarket-releases/releases/latest
```

**行为约定**：
1. 若 `skip=true`，立即返回 `{ hasUpdate: false, latest: null, current: CLI_VERSION }`
2. 先读 cache 文件。若 cache 未过期 → 直接返回 cache（零网络延迟）
3. fetch GitHub API，2 秒超时
4. 超时 / 失败 → warn 到 debug log，返回 `latest: null`（**不报错，不阻塞启动**）
5. 成功 → 解析 `tag_name`、选择当前平台对应的 asset `browser_download_url`、从 `SHA256SUMS` asset 解析校验和
6. 写入 cache 文件，返回结果
7. `AbortController` 保证进程退出不被 fetch 拖住

**GitHub API 速率限制处理**：
- 未认证的 GitHub API 限制 60 次/小时/IP
- 我们有 6 小时 cache，一个用户一天最多 4 次请求，远低于限制
- 若碰到 403 rate limited → 当作网络失败处理，使用 cache 值或返回 `latest: null`

### 3.3 展示位置

`packages/cli/src/index.ts` 或 TUI 入口：
```
启动时并行两件事：
  - 异步开始 checkForUpdate()（不 await）
  - 同步进入正常流程

在主菜单/TUI 首屏渲染完成后，若检查结果已到：
  - hasUpdate === true → 在顶部/底部固定区展示：
    ┌────────────────────────────────────────────────────┐
    │ ⚠  有新版本可用：v0.2.3（当前 v0.2.0）            │
    │    一键升级：tam self-update               │
    │    Release:  https://github.com/.../v0.2.3        │
    └────────────────────────────────────────────────────┘
  - 其他情况：不渲染这块（完全静默）
```

### 3.4 环境变量开关

- `CLAW_SKIP_UPDATE_CHECK=1` → 跳过检查（CI / 离线环境友好）
- `CLAW_UPDATE_FEED_URL=<custom-url>` → 覆盖 feed 地址（方便内测渠道）

**内测渠道怎么做**：
- 主线版本走默认 feed（`clawmarket-releases/releases/latest`）
- 内测版本打 GitHub pre-release（在 Release 页面勾选 "This is a pre-release"）
- 内测用户设置 `CLAW_UPDATE_FEED_URL=https://api.github.com/repos/<org>/clawmarket-releases/releases`（去掉 `/latest`），CLI 里取数组第一个作为最新版（包含 prerelease）
- 或者直接另建一个 `clawmarket-releases-beta` 仓库做 beta 渠道

### 3.5 Step 2 验收清单

- [ ] `update-check.ts` + 单测（mock fetch，覆盖超时、失败、成功、cache 命中）
- [ ] cache 文件读写（损坏时自动忽略、重建）
- [ ] `--skip-update-check` CLI flag
- [ ] `CLAW_SKIP_UPDATE_CHECK` / `CLAW_UPDATE_FEED_URL` 环境变量
- [ ] TUI 展示组件 + ink 快照测试
- [ ] 离线环境启动不卡顿（手动测：断网后 `clawmarket --help` 启动时间 < 500ms）

---

## 4. Step 3：`tam self-update` 子命令

**目标**：用户一条命令完成"下载 → 校验 → 替换 → 重启指引"全流程。

### 4.1 用户视角

```
$ tam self-update
🔍 检查最新版本...
   当前: v0.2.0
   最新: v0.2.3

📋 更新内容:
   - Fix EIP-712 signature format
   - Add sticky session stability

继续升级吗？[y/N] y

📥 下载 clawmarket-v0.2.3.tar.gz (4.2 MB)...
   ████████████████████ 100%
🔐 校验 SHA256... ✓
📦 解压到 ~/.clawmarket/releases/v0.2.3/...
🔗 切换软链 ~/.local/bin/clawmarket → v0.2.3 ✓

✅ 升级完成
   请重新启动 clawmarket
```

### 4.2 核心逻辑

新建 `packages/cli/src/commands/self-update.ts`：

```ts
export async function runSelfUpdate(options: {
  feedUrl?: string;          // 默认用 update-check 的 feed
  installDir?: string;       // 默认 ~/.clawmarket/releases
  symlinkPath?: string;      // 默认 ~/.local/bin/clawmarket
  targetVersion?: string;    // 不指定则升级到最新
  dryRun?: boolean;          // 只显示会做什么，不执行
  yes?: boolean;             // 跳过确认（--yes / -y）
}): Promise<void>;
```

**执行步骤**：
1. **查询最新版本**：调用 `checkForUpdate()`，拿到 `tarballUrl` 和 `sha256`
2. **已是最新？** 直接返回"无需升级"
3. **用户确认**：显示 changelog 摘要 + yes/no 提示（除非 `--yes`）
4. **创建目录**：`~/.clawmarket/releases/v<version>/`（若已存在先检查是否完整，完整则跳过下载）
5. **下载 tarball**：
   - 下载到临时文件 `tmp-XXX.tar.gz`
   - 使用 `AbortController` + 超时 60 秒
   - 失败自动重试 2 次
   - 显示进度条（可用 `cli-progress` 或自己写简单的）
6. **校验 SHA256**：
   - 下载 `SHA256SUMS` asset（同一个 Release 的 assets）
   - 解析出当前 tarball 对应的 hash
   - 对本地文件做 sha256，比对
   - **不匹配直接报错退出**，**绝不继续**
7. **解压**：用 Node 的 `tar`（`tar -xzf` 或 `node-tar` npm 包）解压到 `~/.clawmarket/releases/v<version>/`
8. **原子切换软链**：
   ```
   ln -sf ~/.clawmarket/releases/v0.2.3/bin/clawmarket ~/.local/bin/clawmarket
   ```
   **必须原子**：用 `fs.symlink` 写到临时路径再 `fs.rename` 覆盖，中途失败不会留下半坏的链接
9. **清理旧版本**（可选）：保留最近 3 个版本，更早的自动清理，用户可用 `--keep-all` 关闭
10. **提示用户重启**

### 4.3 安装目录布局

```
~/.clawmarket/
├── config.json                  # 用户配置（已有）
├── client-policy.json           # §2 的策略文件
├── update-cache.json            # §3 的版本检查 cache
└── releases/                    # 历史版本
    ├── v0.2.1/
    ├── v0.2.2/
    └── v0.2.3/                  # ← 软链指向这里
        ├── dist/
        ├── node_modules/
        ├── package.json
        └── bin/clawmarket
```

软链：`~/.local/bin/clawmarket → ~/.clawmarket/releases/v0.2.3/bin/clawmarket`

**回滚机制**：用户随时可以手动改软链指回旧版本：
```
ln -sf ~/.clawmarket/releases/v0.2.1/bin/clawmarket ~/.local/bin/clawmarket
```
或者提供子命令：
```
tam self-update --rollback          # 回到上一个版本
tam self-update --rollback v0.2.1   # 回到指定版本
tam self-update --list              # 列出本地已装版本
```

### 4.4 安全红线（必须遵守）

- ✅ **SHA256 校验必须通过**，失败则绝不替换当前版本
- ✅ **HTTPS 强制**：feed URL 和 tarball URL 必须是 `https://`，硬编码检查，不接受 `http://`
- ✅ **域名白名单**：只允许从 `github.com` 和 `*.github.com`（objects.githubusercontent.com 等）下载。环境变量覆盖也必须在白名单内，否则拒绝
- ❌ **不自动 sudo**：若目标路径无写入权限（EACCES），打印指引让用户自己处理
- ❌ **不执行 tarball 内的任意脚本**：只认固定的 `bin/clawmarket` 入口
- ❌ **不信任 Release body 里的任何链接**：所有下载地址必须来自 GitHub API 返回的 `assets[].browser_download_url`，不解析用户可编辑的 release notes

### 4.5 Step 3 验收清单

- [ ] `self-update` 子命令注册（commander）
- [ ] 下载 + 进度条 + 超时 + 重试
- [ ] SHA256 校验（测试：故意改一个字节，必须拒绝安装）
- [ ] 原子软链切换（测试：中断切换过程，旧链接仍可用）
- [ ] `--rollback` / `--list` / `--dry-run` / `--yes` 子选项
- [ ] HTTPS 白名单拦截（测试：设 `CLAW_UPDATE_FEED_URL=http://evil.com` 必须被拒绝）
- [ ] 旧版本自动清理（保留 3 个）
- [ ] 权限错误友好提示（测试：在 `/usr/local/bin` 这种无权限的软链路径下报 EACCES）
- [ ] 手动测通 macOS / Linux 至少两平台

---

## 5. 客户端版本上报（Telemetry）

测试期必做。当出现大范围异常时，我们需要立刻知道"出问题的是哪个版本"。

### 5.1 集成点

在 `SchedulerLogger` 的每条 `[SCHED]` 日志里加字段：
```ts
clientVersion: CLI_VERSION,
```

`packages/consumer-gateway/src/scheduler/logger.ts`：在 `DecisionLog` 接口加字段，在 `DecisionLogBuilder` 的 startRequest 里填。

### 5.2 Admin endpoint 扩展

`GET /admin/scheduler/summary` 返回值新增：
```ts
{
  total: 100,
  successRate: 0.98,
  clientVersions: {   // ← 新增
    "0.2.0": 80,
    "0.2.3": 20,
  }
}
```

方便运维一眼看出版本分布。

### 5.3 Step 5 验收清单

- [ ] 日志字段增加
- [ ] summary 接口按版本分桶
- [ ] 单测覆盖

---

## 6. 发版流程（给运维/发版同事）

### 6.0 一次性准备工作（只做一次）

#### 6.0.1 创建 release 仓库

- [ ] 在 GitHub 上创建新仓库 `<org>/clawmarket-releases`，**设为 Public**
- [ ] 默认分支只放一个 README.md：
  ```markdown
  # TAM Releases
  This repository hosts compiled binaries for TAM CLI.
  Source code is maintained privately.
  Download the latest version: [Releases](../../releases/latest)
  ```
- [ ] 仓库设置里关掉 Issues、Projects、Wiki（不需要）
- [ ] **保护默认分支**：禁止直接 push，只允许通过 release 流程

#### 6.0.2 本地环境

- [ ] 安装 GitHub CLI：`brew install gh`（或 apt install gh）
- [ ] `gh auth login` 登录 GitHub 账号，授权 `repo` 和 `workflow` scope
- [ ] 验证：`gh release list --repo <org>/clawmarket-releases` 返回空列表

#### 6.0.3 源码仓库配置

- [ ] 在主源码仓库添加一个 npm script 用于打包：
  ```json
  // packages/cli/package.json
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --minify",
    "package": "node ../../scripts/package-release.mjs"
  }
  ```
- [ ] 新建 `scripts/package-release.mjs`（发版打包脚本）做：
  1. `pnpm -r build`（编译所有 workspace 包）
  2. 把 CLI 的 `dist/` + 必要的 `node_modules/` + `bin/clawmarket` 启动脚本收集到 `release-build/clawmarket-v<VERSION>/`
  3. `tar -czf release-build/clawmarket-v<VERSION>.tar.gz -C release-build clawmarket-v<VERSION>`
  4. 生成 `release-build/SHA256SUMS`
- [ ] 把 `scripts/package-release.mjs` 和它的输出路径加到 **主仓库的 `.gitignore`**（不要把编译产物提交到源码仓库）

#### 6.0.4 bin/clawmarket 启动脚本

放在 `packages/cli/bin/clawmarket`（打包时拷贝到 tarball 里）：
```sh
#!/usr/bin/env bash
set -e
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
exec node "$DIR/../dist/index.js" "$@"
```
Windows 同理提供 `bin/clawmarket.cmd`（首版可以先不做）。

### 6.1 每次发版的 checklist

假设要发 `v0.2.3`：

- [ ] **1. 源码**：在主仓库的 release 分支上把 `packages/cli/package.json` 的 `version` 改成 `0.2.3`
- [ ] **2. 打 tag**：`git tag v0.2.3 && git push origin v0.2.3`（打到主仓库，内部使用）
- [ ] **3. 构建 tarball**：
  ```bash
  pnpm install --frozen-lockfile
  pnpm -r build
  pnpm --filter @clawmarket/cli package
  ```
  产物：`release-build/clawmarket-v0.2.3.tar.gz` + `release-build/SHA256SUMS`
- [ ] **4. 本地烟囱测试**：
  ```bash
  tar -xzf release-build/clawmarket-v0.2.3.tar.gz -C /tmp
  /tmp/clawmarket-v0.2.3/bin/clawmarket --version   # 应输出 0.2.3
  /tmp/clawmarket-v0.2.3/bin/clawmarket --help      # 应正常显示帮助
  ```
  **不过则立即停止发版**
- [ ] **5. 写 Release notes**（`release-notes.md`）：
  ```markdown
  ## Changelog
  - Fix EIP-712 signature format
  - Add sticky session stability

  ## Upgrade
  **Force upgrade**: No
  **Protocol change**: No
  **Signature format change**: No

  ## Install / Upgrade
  \`\`\`
  tam self-update
  \`\`\`
  Or fresh install:
  \`\`\`
  curl -L https://github.com/<org>/clawmarket-releases/releases/latest/download/install.sh | bash
  \`\`\`
  ```
- [ ] **6. 上传到 release 仓库**：
  ```bash
  gh release create v0.2.3 \
    release-build/clawmarket-v0.2.3.tar.gz \
    release-build/SHA256SUMS \
    install.sh \
    --repo <org>/clawmarket-releases \
    --title "TAM CLI v0.2.3" \
    --notes-file release-notes.md
  ```
  加 `--prerelease` 发 beta 版。
- [ ] **7. 验证 API 能拿到**：
  ```bash
  curl -s https://api.github.com/repos/<org>/clawmarket-releases/releases/latest | jq '.tag_name'
  # 应返回 "v0.2.3"
  ```
- [ ] **8. 本机测试自升级**：在一台装着旧版本的机器跑 `tam self-update`，确认全流程通过
- [ ] **9. 若为强制升级版本**：
  1. 先完成上面 1-8 步
  2. 观察新版本用户自发升级 ≥ 24 小时
  3. 再调整所有公网 consumer-gateway / provider-gateway 的 `minClientVersion`
  4. **不要同时做**：否则老客户端立刻挂，但新客户端还没扩散

### 6.2 可选：用 GitHub Actions 自动化

当手动流程稳定后，可以把 §6.1 的 3-6 步搬到主源码仓库的 GitHub Actions 里：

- 触发条件：推送 `v*` tag
- Workflow 做的事：
  1. checkout + pnpm install + build
  2. 跑 tarball 打包脚本
  3. 用 `peaceiris/actions-push-release` 或直接 `gh release create --repo <org>/clawmarket-releases` 上传到**另一个仓库**（需要配置 GH_RELEASE_TOKEN secret，该 token 对 release 仓库有 write 权限）
- 优点：把发版动作从本地开发机挪到 CI，不怕本地环境污染
- 暂时不急，手动发版先跑通流程再说

### 6.2 紧急拉闸 SOP（出 bug 时）

1. 判断严重等级：是否污染 escrow / 签名 / 支付？是 → 走拉闸；否 → 只软提示
2. 编辑 `~/.clawmarket/client-policy.json`：
   ```json
   {
     "bannedVersions": ["0.2.1"],
     "upgradeMessage": "v0.2.1 存在签名 bug，请升级到 v0.2.2"
   }
   ```
3. 所有 gateway 节点在 1 秒内热加载
4. 受影响用户的请求返回 426，带明确升级提示
5. 发公告（Discord / Twitter）

---

## 7. 目录 & 文件清单（给同事直接照着建）

```
packages/shared/src/
├── version.ts                   [新建] 版本比较工具
├── version.test.ts              [新建] 单测
└── types/index.ts               [改]   加 ClientVersionPolicy 类型

packages/consumer-gateway/src/
├── client-policy/               [新建目录]
│   ├── policy-manager.ts        仿 SchedulerConfigManager
│   ├── policy-manager.test.ts
│   └── middleware.ts            426 拦截中间件
├── local-server.ts              [改]   入口加 middleware 调用
└── scheduler/logger.ts          [改]   加 clientVersion 字段

packages/p2p-node/src/
└── index.ts                     [改]   握手带 clientVersion + seller 侧拦截

packages/cli/
├── bin/
│   ├── clawmarket               [新建] bash 启动脚本（打包进 tarball）
│   └── clawmarket.cmd           [新建，可选] Windows 启动脚本
└── src/
    ├── update-check.ts          [新建] 启动检查
    ├── update-check.test.ts     [新建] 单测
    ├── commands/
    │   ├── self-update.ts       [新建] self-update 子命令
    │   └── self-update.test.ts  [新建] 单测
    ├── index.ts                 [改]   引入 update-check + 注册 self-update
    └── tui/console/index.tsx    [改]   展示升级提示组件

scripts/
├── package-release.mjs          [新建] 打 tarball + 生成 SHA256SUMS
└── install.sh                   [新建] curl | bash 一键安装脚本

.github/workflows/
└── release.yml                  [可选] 自动化发版（§6.2，后期加）

docs/design/
└── client-auto-update.md        [本文档]
```

### 7.1 release 仓库内容（独立仓库）

```
<org>/clawmarket-releases/       [新建的公开仓库]
├── README.md                    说明 + 指向主站
└── (没有其他源文件，所有内容通过 Releases 挂载)
```

---

## 8. 方案取舍记录

给同事的背景，便于评审时对齐方向。

### 8.1 为什么选"公开 release 仓库"

| 方案 | 优点 | 缺点 | 决策 |
|---|---|---|---|
| 发 npm（公开） | 生态标准 | CLI + 所有 workspace 依赖都必须公开发布，**源码大量暴露** | ❌ 不做 |
| 私有 GitHub Releases | 仓库不公开 | API 需要 PAT token，无法随客户端分发；token 轮转麻烦 | ❌ 不做 |
| **公开 release 仓库**（本方案） | 源码零暴露、API 免认证、GitHub 免费 CDN、`gh release create` 一条命令发版 | 要维护一个额外的公开空仓库 | ✅ **采用** |
| 自建 CDN / 对象存储 | 完全自主可控 | 要买/运维服务器、处理带宽费用 | 备选，未来商业化后再考虑 |

### 8.2 为什么不做"真·静默自动更新"

| 行为 | 优点 | 缺点 | 决策 |
|---|---|---|---|
| 静默后台下载替换 | 用户无感 | 去中心化项目用户天然警惕静默行为；支付/签名 bug 版本可能被自动推给用户 | ❌ 不做 |
| 启动时提示 + 用户确认触发升级 | 透明可控 | 多一步确认 | ✅ **本方案** |
| 服务端强制拦截旧版本 | 出事时救命 | 维护 minClientVersion 纪律 | ✅ **本方案（Step 1）** |
| Electron / Squirrel 差分更新 | 流量小 | 需代码签名、复杂基础设施 | ❌ 测试期不值 |

**核心原则**：在一个涉及签名、支付、escrow 的去中心化项目上，**可解释性和可审计性** 比"丝滑体验"重要。每一次升级都应该是用户主动确认的，我们只负责"及时告知 + 强制红线"。

---

## 9. 实施顺序建议

**Day 0（发版基础设施，运维同事做）**：
- 建 `clawmarket-releases` 公开仓库（5 分钟）
- 写 `scripts/package-release.mjs` 打包脚本 + `bin/clawmarket` 启动脚本
- 手动跑完一次发版流程（§6.1 1-7 步）把 `v0.0.1-bootstrap` 发出来作为基线
- 本地用 curl 能拿到 `releases/latest` JSON → 基础设施就绪

**Day 1（上午）**：Step 1 全部
- version.ts + 单测
- ClientVersionPolicy + ClientPolicyManager
- local-server 和 p2p-node 双侧拦截
- 本地手动跑通 "改 policy 文件 → 请求被 426" 流程

**Day 1（下午）**：Step 2 全部
- update-check.ts + 单测
- CLI 入口集成
- TUI 展示组件
- 断网启动速度回归

**Day 2（上午）**：Step 3
- self-update 子命令 + 下载 + SHA256 校验 + 解压 + 软链切换
- rollback / list 子选项
- 手动测 macOS + Linux

**Day 2（下午）**：Telemetry §5 + 总验收
- 日志字段
- summary 分桶
- 跑一遍 §11 总验收

---

## 10. 和现有调度系统 phase 规划的关系

- Step 1（服务端拦截）**必须在 scheduling Phase 1 灰度前完成**。否则一旦 scheduler 改出 bug，我们没有办法快速禁用受影响版本
- Step 2/3 可以与 scheduling Phase 1 并行开发
- Telemetry §5 和 scheduling Phase 0 的日志系统已存在，只是加字段，工作量 < 1 小时

---

## 11. 上线前总验收

### 11.1 基础设施（运维）
- [ ] `<org>/clawmarket-releases` 公开仓库已建，Issues/Wiki 已关
- [ ] `curl https://api.github.com/repos/<org>/clawmarket-releases/releases/latest` 返回 200 + 有效 JSON（至少有一个 release）
- [ ] `scripts/package-release.mjs` 在干净机器上能跑通，输出的 tarball 本地解压后可运行

### 11.2 服务端强制拦截（§2）
- [ ] 假装 CLI 版本为 0.1.0，服务端 minClientVersion 设 0.2.0，发请求 → 收到 426 + 中文升级提示
- [ ] 同上场景走 P2P 握手 → seller 端拒绝 stream，CLI 打印升级提示
- [ ] 紧急拉闸 SOP 走一遍：改 `~/.clawmarket/client-policy.json` → 1 秒内全节点生效
- [ ] 无 `X-Claw-Client-Version` header 的老客户端请求（视为 `0.0.0`）：minClientVersion=0.0.0 时通过，minClientVersion=0.1.0 时拒绝

### 11.3 启动检查（§3）
- [ ] 启动 CLI，断网 → 启动时间 < 500ms，无红字报错
- [ ] 启动 CLI，联网且版本落后 → TUI 顶部显示黄字升级提示，不阻塞操作
- [ ] `CLAW_SKIP_UPDATE_CHECK=1 clawmarket` → 不发起网络请求（用 `sudo tcpdump -i any host api.github.com` 验证）
- [ ] 故意 stub `CLAW_UPDATE_FEED_URL=http://not-github/` → **必须被白名单拦截**，不发请求
- [ ] cache 文件损坏（写入一个 `{` 进去）→ 启动正常，自动重建 cache

### 11.4 self-update（§4）
- [ ] `tam self-update` → 下载 + 校验 + 解压 + 切软链全流程成功
- [ ] 故意篡改 tarball（`truncate` 掉 1 字节）→ **SHA256 校验失败，拒绝安装，保留旧版本**
- [ ] `tam self-update --rollback` → 正确回到上一个版本
- [ ] `tam self-update --list` → 正确列出本地已装版本
- [ ] 下载过程 Ctrl+C 中断 → 临时文件清理，旧版本不受影响
- [ ] 目标软链路径无权限 → 打印友好 EACCES 提示，不 crash

### 11.5 Telemetry（§5）
- [ ] admin summary 接口返回 clientVersions 分桶，数字正确
- [ ] `[SCHED]` 日志每条都含 clientVersion 字段

### 11.6 跨平台
- [ ] macOS arm64 上完整走一遍 Step 1-3
- [ ] Linux x64 上完整走一遍 Step 1-3
- [ ] Windows：至少验证 Step 1/2（self-update 首版可不覆盖）

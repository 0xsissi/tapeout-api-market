# CLI Onboarding V2 — 让新机器真正能跑通

**前置**：本文补充 `docs/design/cli-redesign.md` 的阶段 0。现行 onboarding 在全新机器上跑不通（买家钱包没钱 / 没 gas；卖家只支持 Codex、模型写死）。本文是把它修到"能用"的详细开发计划。

**链环境**：Base Sepolia（chainId `84532`，RPC `https://sepolia.base.org`，项目 USDC `0xcF0819eb156D6c6c1c5d9A515E351D2D1aefff7D`）。不要使用官方 Base Sepolia 测试 USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`。

**支持的反代上游**：Codex / Claude / Gemini 共 3 种。

---

## 0. 最终步骤清单（对照当前）

| # | 现在（v1） | 新版（v2） | 变更 |
|---|---|---|---|
| 1 | role | role | — |
| 2 | buyer_wallet | buyer_wallet | 改：展示钱包地址 + 二维码 |
| 3 | buyer_start | buyer_start | — |
| 4 | — | **buyer_fund** | **新增**：检查 USDC + ETH 余额，不足时显示收款地址二维码 + 水龙头链接 |
| 5 | buyer_model | buyer_model | — |
| 6 | buyer_purchase | buyer_purchase | 改：提交前先校验余额，不够直接提示 |
| 7 | seller_wallet | seller_wallet | 改：展示钱包地址 + 二维码（gas 用） |
| 8 | — | **seller_upstream** | **新增**：选 Codex / Claude / Gemini |
| 9 | seller_login | seller_login | 改：按 upstream 分支跑对应 login |
| 10 | — | **seller_models** | **新增**：按 upstream 给候选模型清单，多选 |
| 11 | seller_input_price | seller_input_price | 改：文案加"对上一步 N 个模型生效" |
| 12 | seller_output_price | seller_output_price | 改：同上 |
| 13 | — | **seller_gas_check** | **新增**：ETH 低于阈值时提示 claim 需要 gas |
| 14 | seller_start | seller_start | — |
| 15 | complete | complete | — |

**步骤数**：
- buyer 独立：5 → 6 步
- seller 独立：6 → 9 步
- both：11 → 14 步

---

## 1. 依赖与公共模块

### 1.1 新增 npm 包

`packages/cli/package.json` dependencies 追加：

```json
"qrcode-terminal": "^0.12.0",
"viem": "^2.21.0"
```

> `viem` 已在 `packages/consumer-gateway` 用；CLI 这里只做只读余额查询和地址格式化，不签名。若想避免再装一份，可以复用 shared 层，但最干脆是 CLI 独立引入。

### 1.2 新增 `packages/cli/src/services/chain.ts`

```ts
import { createPublicClient, formatUnits, http } from 'viem';
import { baseSepolia } from 'viem/chains';

import { CONTRACTS } from '@clawmarket/shared';

const USDC = CONTRACTS.TOKEN;
const ERC20_BALANCE_ABI = [{ inputs:[{name:'a',type:'address'}], name:'balanceOf', outputs:[{type:'uint256'}], stateMutability:'view', type:'function' }] as const;

export interface WalletBalances {
  address: `0x${string}`;
  ethWei: bigint;
  ethFormatted: string;       // 例如 "0.0123"
  usdcMicro: bigint;
  usdcFormatted: string;      // 例如 "12.50"
}

export async function readBalances(address: `0x${string}`, rpcUrl = 'https://sepolia.base.org'): Promise<WalletBalances> {
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const [ethWei, usdcMicro] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ address: USDC, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [address] }),
  ]);
  return {
    address,
    ethWei,
    ethFormatted: formatUnits(ethWei, 18),
    usdcMicro,
    usdcFormatted: formatUnits(usdcMicro, 6),
  };
}

export const MIN_GAS_WEI = 500_000_000_000_000n; // 0.0005 ETH，Base Sepolia 上够几十次交易
```

**用途**：onboarding 的 `buyer_fund` / `seller_gas_check` / `buyer_purchase` 前置校验都走这个。

### 1.3 新增 `packages/cli/src/tui/components/QrCode.tsx`

```tsx
import qr from 'qrcode-terminal';
import { useMemo } from 'react';
import { Text } from 'ink';

export function QrCode({ value, small = true }: { value: string; small?: boolean }) {
  const art = useMemo(() => {
    let out = '';
    qr.generate(value, { small }, (code) => { out = code; });
    return out.replace(/\n$/, '');
  }, [value, small]);
  return <Text>{art}</Text>;
}
```

**注意**：`qrcode-terminal` 的 callback 是同步调用，`useMemo` 里捕获即可。组件纯渲染，不碰 stdin。

### 1.4 `config/schema.ts` 新增字段

```ts
export type SellerUpstream = 'codex' | 'claude' | 'gemini';

export interface ClawMarketConfig {
  // 既有字段保持
  buyer: {
    // …
    minGasWei: string;        // 存字符串避免 JSON 精度问题；读的时候 BigInt()
  };
  seller: {
    // …
    upstream: SellerUpstream;    // 新
    minGasWei: string;           // 新
  };
}
```

默认值（`config/store.ts` 的 `getCliDefaults` 里）：

```ts
buyer:  { …, minGasWei: '500000000000000' /* 0.0005 ETH */ },
seller: { …, upstream: 'codex', minGasWei: '500000000000000' },
```

**normalize**：`asString` + fallback `'codex'`；非法 upstream 值回退 `'codex'`。`applyEnvOverrides` 里追加 `CLAWMARKET_SELLER_UPSTREAM`。

---

## 2. 买家侧改动

### 2.1 `buyer_wallet` 步骤：展示地址 + 二维码

现状只打路径。改为：

- 买家节点**不需要先启动**也能知道地址——直接读取统一钱包文件 `~/.clawmarket/wallet.json`，必要时自动生成并从私钥推出地址即可（`services/chain.ts` 加一个 `addressFromPrivateKey(pk)` 辅助）。
- UI：
  ```
  Step 2 / 6 · 买家钱包与身份
  ─────────────────────────────
  你的买家钱包地址（Base Sepolia）：
    0xAbCd…1234
  
    █▀▀▀▀▀█ ▄▀▄▀ █▀▀▀▀▀█
    █ ███ █ ▀▄▀▀ █ ███ █         (qrcode-terminal 输出)
    █▄▄▄▄▄█ ▄ █ █ █▄▄▄▄▄█
  
  手机扫码即可复制地址。后面步骤需要你给这个地址充值 USDC 和少量 ETH 做 gas。
  
  [c] 复制地址到剪贴板   [Enter] 继续启动 buyer
  ```
- `[c]` 用 Node 内置 `child_process` 调 `pbcopy` / `xclip` / `clip.exe`，失败则提示手动复制。可选，不是阻塞路径。

### 2.2 新增 `buyer_fund` 步骤

**位置**：`buyer_start` 完成之后、`buyer_model` 之前。

**逻辑**：
1. 进入步骤后立即调 `services/chain.ts:readBalances(address)`。
2. 渲染：
   ```
   Step 4 / 6 · 充值 USDC 与 gas
   ───────────────────────────────
   钱包：0xAbCd…1234                   [QR]
   
   ETH (gas)  : 0.0000  ✗ 低于阈值 0.0005
   USDC       : 0.00    ✗ 建议至少 1 USDC
   
   Base Sepolia 水龙头：
     • Coinbase: https://portal.cdp.coinbase.com/products/faucet
     • Alchemy : https://www.alchemy.com/faucets/base-sepolia
   
   充值后按 [r] 刷新。余额达标后按 [Enter] 继续；按 [s] 跳过。
   ```
3. 打勾/打叉规则：
   - `ethWei >= MIN_GAS_WEI` → ✓
   - `usdcMicro > 0n` → ✓（0 的时候打叉但允许跳过，因为 purchase 步骤是可跳过的；UI 提示"购买额度需要 USDC"）
4. 按 `r` 重拉余额。按 Enter：两项都 ✓ 或者用户显式 `s` 跳过 才 `nextStep()`。
5. 每 10 秒自动轮询一次（给用户"充完钱不用按 r"的体验）；轮询用 `setInterval`，stepIndex 变时清除。
6. `actionState.lines` 追加最近 3 次刷新的时间戳 + 结果，方便看到"是否真的在刷新"。

**错误态**：RPC 拉取失败时显示 error 行 + "检查网络后按 r 重试"，不要阻塞到报错模态。

### 2.3 `buyer_purchase` 前置校验

在现有的 `onSubmit` 开头加：

```ts
const balances = await readBalances(address);
if (balances.ethWei < MIN_GAS_WEI) {
  setActionState({ stepId:'buyer_purchase', status:'error', lines:[], error:'ETH 不足支付 gas，请返回上一步充值。' });
  return;
}
if (balances.usdcMicro < parseUnits(trimmed, 6)) {
  setActionState({ stepId:'buyer_purchase', status:'error', lines:[], error:`USDC 余额 ${balances.usdcFormatted} 不够 ${trimmed}，请返回上一步充值。` });
  return;
}
```

---

## 3. 卖家侧改动

### 3.1 `seller_wallet` 步骤：展示地址 + 二维码

跟买家 2.1 同理。从 `state.sellerWalletPath` 读私钥（如果刚生成好）推地址，同样二维码 + `[c]` 复制。文案强调"卖家钱包用来签 claim，只需要少量 ETH 做 gas；不需要 USDC"。

### 3.2 新增 `seller_upstream` 步骤

**位置**：`seller_wallet` 完成之后、`seller_login` 之前。

**UI**：
```
Step 3 / 9 · 选择要反代的上游账号
────────────────────────────────
  ▸ Codex (OpenAI ChatGPT)
    Claude (Anthropic Claude Code)
    Gemini (Google Gemini CLI)

↑↓ 选择  Enter 确认
```

实现：用 `ink-select-input`，`onSelect` 写 `state.sellerUpstream`，`nextStep()`。

**config 写入**：`complete` 步骤保存时把 `state.sellerUpstream` 写到 `config.seller.upstream`。

### 3.3 `seller_login` 按 upstream 分支

**现状**：写死 codex，调 `scripts/run-cliproxy-auth.mjs codex` / `codex-device`。需要扩展。

**改动点 A — `scripts/run-cliproxy-auth.mjs`**：

```js
const ALLOWED = ['codex', 'codex-device', 'claude', 'gemini'];
if (!ALLOWED.includes(loginProvider)) {
  throw new Error(`Unsupported cliproxy login provider: ${loginProvider}`);
}
```

**改动点 B — `scripts/lib/embedded-cliproxy.mjs` 的 `resolveCliproxyLaunchCommand`**：

当前只处理 `codex` / `codex-device`。追加：

```js
} else if (loginProvider === 'claude') {
  sharedArgs.push('-claude-login');
} else if (loginProvider === 'gemini') {
  sharedArgs.push('-gemini-login');
}
```

**行动项**：同事需要先在 `CLIProxyAPI` 项目里确认 Claude / Gemini 的命令行 flag 实际叫什么（可能是 `-anthropic-login` / `-google-login` 之类），对照 `cmd/server` 的 flag 定义改。**不要想当然**，以源码为准。

**改动点 C — `packages/cli/src/runtime/cliproxy.ts`**：把 `loginSellerCodex` 改名 `loginSellerUpstream(upstream, options)`，内部决定传哪个参数给 `run-cliproxy-auth.mjs`。onboarding 和 commander 子命令都调这个。

**改动点 D — `seller login-codex` 子命令**：保留兼容，同时新增 `seller login --upstream=codex|claude|gemini`。文档更新。

**onboarding 中的渲染**：subtitle 根据 `state.sellerUpstream` 动态变：
- codex → "使用 Codex device-code 登录"
- claude → "使用 Claude Code OAuth 登录"
- gemini → "使用 Google 账号登录 Gemini CLI"

### 3.4 新增 `seller_models` 步骤

**位置**：`seller_login` 成功之后、`seller_input_price` 之前。

**UI**：
```
Step 5 / 9 · 选择要出售的模型
─────────────────────────────
[x] gpt-5.4
[x] gpt-5.4-mini
[ ] gpt-4o
[ ] gpt-4o-mini

↑↓ 移动  空格 切换  Enter 确认（至少选 1 个）
```

**候选清单**按 upstream 给默认：

```ts
const MODEL_PRESETS: Record<SellerUpstream, string[]> = {
  codex:  ['gpt-5.4', 'gpt-5.4-mini', 'gpt-4o', 'gpt-4o-mini'],
  claude: ['claude-4.6-sonnet', 'claude-4.6-haiku', 'claude-4.5-opus'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
};
```

> 确切型号名同事查 CLIProxyAPI 的 `/v1/models` 动态获取更稳妥：login 完成后，启动 CLIProxyAPI backend（可以就用 `runtime/seller-runtime.ts` 已有的 embedded 启动逻辑的子集 `startCliproxyOnly(port)`），`fetch http://127.0.0.1:<port>/v1/models`，把返回的 id 列表作为候选。失败时回退到 `MODEL_PRESETS`。

**实现**：Ink 没有多选内置组件，写一个 `MultiSelect.tsx`：`Array<{label, value, checked}>`、useInput 处理 ↑↓/Space/Enter。40-60 行。放 `tui/onboarding/steps/MultiSelectStep.tsx`。

**校验**：至少选 1 个，否则 Enter 时显示 error 不推进。

**写入**：`state.sellerModels = string[]`；complete 步骤保存到 `config.seller.models`。

### 3.5 `seller_input_price` / `seller_output_price` 文案

subtitle 改为：`将对你选择的 N 个模型生效：gpt-5.4, gpt-5.4-mini`。

### 3.6 新增 `seller_gas_check` 步骤

**位置**：`seller_output_price` 之后、`seller_start` 之前。

**逻辑**：只检查 ETH，不检查 USDC。余额 < `MIN_GAS_WEI` 时展示二维码 + 水龙头链接 + `[r]/[s]/[Enter]`（同 `buyer_fund`，但只有 ETH 一项）。余额够就一屏说明"当前 ETH X ETH 足够上链 claim"+ `[Enter]` 继续。

**复用**：`buyer_fund` 和 `seller_gas_check` 逻辑 90% 一样，抽一个 `FundCheckStep.tsx` 组件，props 接 `{ address, requireUsdc: boolean, rpcUrl, faucetLinks }`。

---

## 3b. 价格改动在运行时生效（Dashboard 侧）

onboarding 里有 `seller_input_price` / `seller_output_price` 写进 `config.seller.pricing.*`，但进入 Console 后**卖家日常改价的体验目前有三个坑**，本节一起修掉。

### 3b.1 Settings 改价不触发重启（问题 1）

**现状**：`tui/console/views/Settings.tsx` + `console/settings.ts:55-76` 会把 `seller.pricing.input/output` 写入 `config.json`，但 `runtime/seller-runtime.ts` 是把定价作为启动环境变量/参数传给 `run-seller-testnet.mjs` 子进程的——config 改了，跑着的子进程并不会重读。UI 显示 80，`/v1/seller/status` 还是 60，用户不知情。

**修法**：`SettingsView` 的 `onSubmit` 成功后判断 key 前缀：

```ts
const isPricingChange = key === 'seller.pricing.input' || key === 'seller.pricing.output';
if (isPricingChange) {
  onPushEvent('设置', `${key} 已更新为 ${nextValue}，需要重启 seller 才会生效。`);
  onOpenConfirm({
    title: '现在重启 seller 应用新价格？',
    confirmLabel: '重启',
    cancelLabel: '稍后',
    onConfirm: async () => {
      await stopSellerRuntime((line) => onPushEvent('卖家', line));
      await startSellerRuntime({ ...getDefaultSellerRuntimeOptions(nextConfig), report: (line) => onPushEvent('卖家', line) });
      onPushEvent('卖家', '已重启，应用新价格。');
    },
  });
}
```

**依赖**：`PromptModal` 只支持文本输入，需要再加一个 `ConfirmModal` 组件（`tui/console/components/ConfirmModal.tsx`，30 行：`[Enter] 确认 / [Esc] 取消`）。modal state 类型 `| { type:'prompt' … } | { type:'confirm' … }`。

### 3b.2 Seller 视图加"当前定价 + 快捷改价"入口（问题 2）

**现状**：`views/Seller.tsx` 70 行只展示 status / queue / reachability，没有定价块也没有改价入口；卖家要改价必须跳去 Settings。

**修法**：在 `SellerView` 顶部加一块：

```
┌─ 定价 ───────────────────────────────────────────┐
│ input  : 60 USDC / 1M tokens   [p] 修改          │
│ output : 60 USDC / 1M tokens                     │
│ 生效范围: claude-4.6-sonnet, claude-4.6-haiku     │
└──────────────────────────────────────────────────┘
```

按 `p`：连续弹两个 PromptModal（先 input 后 output），两个都保存后写 `config.json` + 推事件 + 弹 3b.1 的 ConfirmModal 询问是否立即重启 seller。

props 扩展：`onEditPricing: () => void` 交给上层 `ConsoleApp` 复用 Settings 已有的 `applySetting` 逻辑，避免两份校验分叉。

### 3b.3 "所有模型共享一组价格"设计声明（问题 3）

**采用 A 方案（简单）**：`seller.pricing` 保持扁平 `{ input, output }`，对 `seller.models` 所有模型一视同仁。理由是 onboarding 流程要跑通为先，分模型定价会让 UI 和 state 复杂度翻倍。

**要求**：
- `seller_input_price` / `seller_output_price` 步骤 subtitle 固定一句："将对你选择的 N 个模型生效（claude-4.6-sonnet, claude-4.6-haiku）。每个模型共享同一组价格；后续版本会支持分模型定价。"
- `views/Seller.tsx` 定价块最下方"生效范围"那行列出所有 `config.seller.models`。
- `docs/design/cli-redesign.md` 末尾"未来工作"章节记一笔：`seller.pricing` → `Record<model, {input, output}>` 迁移计划，留到下个迭代。

---

## 4. `complete` 步骤：写入新字段

保存 `config.json` 时，`completeState` → `ClawMarketConfig`：

```ts
const nextConfig: ClawMarketConfig = {
  ...config,
  onboarding: { completedAt: new Date().toISOString(), role: state.role },
  seller: {
    ...config.seller,
    upstream: state.sellerUpstream,
    models: state.sellerModels,
    pricing: { input: Number(state.inputPrice), output: Number(state.outputPrice) },
  },
};
await saveCliConfig(nextConfig);
```

completion 面板底部额外打一行：
```
Seller upstream: Claude  ·  Models: claude-4.6-sonnet, claude-4.6-haiku
Seller input/output: 60/60 USDC/1M
```

---

## 5. 后端配合（跨包）

### 5.1 `/v1/wallet` 返回 `nativeBalance`

**文件**：`packages/consumer-gateway/src/wallet.ts` + `src/local-server.ts:handleWalletSummary`。

`WalletManager.exportWallet()` 返回的对象目前是 `{ address, balance }`（USDC），追加：
```ts
export interface WalletExport {
  address: `0x${string}`;
  balance: string;          // USDC formatted
  nativeBalance: string;    // ETH formatted  (新)
  nativeBalanceWei: string; // 原始 wei 字符串 (新)
}
```
用 `publicClient.getBalance({ address })` 拉。

`handleWalletSummary` 的响应追加 `nativeBalance` / `nativeBalanceWei`。

**好处**：onboarding 里如果 buyer 已启动，可以直接用 HTTP 拉（带 escrow 可用额度一起），不用再走 `services/chain.ts` 拉一次。`buyer_fund` 优先走 HTTP，fallback 走 viem 直读 RPC（适配"buyer 还没起来"场景）。

### 5.2 `CLIProxyAPI` login flag 确认

同事动手前必须先在 `CLIProxyAPI` 仓库搜 `-codex-login` 的定义点（大概是 `cmd/server/main.go` 里的 `flag.Bool`），确认：
- Claude 登录 flag 真实名字
- Gemini 登录 flag 真实名字
- 是否都支持 `-oauth-callback-port` / device-code

然后把结果写进 `scripts/lib/embedded-cliproxy.mjs`。

---

## 6. 测试

### 6.1 单元测试

- `config/schema.test.ts` 补：upstream normalize（非法值回退 codex）、minGasWei 序列化。
- `services/chain.test.ts`：mock viem client，断言 `readBalances` 字段形状；`MIN_GAS_WEI` 阈值边界。
- `tui/onboarding/lib.test.ts` 补：`buildOnboardingStepIds('seller', …)` 应包含 `seller_upstream` / `seller_models` / `seller_gas_check`，顺序正确。
- `tui/onboarding/steps/FundCheckStep.test.tsx`：ink-testing-library。3 种状态：
  - loading（首次拉余额）
  - 不足（展示二维码 + 水龙头）
  - 充足（Enter 可继续）
- `tui/onboarding/steps/MultiSelectStep.test.tsx`：上下键 + 空格 + 至少选 1 个校验。
- `tui/components/QrCode.test.tsx`：快照即可，确保 `qrcode-terminal` 调用不 throw。

### 6.2 手工走查脚本（`docs/qa/onboarding-v2.md`，同事做完后自己先跑）

```
场景 1 — 新机器买家
  1. rm -rf ~/.clawmarket && 删掉 config
  2. clawmarket
  3. role = buyer
  4. buyer_wallet 看到地址 + 二维码，手机扫描能读出正确地址
  5. buyer_start 启动
  6. buyer_fund 显示 0/0，去 Coinbase faucet 领 ETH + USDC，按 r 刷新看到到账
  7. buyer_model 选 gpt-5.4
  8. buyer_purchase 输入 0.1，成功上链
  9. 进 console → chat 发一条消息成功

场景 2 — 新机器卖家 Claude
  1. rm -rf ~/.clawmarket
  2. clawmarket
  3. role = seller
  4. seller_wallet 生成钱包，看到地址二维码
  5. seller_upstream 选 Claude
  6. seller_login 弹出 Anthropic OAuth 流程（Ink 先 unmount），登录完成
  7. seller_models 看到 claude 家模型，选 2 个
  8. 填价格
  9. seller_gas_check 显示 0 ETH，去 faucet 领，按 r 刷新通过
 10. seller_start 启动
 11. curl http://127.0.0.1:8787/v1/seller/status 看到模型 = 刚选的 2 个，upstream 正确

场景 3 — 两者都要
  走完 14 步，config.json 两边字段都写入

场景 4 — 断网 / RPC 挂
  buyer_fund 拉余额失败时显示 error 且 r 可重试，不卡死
```

---

## 7. 交付 checklist（同事提 PR 前自查）

- [ ] `qrcode-terminal` + `viem` 加到 `packages/cli/package.json` 并 `pnpm install`
- [ ] `services/chain.ts` + `tui/components/QrCode.tsx` 新增，带单测
- [ ] `config/schema.ts`：`SellerUpstream` 类型 + `upstream` / `buyer.minGasWei` / `seller.minGasWei` 字段 + normalize
- [ ] `config/store.ts` defaults + env overlay（`CLAWMARKET_SELLER_UPSTREAM`）
- [ ] `tui/onboarding/lib.ts`：3 个新 step id + title；`buildOnboardingStepIds` 排序正确
- [ ] `tui/onboarding/index.tsx`：3 个新 case 的渲染 + state 字段（`sellerUpstream` / `sellerModels`）
- [ ] `tui/onboarding/steps/FundCheckStep.tsx` / `MultiSelectStep.tsx` 新组件
- [ ] `buyer_wallet` / `seller_wallet` / `buyer_fund` / `seller_gas_check` 统一用 `<QrCode />`
- [ ] `scripts/run-cliproxy-auth.mjs` 白名单扩充到 4 项
- [ ] `scripts/lib/embedded-cliproxy.mjs` 分支加 `-claude-login` / `-gemini-login`（实际 flag 名以 CLIProxyAPI 源码为准）
- [ ] `runtime/cliproxy.ts` 改成 `loginSellerUpstream(upstream)`
- [ ] `index.ts` commander：新增 `seller login --upstream=<codex|claude|gemini>`，保留 `login-codex` 别名
- [ ] `consumer-gateway/src/wallet.ts` + `local-server.ts`：`/v1/wallet` 返回 `nativeBalance` / `nativeBalanceWei`
- [ ] `services/buyer.ts` 的 `BuyerWalletSummary` 类型同步加字段
- [ ] `complete` 步骤写入 upstream / models / pricing 到 config.json
- [ ] `tui/console/components/ConfirmModal.tsx` 新增；modal state union 加 `'confirm'` 分支
- [ ] `views/Settings.tsx` 改 `seller.pricing.*` 后推事件 + 触发 ConfirmModal 询问是否重启 seller
- [ ] `views/Seller.tsx` 顶部加定价块 + `[p]` 快捷键改价（复用 `applySetting`）
- [ ] `seller_input_price` / `seller_output_price` 步骤 subtitle 明确"所有选中模型共享同一组价格"
- [ ] `docs/design/cli-redesign.md` 末尾追加一条未来工作：分模型定价迁移
- [ ] `clawmarket doctor` 输出里展示 upstream + 模型 + 当前余额（简要）
- [ ] 单测 / 手工 4 个场景全过
- [ ] `pnpm build` + `pnpm --filter @clawmarket/cli test` 通过
- [ ] README / `docs/design/cli-redesign.md` 顶部注明 v2 已落地
- [ ] bump `packages/cli/package.json` 到 `0.2.0`

---

## 8. 不做的事（明确排除，避免 scope 蔓延）

- ❌ 不在本次加主网支持。链写死 Base Sepolia，chainId 84532。主网切换后续再做。
- ❌ 不改 `EscrowPool` 合约。
- ❌ 不做"一键自动领水"（Coinbase faucet 需要账号，做不动；只给链接）。
- ❌ 不在 CLI 内集成 Claude/Gemini 登录 UI。登录仍然走 CLIProxyAPI 的 OAuth，CLI 只负责 unmount Ink → spawn 子进程 → 完成后重挂。
- ❌ 不改 consumer-gateway 的计价 / 路由逻辑。
- ❌ 不碰 claim 上链逻辑。

---

## 9. 工期估算

| 阶段 | 内容 | 预计 |
|---|---|---|
| 1 | chain.ts + QrCode + schema 扩字段 + FundCheckStep 组件 | 0.5 d |
| 2 | buyer_wallet / buyer_fund 两步接入 + buyer_purchase 前置校验 | 0.5 d |
| 3 | consumer-gateway 加 nativeBalance | 0.25 d |
| 4 | scripts + runtime/cliproxy 多上游支持（含 CLIProxyAPI 源码查 flag） | 0.75 d |
| 5 | seller_upstream / seller_login 分支 / seller_models / seller_gas_check | 1 d |
| 6 | complete 保存 + commander 子命令改 + doctor 输出 | 0.25 d |
| 7 | ConfirmModal + Settings 改价触发重启 + Seller 视图定价块与 [p] 改价 | 0.5 d |
| 8 | 单测 + 手工 4 场景跑 + 修 bug | 0.75 d |
| 9 | 文档 + PR | 0.25 d |
| **合计** | | **~4.5 人日** |

建议分 2 个 PR：
- PR A：公共模块（chain.ts / QrCode / schema / FundCheckStep）+ 买家 3 处改动 + consumer-gateway nativeBalance
- PR B：卖家上游分支 + 模型多选 + gas check + 运行时改价（ConfirmModal / Settings 重启 / Seller 视图 [p]）+ doctor / commander 收尾

PR A 合了以后买家侧就已经"在新机器上能用"，可以先发内测。PR B 再跟上。

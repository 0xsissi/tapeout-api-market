# CLI 钱包 & 资金流 UX 补齐清单

**目标**：CLI 用户能创建钱包、导出备份、完成充值/消费/提现/领取，不要求重型安全。

**设计前提**：
- 参考 Telegram 交易 bot（BonkBot / Maestro / Trojan）风格：钱包轻量、免密、用户自负备份。
- Tapeout API Market 钱包场景是"AI 推理预算"（单次 $5-$50），不是大额资产存储。重型加密（keystore 密码、助记词抄写验证等）投入产出比不划算。
- 网络暂时统一 Base Sepolia，不做 testnet/mainnet 切换。
- Hosted Gateway 和 agent 场景另行设计（[agent-integration-roadmap.md](agent-integration-roadmap.md)），本文只处理 CLI。

---

## 🔴 P0-1 替换 Buyer 硬编码 demo 私钥 + 钱包统一

### 问题
[packages/cli/src/config/store.ts:14](../../packages/cli/src/config/store.ts) 当前所有 buyer 共用一个 demo 私钥 `0xd14...`。

后果：
- 所有测试用户的钱混在一起。
- 真实多用户测试做不了。
- 这个 key 已在 git 历史里，永久泄漏。

Seller 有自己的钱包文件（[tui/onboarding/index.tsx:627](../../packages/cli/src/tui/onboarding/index.tsx:627) 写到 `~/.clawmarket/seller-wallet.json`），和 buyer 分开管理，没必要。

### 要做的
- 统一钱包文件 `~/.clawmarket/wallet.json`，buyer / seller 都读这里。
- 首次启动没有钱包文件时，用 `viem.generatePrivateKey()` 自动生成。权限 `0o600`。
- 明文存储（无密码、无加密 keystore），不要求用户解锁。
- 迁移：启动时若只发现老的 `seller-wallet.json`，自动重命名为 `wallet.json`，并在日志里打一行告知。
- git 历史里那个 demo key 要在文档/README 里标注为废弃，提醒任何人都不要再往它里面打钱。

### 文件
- 新：`packages/cli/src/wallet/store.ts` —— 统一的 load/save/create/migrate。
- 改：[packages/cli/src/config/store.ts](../../packages/cli/src/config/store.ts) —— 去掉 hardcoded demo key。
- 改：[packages/cli/src/tui/onboarding/index.tsx](../../packages/cli/src/tui/onboarding/index.tsx) —— 生成逻辑迁到 store.ts。
- 改：[packages/cli/src/services/utils.ts:67](../../packages/cli/src/services/utils.ts) `readPrivateKeyFromWallet` —— 读统一路径。
- 改：[packages/consumer-gateway/src/wallet.ts:78](../../packages/consumer-gateway/src/wallet.ts) —— 同上。

---

## 🔴 P0-2 Export / Import 菜单项 + 首次生成提示

### 问题
钱包生成后用户拿不到私钥，机器丢 = 钱没。换机器也没法恢复。

### 要做的

#### (1) 首次生成后展示一条提示
生成完钱包在 onboarding / 主菜单里显示一次：
```
✓ 钱包已创建：0xabcd...1234
  💡 按 E 导出私钥备份。机器丢了 = 钱没了。
```
不强制备份、不做抄写验证、不弹阻塞对话框。

#### (2) TUI 加两个菜单项

**[E] 导出私钥**
- 显示完整私钥（十六进制，`0x...` 开头）一次。
- 上方一行红字警告："不要发给任何人，不要截图上传。"
- 用户按回车或 Q 返回。

**[I] 导入私钥**
- 用户粘贴一个私钥字符串。
- 简单校验（长度 66 字符、`0x` 前缀、hex 合法）。
- 校验通过后覆盖 `wallet.json`（先备份老文件到 `wallet.json.bak` 防误操作）。
- 显示新钱包地址确认。

不做助记词（BIP-39）。导出/导入私钥就够了，简单清晰。

### 文件
- 新：`packages/cli/src/tui/wallet/ExportView.tsx`
- 新：`packages/cli/src/tui/wallet/ImportView.tsx`
- 改：[packages/cli/src/tui/console/index.tsx](../../packages/cli/src/tui/console/index.tsx) —— 主菜单注册 E / I 键。
- 改：[packages/cli/src/tui/onboarding/index.tsx](../../packages/cli/src/tui/onboarding/index.tsx) —— 生成后显示一次性提示。

---

## 🔴 P0-3 TUI 钱包 / 资金视图（最关键的补齐）

### 问题
当前 TUI（[packages/cli/src/tui/console/](../../packages/cli/src/tui/console/)）**只有两个资金操作入口**：
- Dashboard 的"购买额度"（= deposit）
- Claims 视图的"Flush claims"

以下全部在 CLI 有命令但 **TUI 里完全没有入口**，普通用户点不到：
- Buyer withdraw request / cancel / complete（48h timelock 三步流程）
- 钱包 USDC / ETH 余额显示
- 钱包地址显示与复制
- Pending withdraw 状态（剩余时间）
- 交易历史

用户现在必须 `Ctrl+C` 退出 TUI 再敲 `claw buyer withdraw ...`。这对"不会用命令行"的用户等于**没有提现功能**。

### 要做的

新建一个 TUI 视图 `Wallet` 作为资金中心，在主 Nav 里加入口（与 Dashboard / Claims 同级）。

#### Wallet 视图布局

```
┌─ 钱包 ──────────────────────────────────────────────┐
│                                                      │
│  地址：0xabcd...1234          [C] 复制                │
│  网络：Base Sepolia                                   │
│                                                      │
│  ─── 余额 ───                                        │
│   钱包 USDC：  125.00                                │
│   钱包 ETH：   0.0042       ⚠ gas 偏低              │
│   Escrow 可用：45.50                                 │
│   Escrow 提现中：20.00      ⏳ 还剩 31h 12m          │
│                                                      │
│  ─── 操作 ───                                        │
│   [1] 充值到 Escrow                                  │
│   [2] 从 Escrow 提现                                 │
│   [3] 完成提现（到期后可用）                         │
│   [4] 取消提现请求                                   │
│   [E] 导出私钥                                       │
│   [I] 导入私钥                                       │
│                                                      │
└──────────────────────────────────────────────────────┘
```

#### 必做的具体项

**(a) 余额展示**
- Wallet USDC / ETH / Escrow available / Escrow pending withdraw 四项全部展示。
- 后端 `/v1/credits` 接口已有 `usdcBalance` / `nativeBalance` / `escrowAvailable` 字段（[services/buyer.ts](../../packages/cli/src/services/buyer.ts)），TUI 直接读即可。
- ETH 低于阈值时右侧显示 `⚠ gas 偏低`。

**(b) 地址显示 + 复制**
- 顶部常驻显示完整钱包地址（或省略中间但可展开）。
- `[C]` 键调用系统 clipboard（用 `clipboardy` 或 Node 的 `child_process` 调 `pbcopy` / `xclip`）。
- 复制后底部 toast 一句"已复制到剪贴板"。

**(c) 充值流程（Deposit）**
- 弹金额输入框，预填当前 USDC 余额供参考。
- 校验：金额 > 0、不超过 wallet USDC balance。
- 校验失败就地提示，不发 tx。
- 发起后显示 "⏳ 上链中..."，完成后显示 tx 链接（复用 P1-1 的 tx-link helper）。
- 自动处理 ERC-20 approve：后端如果需要 allowance 先发 approve tx，TUI 就显示 "步骤 1/2：approve" → "步骤 2/2：deposit"。

**(d) 提现请求（Withdraw Request）**
- 金额输入 + 校验（不超过 escrow available）。
- 发起前显示一行说明："发起后需要等待 48 小时才能完成提现。等待期间可以取消。"
- 成功后 pending withdraw 区域自动更新。

**(e) 完成提现（Withdraw Complete）**
- 只在存在 pending withdraw 且已过 48h 时才可点（未到期显示倒计时，可点但提示"还剩 Xh Ym"）。
- 后端 `/v1/credits` 返回 `pendingWithdraw.unlocksAt` 时间戳，TUI 用 `Date.now()` 对比。

**(f) 取消提现（Withdraw Cancel）**
- 只在存在 pending withdraw 时显示。
- 取消后资金立即回到 escrow available。

**(g) Seller 侧的对称信息**
- 在 Claims 视图或新增的 Seller wallet 区域显示：
  - Seller 钱包 USDC 余额（flush 后到账的部分）
  - 最近一次 flush 的 tx 链接
- 不用做历史表，够用即可。

#### 不做的

- 交易历史表（需要索引链上事件，工程量大，不值得）
- QR 码显示地址（CLI 用户不需要）
- 金额单位换算（统一用 USDC）
- 二次确认弹窗（维持 bot 风格）

### 文件
- 新：`packages/cli/src/tui/console/views/Wallet.tsx`
- 改：[packages/cli/src/tui/console/components/Nav.tsx](../../packages/cli/src/tui/console/components/Nav.tsx) —— 加 Wallet 入口。
- 改：[packages/cli/src/tui/console/index.tsx](../../packages/cli/src/tui/console/index.tsx) —— 路由注册。
- 改：[packages/cli/src/services/buyer.ts](../../packages/cli/src/services/buyer.ts) —— 如果 `/v1/credits` 没有 `pendingWithdraw.unlocksAt` 就加上。
- 改：[packages/cli/src/tui/console/views/Claims.tsx](../../packages/cli/src/tui/console/views/Claims.tsx) —— 加 seller 钱包余额行。
- 改：[packages/cli/src/tui/console/views/Dashboard.tsx](../../packages/cli/src/tui/console/views/Dashboard.tsx) —— 原"购买额度"入口保留作为快捷方式，完整操作改到 Wallet 视图。

---

## ℹ️ 关于 Seller "质押到合约" —— 暂不做

### 现状
[packages/contracts/src/EscrowPool.sol:69](../../packages/contracts/src/EscrowPool.sol) 有 `mapping(address => uint256) private slashingBond;` 这个存储槽，但**没有任何 public 函数**让 seller 质押或取回。

这说明"slashing bond"在当前合约里**只占位、未实现**。

### 要做的
- 不在这一轮补齐。先不做 TUI 质押流程，因为合约都没接口。
- 后续 [scalability-gap-list.md](scalability-gap-list.md) 里的 Nonce bitmap 改动会一起做合约升级，到时候再把 slashing bond 的 `depositBond` / `withdrawBond` / `slash` 接口补进去。
- 现在 seller 上线流程不要求质押，先跑通业务流再谈抵押品。

### 需要的决策（项目维护团队）
- slashing bond 要不要上线 testnet 就强制？建议 **先不强制**，观察一段时间再定阈值。
- bond 金额：$5？$10？和单笔最大结算额挂钩。

---

## 🟡 P1-1 Tx 返回可点击的区块浏览器链接

### 问题
所有链上操作返回 tx hash（见 [types.ts:100](../../packages/cli/src/services/types.ts)），用户要自己拼 URL 才能看。

### 要做的
- 加一个 `formatTxLink(hash)` helper，固定拼 `https://sepolia.basescan.org/tx/${hash}`。
- TUI 用 OSC 8 输出可点击超链接（iTerm2 / kitty / wezterm / 大多数现代终端支持）：
  ```
  ✓ 存款成功
    Tx: https://sepolia.basescan.org/tx/0xabc...  [点击查看]
  ```
- 不支持 OSC 8 的终端退化成纯 URL，能复制就行。

### 文件
- 新：`packages/cli/src/tui/helpers/tx-link.ts`
- 改：所有显示 tx hash 的 TUI 位置。

---

## 🟡 P1-2 Gas 余额预检

### 问题
Buyer deposit/withdraw、Seller flush-claims 都要烧 ETH。目前代码不检查钱包 ETH 余额，失败后报错不友好。

[config/store.ts:55,69](../../packages/cli/src/config/store.ts) 已经有 `minGasWei` 配置，但没地方用。

### 要做的
- 在每个要花 gas 的操作前查钱包 ETH 余额。
- 低于 `minGasWei` 就显示：
  ```
  ⚠ ETH gas 不足
    当前余额：0.0001 ETH
    预计需要：0.001 ETH
    钱包地址：0xabcd...1234
    Testnet faucet：https://www.alchemy.com/faucets/base-sepolia
    [c] 我已充值，继续   [x] 取消
  ```
- [packages/cli/src/tui/onboarding/lib.ts:86](../../packages/cli/src/tui/onboarding/lib.ts) 有 `seller_gas_check` 可复用扩展。

### 文件
- 新：`packages/cli/src/wallet/gas-check.ts`
- 改：buyer purchase / withdraw、seller flush-claims 前插入检查。

---

## 排期建议

| 优先级 | 项目 | 预计工期 | testnet 必做 |
|---|---|---|---|
| P0 | 替换 demo key + 统一钱包文件 | 1-2 天 | **是** |
| P0 | Export / Import 菜单 + 首次生成提示 | 0.5-1 天 | **是** |
| P0 | TUI Wallet 视图（余额 / 地址 / 充值 / 提现全流程） | 3-4 天 | **是** |
| P1 | Tx 区块浏览器链接 | 0.5 天 | 可选 |
| P1 | Gas 预检 | 1 天 | 可选 |
| — | Slashing bond 质押流程 | 延后 | 否（合约无接口） |

**最小 testnet 门槛**：P0 三项（约 1 周工作量）。

---

## 明确不做的事

为避免同事按旧版文档去做，下列项**已决定砍掉**：

- ❌ 助记词（BIP-39）—— 直接导出私钥就够，省一层概念。
- ❌ 密码加密 keystore —— 用户反馈"用的时候不想输密码"。
- ❌ 抄写验证流程 —— 金额小，投入产出比不划算。
- ❌ 存款前二次确认弹窗 —— 阻断正常流程，用户会烦。
- ❌ 主菜单常驻"未备份"红字 —— 用户自负备份。
- ❌ Multi-account（多钱包切换）—— 用 Import 覆盖即可。
- ❌ Withdraw 48h timelock 倒计时 UI —— 用户看 status 就行。
- ❌ Seller 收益历史视图 —— status 有 queued/preview 够用。
- ❌ 自动 flush-claims —— 目前手动命令不变。
- ❌ `--network testnet|mainnet` 切换 —— 切主网是后续大改，单独项目。

如有必要后续再开：先以最小可用为目标。

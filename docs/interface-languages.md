# 中文 / English

TAM 的市场网站和命令行买家/卖家界面支持中文与英文。

## 网站

右上角选择 **English / 中文**。首次访问跟随浏览器语言，之后记住选择。分享指定语言的页面：

- English: https://shenjige.xyz/?lang=en
- 中文：https://shenjige.xyz/?lang=zh
- English AI guide: https://shenjige.xyz/skill.en.md
- 中文 AI 指南：https://shenjige.xyz/skill.md

市场、节点、测试币领取、Gas 步骤、快速开始和 AI 接入页面均有英文文字。切换语言保留当前页面、搜索与币种筛选，不会连接钱包或发起领币。日期和数字按所选语言显示。

## 命令行客户端

源码安装，在仓库根目录运行：

```text
corepack pnpm tam --lang en console
corepack pnpm tam --lang zh console
```

公开安装包使用安装器输出的 launcher：

```text
node <完整的 launcher 路径> --lang en console
```

运行中的控制台按 **L**，或在 **Settings / 设置** 选择语言，会切换并保存。切换保留当前菜单、聊天记录和节点状态，不发起模型调用或交易。

进入控制台后自动启动本机 buyer，或连接已有的同钱包、同币种与结算合约的 buyer。启动期间可以切换菜单；失败后在总览选择“启动买家服务”重试。BEM 等配置缺少额度或合约时先显示设置，不自动填写额度。手动停止后不会因刷新而重新启动；退出时清理本次会话启动的进程，已有的外部 buyer 保持运行。

The console automatically starts a local buyer or connects to an existing buyer with the matching wallet and settlement configuration. Menus remain available while it connects. Missing settings require owner input. Starting a node does not make a deposit, send a model request or grant seller access.

保存后续启动的语言：

```text
corepack pnpm tam language en
corepack pnpm tam language zh
```

优先级：`--lang` 单次覆盖 → `TAM_LANG` 环境变量 → 已保存选择 → 系统语言。语言偏好在用户主目录的 `.clawmarket/language.json`，与 USDC/BEM 配置独立。`--lang` 本身不修改已保存选择。

Language selection changes interface text only. Model responses and user messages retain their original text. Wallet addresses, token amounts, model IDs, API parameters and signing messages are not rewritten.

## 维护翻译

统一词典：`packages/shared/src/locales/en.json`；支持 `{0}` 等插值占位。浏览器与终端使用同一转换逻辑。更改词典后运行 `corepack pnpm market:locales`，再构建客户端；测试验证浏览器词典一致、插值完整及主要页面的英文覆盖。

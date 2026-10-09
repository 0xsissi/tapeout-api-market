# Tapeout API Market（TAM）名称与兼容说明

项目正式名称为 **Tapeout API Market**，简称 **TAM**，原名称为 ClawMarket V2。

对外介绍使用「Tapeout API Market（TAM）」。当前版本主要提供 AI 推理 API 交易；改名不会增加尚未实现的通用 API 交易功能。

| 入口 | 当前名称 |
| --- | --- |
| GitHub 仓库 | `0xsissi/tapeout-api-market` |
| 根工作区名称 | `tapeout-api-market` |
| 命令行 | 源码目录使用 `corepack pnpm tam`；安装后使用 `tam`，兼容旧命令 `clawmarket` |
| TypeScript 客户端 | `TAM`、`TapeoutAPIMarket`，兼容 `ClawMarket` |
| Python 客户端 | `TAM`、`TapeoutAPIMarket`，兼容 `ClawMarket` |

## 为什么代码中仍有旧名称？

品牌改名与协议迁移分开进行。以下标识保留兼容，避免旧钱包失联、签名无法验证或节点无法通信：

- 工作区包名 `@clawmarket/*`、Python 包名 `clawmarket_agent_sdk` 和旧类型名称。
- 配置变量 `CLAWMARKET_*`、更新配置 `CLAW_*`、钱包和账本目录 `~/.clawmarket`、`~/.clawmarket-provider`。
- P2P 协议路径、广播主题、API 路径及响应对象类型中的旧标识。
- EIP-712 签名域、已有合约 ABI，以及旧奖励代币合约的名称和 `CLAW` 符号。
- 部署服务文件名和既有服务器数据路径。

这些名称是兼容标识，不是新的产品名称。**TAM 是项目简称，不是新发行的代币。** 本次没有改变 USDC/BEM 的定价和结算逻辑，也没有修改已部署代币名称和付款签名域。

## SDK 示例

```ts
import { TAM } from '@clawmarket/agent-sdk';
```

```python
from clawmarket_agent_sdk import TAM
```

两个新名称与原客户端使用同一份实现，不会重新创建钱包或改变付款签名格式。

## 更新来源

CLI 默认检查 `0xsissi/tapeout-api-market` 的 GitHub Releases，优先识别 `tam-*` 发布包，并兼容旧文件名。仓库已公开且尚未发布安装包时，公共更新查询可能返回 404；程序会继续运行，不会从原项目的发布仓库下载更新。

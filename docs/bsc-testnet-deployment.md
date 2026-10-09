# BSC 测试网合约部署

2026-10-07 已部署 TAM 的测试 BEM、测试 USDC 和各自的托管结算池。网络为 **BNB Smart Chain Testnet，chain ID 97**。公开记录：[BEM](../packages/contracts/deployments/bsc-testnet.json) · [USDC](../packages/contracts/deployments/bsc-testnet-usdc.json)。

| 项目 | 地址 / 配置 |
| --- | --- |
| 测试币 tBEM | [0x6DD0Be28736F638844499B019DBaacc5897dAAC2](https://testnet.bscscan.com/address/0x6DD0Be28736F638844499B019DBaacc5897dAAC2) |
| BEMEscrowPool | [0xfd95F0cA22D6c2Ca8dE3Bd42f88c6b94ABf6724e](https://testnet.bscscan.com/address/0xfd95F0cA22D6c2Ca8dE3Bd42f88c6b94ABf6724e) |
| 测试币 tUSDC | [0xFcc26b50731525a4452D0ED428cdf11058723B89](https://testnet.bscscan.com/address/0xFcc26b50731525a4452D0ED428cdf11058723B89) |
| USDC EscrowPool | [0x90D30bA5d3e72A029335D2B879786ba912EA6e5F](https://testnet.bscscan.com/address/0x90D30bA5d3e72A029335D2B879786ba912EA6e5F) |
| RPC | `https://bsc-testnet-dataseed.bnbchain.org` |
| Gas 币 | 测试 BNB（tBNB） |
| 代币精度 | tBEM 8 位；tUSDC 6 位 |
| 初始发行量 | 两种测试币各 1,000,000，初始发给部署钱包 |
| 协议手续费 | 100 basis points，即 1% |
| 挖矿奖励 | 关闭 |

tBEM 是项目测试币，不能当作 BSC 主网真实 BEM；tUSDC 是项目自建测试币，不是 Circle 发行的 USDC。主网 BEM 地址仍是 `0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a`、chain ID 56；本次没有部署主网池、兑换或迁移主网资金。

## 部署信息

公开配置只包含测试币和合约地址、网络及编译参数。部署钱包、交易日志、个人账户和余额保存在仓库外。

## 合约如何使用

管理员可调用测试币的 `mint(address,uint256)` 发放测试币；其他钱包不能增发。买家持有 tBEM 和少量 tBNB 后，先对池调用 ERC-20 `approve`，再调用池的 `deposit`。例如充值 20 tBEM，两次调用的金额均为 `2000000000` 个最小单位。

收到完整 API 结果后，买家签署实际费用授权；卖家调用池的 `claim` 收款。5 tBEM 的费用在默认费率下产生 4.95 tBEM 卖家收入和 0.05 tBEM 协议手续费。授权必须使用 chain ID 97、新池地址、池的 `POOL_ID` 和现有 `ClawEscrowPool` / `1` 签名域，不能沿用主网或 Base Sepolia 的签名。提现仍有 48 小时等待期。

**当前应用接入：**内测统一使用 BSC 测试网。CLI 与买卖节点启动脚本默认使用 `bsc-testnet`，再选 `USDC` / `BEM`；SDK 明确传入测试网络。旧配置与余额保留在独立目录，不能只换池地址而保留旧 chain。公网常驻卖家已切到 chain 97 / tUSDC，公网调用与链上结算已通过；见 当前公网验证（运行记录仅保存在本地）。本地双币联调复现见 [启动、SDK 和联调说明](bsc-testnet-local-integration.md)。

## 重现部署验证

新增 `TestBEM.sol` / `TestUSDC.sol` 只允许在 chain 97 部署；两者仅管理员可增发。`DeployBEMTestnet.s.sol` 为 BEM 的 Foundry 入口，要求明确配置 `TREASURY_ADDRESS`，部署签名者由 Forge 的钱包参数提供。生产 BEM 的 chain 56 部署入口保持独立。

本次实际使用 `scripts/deploy-bsc-testnet.cjs`，Solidity 0.8.26、Cancun、optimizer 200。准备阶段会启动仅绑定 localhost 的 Anvil，以测试钱包验证 8 位充值、付款、手续费、重复授权、管理员增发权限及错误网络拒绝；不向公网发送交易。

```powershell
# solc-js 0.8.26 和 Anvil 已安装的情况下：
$env:CLAWMARKET_CONTRACT_TEST_DEPS = '<包含 solc@0.8.26 的依赖目录>'
$env:ANVIL_BINARY = '<本机 anvil 可执行文件的绝对路径>'
$env:TAM_BSC_TESTNET_STATE_DIR = '<仓库外、仅本机主人可访问的部署目录>'
node scripts/deploy-bsc-testnet.cjs --prepare
# 部署 USDC 时使用独立私有目录（不能复用 BEM 的计划和交易日志）：
# $env:TAM_BSC_TESTNET_STATE_DIR = '<另一个仓库外的 USDC 部署目录>'
# node scripts/deploy-bsc-testnet.cjs --payment-token USDC --prepare
```

该目录需提前安全提供 `deployer-wallet.json`，格式为钱包 `address` 和 `privateKey`；不要打印私钥、放在命令历史或复制进仓库。Windows 目录须限制 ACL，Unix 使用仅主人可访问的目录权限。脚本拒绝仓库内的状态目录，默认 RPC 为上述 chain 97 地址。手续费接收地址默认使用部署钱包，可在第一次准备前通过 `TAM_TEST_TREASURY_ADDRESS` 指定自己的测试钱包。

只有明确执行 `--broadcast` 才发送两笔部署交易。每笔交易固定 chain 97、合约创建、转账金额 0；Gas 单价上限为 1 gwei。广播前保存签名交易和哈希，重试使用相同字节和 nonce，防止网络超时导致重复部署。`plan.json`、`standard-input.json`、`preflight.json`、`transactions.json` 和部署私钥保存在仓库外；GitHub 只保存经过筛选的公开部署记录。

当前部署已经完成，无需重新部署来查看地址或领取测试币。RPC 和网络说明见 [BNB Chain 官方文档](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/)。

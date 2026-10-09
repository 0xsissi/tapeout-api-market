# BEM 定价和结算

这一版支持**直接按 BEM 报价、按 BEM 付款**，保留默认 USDC 模式。一台进程只使用一种结算币；买家、卖家和 Hosted Gateway 必须使用同一个币种、链和托管池。

**卖家自己选择币种**：选 USDC 就以 USDC 报价、收 USDC；选 BEM 就以 BEM 报价、收 BEM。不要求按美元报价，AI 也只能在主人选择的币种和价格范围内调价，不能自动改币种。当前 USDC 是 Base Sepolia 上本项目的测试代币，正式 USDC 主网接入还需单独部署和验证。

## 在界面或 CLI 选择

首次交互启动会询问 USDC / BEM；之后可在**设置**页选择下次启动的币种。尚未配置 BEM 托管池和限额时，直接进入设置页填写，完成后退出并重新启动。命令行等价操作：

```powershell
corepack pnpm tam payment list
corepack pnpm tam payment use BEM
corepack pnpm tam
# 单次临时使用 USDC，不改保存的选择
corepack pnpm tam --payment-token USDC config get
```

选择优先级：`--payment-token` > `CLAWMARKET_PAYMENT_TOKEN` 环境变量 > 已保存的选择 > USDC 默认值。环境变量仍然有效，切换时应清除旧币种的 chain、pool、RPC、价格和额度覆盖，或为两个进程分别提供明确的环境。

USDC 使用 `~/.clawmarket/config.json`，BEM 使用 `config-bem.json`。BEM 的日志、节点身份、种子文件和上游登录工作目录在 `~/.clawmarket/bem/`。AI 管理记录保留原位置，以 `tam-agent-state-usdc.json` / `tam-agent-state-bem.json` 分开，旧操作和未确认额度不会因升级丢失。默认服务端口分别为买家 18080 / 18081、卖家 8787 / 8788、AI 管理 18787 / 18788。两套服务可以分别启动；每套仍只接受对应币种和托管池的交易。默认共用主人的钱包地址，两个链上的余额和授权独立。

BEM 新配置的价格和额度都是 0，必须自行填写；不会把旧配置里的 60 USDC 当成 60 BEM。下例只是配置格式演示，不能直接作为真实价格或预算建议：

```powershell
corepack pnpm tam --payment-token BEM config set settlement.escrowPoolAddress '<新部署的 BEMEscrowPool 地址>'
corepack pnpm tam --payment-token BEM config set settlement.rpcUrl 'https://bsc-dataseed.binance.org/'
corepack pnpm tam --payment-token BEM config set settlement.maxRequestCostToken 10
corepack pnpm tam --payment-token BEM config set settlement.maxUnconfirmedCreditToken 20
corepack pnpm tam --payment-token BEM config set settlement.dailyLimitToken 100
corepack pnpm tam --payment-token BEM config set seller.pricing.input 1000
corepack pnpm tam --payment-token BEM config set seller.pricing.output 2000
corepack pnpm tam --payment-token BEM config set seller.pricing.p0 1000
```

切换币种不会修改运行中服务，也不会兑换余额、转移旧池里的资金或改写待收款。需要收取旧币种的收入时，启动旧币种的配置进行结算。不要让两个卖家进程共用同一个签名身份或日志目录。AI 管理权限和预算需要分别授权。

卖家可以报“输入每百万 Token 1000 BEM、输出每百万 Token 2000 BEM”。假设实际用了 1000 个输入 Token 和 2000 个输出 Token，买家确认后付款 5 BEM；默认 1% 手续费下，卖家收到 4.95 BEM，协议收取 0.05 BEM。以上是计算示例，不是推荐价格或 BEM 市价。

## 币种和金额

- BEM 地址：`0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a`，BNB Smart Chain，chain ID 56，8 位小数。
- 1 BEM = 100000000 个最小单位；1 USDC = 1000000 个最小单位。推理用量的“每百万 Token”分母仍是 1000000，不随代币精度变化。
- `inputPer1m`、`outputPer1m`、动态报价 `p0` 和客户端价格上限均表示所选代币/百万 Token。
- 默认每次最低收费为 **0.01 个结算代币**。BEM 模式中的 0.01 BEM 不代表 0.01 美元。
- BEM 请求预算、卖家未确认信用额和日限额必须明确填写，以 BEM 为单位。不会沿用 USD 预算。
- 不含美元汇率换算、DEX 自动兑换，也不假设 BEM 支持 USDC 的 Permit。充值使用钱包 `approve` 后 `deposit`，Gas 使用 BNB。

## 托管合约

现有 USDC 池不能改币种：代币地址是 immutable。先在 BSC 部署新的 `BEMEscrowPool`，再将新地址配置给所有参与者。旧 USDC 余额和授权仍属于旧池，不会自动迁移。

`packages/contracts/script/DeployBEMEscrowPool.s.sol` 只接受 BSC chain 56，要求设置 `TREASURY_ADDRESS`。部署签名者由 Forge 的钱包参数提供。先 dry run；广播部署需要部署钱包和 BNB。BEM 主网池尚未部署。

2026-10-07 已在 **BSC 测试网 chain 97** 部署独立的 tBEM、tUSDC 和各自的结算池，见 [地址、Gas 和联调说明](bsc-testnet-deployment.md)。设置 `CLAWMARKET_PAYMENT_NETWORK=bsc-testnet` 后，CLI / 买卖节点使用测试币和测试池；SDK 使用 `paymentNetwork: 'bsc-testnet'` 或 Python 的 `payment_network='bsc-testnet'`，并指定 chain 97。仅修改池地址或 `CHAIN_ID` 不会切换网络。下方启动和 SDK 示例是默认 chain 56 主网配置；主网池仍需另行部署。

BSC 测试网的配置文件为 `config-usdc-bsc-testnet.json` / `config-bem-bsc-testnet.json`，运行目录为 `~/.clawmarket/bsc-testnet/usdc/` / `bem/`，AI 管理记录也使用独立文件。测试服务端口在各币种原端口基础上增加 300；测试买家为 18380 / 18381，AI 管理为 19087 / 19088。测试配置不沿用主网 BEM 价格、额度、待收款或旧网络公告。

新版合约用 Solidity 0.8.26/Cancun 编译，与仓库中的 OpenZeppelin MCOPY 实现兼容。BSC 的 Cancun 激活配置见 [BNB Chain 客户端配置](https://github.com/bnb-chain/bsc/blob/master/params/config.go)。

`BEMEscrowPool` 永久禁用当前 USDC 交易挖矿，防止把 BEM 数量误认为美元交易额。保留 `usdc()` 和 `cumulativeSettledUsdc()` 作为旧 ABI 名称，数值实际为池内结算代币的最小单位。`settlementToken()` 返回实际代币地址。充值有到账校验，转账扣税导致到账不足时整笔交易回滚；本版本只支持普通 ERC-20 转账行为。

## 启动配置（PowerShell）

以下数值只是示例，应根据卖家的成本和意愿重新填写。`ESCROW_POOL_ADDRESS` 必须填新部署的 BEM 池，不能填代币地址或原来的 Base Sepolia USDC 池。

```powershell
$env:CLAWMARKET_PAYMENT_TOKEN = 'BEM'
$env:CHAIN_ID = '56'
$env:RPC_URL = 'https://bsc-dataseed.binance.org/'
$env:ESCROW_POOL_ADDRESS = '<新部署的 BEMEscrowPool 地址>'
$env:MAX_REQUEST_COST_TOKEN = '10'          # 买家和卖家的单次最高 BEM 额度
$env:MAX_UNCONFIRMED_CREDIT_TOKEN = '20'    # 卖家每位买家的未确认额度，BEM
$env:DAILY_LIMIT_TOKEN = '100'             # 卖家日服务额度，BEM
$env:MAX_PRICE_INPUT_PER_1M = '10000'      # 买家的输入报价上限，BEM/百万 Token
$env:MAX_PRICE_OUTPUT_PER_1M = '10000'     # 买家的输出报价上限，BEM/百万 Token
$env:MODELS_JSON = '[{"model":"你的模型","inputPer1m":1000,"outputPer1m":2000}]'
```

买家继续使用 `BUYER_PRIVATE_KEY` 和 `REFRESH_MODELS`，卖家继续使用 `PROVIDER_PRIVATE_KEY`、上游地址和 `CLAWMARKET_TRUSTED_BUYERS` 等现有配置。不要在命令历史或仓库中放真实私钥。启动入口仍是 `corepack pnpm buyer:testnet`、`seller:testnet` 和 `hosted-gateway:testnet`，名称中的 testnet 不会覆盖上面的 chain 配置。也可以用 CLI 启动本地服务，BEM 的 CLI 配置保存在 `~/.clawmarket/config-bem.json`。

CLI 启动任一币种的买家或卖家前，会只读验证 RPC chain、池代码、池内代币地址和精度；BEM 还验证挖矿关闭。配置不匹配会停止。CLI 充值、提现、调用、收款和 AI 调价前再次核对本地网关返回的币种、链和托管池；缺少元数据的旧网关需要升级。BEM 的推理协议、DHT 和报价主题使用单独池命名空间，旧 USDC 或不同池的公告会被过滤。

基于美元的上游订阅额度跟踪暂不用于 BEM 模式；CLI 会跳过这部分，直接配置 ProviderGateway 时会拒绝美元额度字段。需要保留这项功能时，应另加真实的兑换率适配层。

## SDK

TypeScript SDK：

```typescript
const client = new TAM({
  baseURL: 'https://你的网关',
  privateKey: buyerKey,
  escrowPoolAddress: bemPool,
  rpcUrl: 'https://bsc-dataseed.binance.org/',
  paymentToken: 'BEM',
  chainId: 56,
  maxRequestCostToken: 10,
});
// 金额字符串按 BEM 解析，先授权本次额度，再充值；买家支付 BNB Gas。
await client.depositWithApproval('10.00000001');
```

Python SDK：

```python
client = TAM(
    base_url='https://你的网关', private_key=buyer_key,
    escrow_pool_address=bem_pool, payment_token='BEM',
    chain_id=56, max_request_cost_token=10,
)
```

Python 客户端负责签名和推理付款；充值通过钱包先 approve BEM 再调用池的 deposit。两个 SDK 都校验网关返回的币种，并在完整结果到达后按实际用量确认费用。

新 API 金额字段为 `amountToken`，Hosted prepare 返回 `paymentToken`、`estimatedCostBaseUnits` 和 `estimatedCostToken`。为兼容旧 CLI，还保留部分 `usdcBalance`、`amountUsd`、`*MicroUsdc` 字段名；在 BEM 模式中这些字段也是 BEM 数量或 BEM 最小单位，**没有美元换算含义**。新集成应使用通用字段并检查 `paymentToken`。

## 验证

```powershell
corepack pnpm -r build
corepack pnpm vitest run
```

本地合约测试需要 Foundry 的 Anvil 和 solc-js 0.8.26：

```powershell
$bemTestDeps = Join-Path $env:TEMP 'claw-bem-contract-tests'
npm install --prefix $bemTestDeps --no-audit --no-fund solc@0.8.26
$env:CLAWMARKET_CONTRACT_TEST_DEPS = $bemTestDeps
# anvil 已在 PATH 时可以省略 ANVIL_BINARY；否则填写本地可执行文件路径。
node scripts/test-bem-contracts.cjs
```

测试脚本启动仅绑定 localhost 的 Anvil，使用模拟 8 位代币和测试钱包，验证充值、签名、实际结算、手续费、重复授权、提现、错误精度和转账扣税。没有连接 BSC 主网或发送真实代币。现阶段仍采用买卖双方确认的内测支付模式，不包含争议仲裁。

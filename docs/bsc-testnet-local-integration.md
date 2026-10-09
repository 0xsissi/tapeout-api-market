# BSC 测试网本地使用与联调

TAM 的 USDC / BEM 测试配置都使用 BSC chain 97。界面和 API 里的币种标识仍为 `USDC` / `BEM`，链上实际资产是本项目的 tUSDC / tBEM。地址见 [部署记录](bsc-testnet-deployment.md)。

两种币各 6 项真实模型调用、链上支付及故障检查已通过：联调报告（运行记录仅保存在本地）。

当前公网卖家使用 chain 97 / tUSDC，单次真实公网调用与链上收款已通过：公网验证（运行记录仅保存在本地）。BEM 仍可用于匹配币种的 BSC 卖家，不自动把 USDC 卖家改成 BEM。

公网 `gpt-6-luna` 初始报价为官方 Standard 非缓存短上下文 API 价的 20%：输入 0.02、输出 0.10 tUSDC / 百万 Token。BSC tUSDC 最低单次金额调整为 0.000001，买卖节点和 SDK 需一并更新，见 [报价来源与精度说明](luna-initial-pricing.md)。

## CLI 启动

当前 CLI 和买家/卖家/Hosted 启动脚本默认锁定 BSC 测试网。其他网络覆盖会提示错误；旧配置与旧余额保留在独立目录，不复用为 BSC 配置。从仓库根目录编译，在新的 PowerShell 中启动：

```powershell
corepack pnpm -r build
corepack pnpm tam --payment-token USDC config get
corepack pnpm tam --payment-token USDC
```

新配置会自动使用 chain 97、官方测试 RPC 和本项目的对应测试池。若当前终端保留其他网络的 `CHAIN_ID`、`RPC_URL` 或 `ESCROW_POOL_ADDRESS`，先清除旧覆盖再启动。钱包需要少量 tBNB 和对应测试币；充值是把测试币存入结算池。卖家先填模型上游、价格、限额和可信买家地址，再启动。

交付确认结算使用 bitmap 授权模式。当前启动脚本和 CLI 会配置此模式；底层网关独立接入时需要 `CLAWMARKET_AUTH_NONCE_MODE=bitmap`。不要沿用旧的 sequential 授权启动配置。

改成 BEM 时，使用 `--payment-token BEM`；BEM 价格和预算必须自行设置，不能照搬 USDC 数值。两个币种的配置、节点身份、待收款、日志和 AI 管理预算分开。默认共用主人的钱包地址，但池内余额和授权分别计算。测试买家端口为 USDC 18380 / BEM 18381，AI 管理为 19087 / 19088；独立配置可修改端口。

买家和卖家必须选择相同币种、chain 和池。测试网络发现协议会过滤其他网络、缺少币种元数据或其他池的公告。公网中继可用于连接发现；当前市场网站也仅展示 BSC 测试网卖家。

## SDK

TypeScript 示例，私钥由本机的安全钱包配置提供：

```typescript
const client = new TAM({
  baseURL: 'http://127.0.0.1:8787', // 实际启动的 Hosted Gateway 地址
  privateKey: buyerKey,
  paymentToken: 'USDC',
  paymentNetwork: 'bsc-testnet',
  chainId: 97,
  rpcUrl: 'https://bsc-testnet-dataseed.bnbchain.org',
  escrowPoolAddress: '0x90D30bA5d3e72A029335D2B879786ba912EA6e5F',
  maxRequestCostToken: 0.1,
});
await client.depositWithApproval('1');
const reply = await client.chat.completions.create({
  model: '卖家公布的模型名',
  messages: [{ role: 'user', content: '你好' }],
  max_tokens: 128,
});
```

tUSDC 也支持 `depositWithPermit`，需要配置 Hosted Gateway 的 relayer 及访问令牌。它使用 `TAM Test USDC` / `1` 的 Permit 签名域；接口确认链上交易成功后才返回成功。BEM 使用有限额度 `approve + deposit`，暂不使用 Permit。

Python 使用相同的网络和池：

```python
client = TAM(
    base_url='http://127.0.0.1:8787', private_key=buyer_key,
    payment_token='USDC', payment_network='bsc-testnet', chain_id=97,
    escrow_pool_address='0x90D30bA5d3e72A029335D2B879786ba912EA6e5F',
    max_request_cost_token=0.1,
)
```

BEM 对应的池是 `0xfd95F0cA22D6c2Ca8dE3Bd42f88c6b94ABf6724e`；SDK 币种改为 `BEM`，限额单位为 BEM。Python 默认绕过 localhost / 回环地址的系统代理，远程网关保留系统代理配置；可用 `trust_env` 明确覆盖。

模型账户反代可能附加系统提示词，使实际输入比用户消息多。买家和 Hosted Gateway 默认留出 **512 输入 Token** 的预算；TS SDK 用 `inputOverheadTokens`，Python 用 `input_overhead_tokens`，应与 Hosted Gateway 设置一致。CLI 用 `buyer.inputOverheadTokens`，运行脚本用 `INPUT_OVERHEAD_TOKENS`。范围为整数 0–8192。它影响授权上限，最终仍按实际用量收费，并受到单次金额上限约束；超过预算的结果不能生成收款授权。

## 复现真实联调

`scripts/smoke-bsc-testnet.mjs` 启动临时本地 P2P 买家、卖家和 Hosted Gateway，通过 chain 97 的真实回执验证充值、普通及流式调用、SDK 签名、卖家收入、手续费、重复授权和失败不扣费。测试采用新生成的私有钱包，不能给仓库里公开的模拟私钥转账。

```powershell
$env:TAM_BSC_TESTNET_STATE_DIR = '<仓库外、主人可访问的私有测试目录>'
$env:CLAWMARKET_PAYMENT_NETWORK = 'bsc-testnet'
$env:CLAWMARKET_PAYMENT_TOKEN = 'USDC' # 换成 BEM 可测试另一币种
$env:PYTHON_BINARY = '<已安装 Python SDK 依赖的 python.exe>'
$env:TAM_SMOKE_UPSTREAM_FILE = '<私有上游配置文件>'
node scripts/smoke-bsc-testnet.mjs
```

目录中需安全提供 `deployer-wallet.json`（地址和私钥）；部署钱包必须持有对应测试币和少量 tBNB。脚本给新买卖钱包发放少量测试 Gas、给买家发 10 个测试币，并通过本地买家接口充值 5 个。设置交易会保存已签名字节和哈希，重跑时复用；这些文件仅保存在仓库外。测试会实际消耗 tBNB，真实上游模式也会使用模型账户额度。

上游私有 JSON 格式为 `proxyUrl`、`proxyHeaders` 和 `model`；例如指向本机 SSH 隧道的账户反代。不要提交登录资料或请求头密钥。不设置这个文件时使用确定性模拟模型，只能验证模型模拟条件下的付费流程。脚本结束后停止临时节点，不改动原常驻服务。

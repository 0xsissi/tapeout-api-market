# TAM 市场网站与测试币领取

网站为 Notion 风格的简洁市场目录，包含 API 市场、项目介绍、网络节点、测试币领取和快速开始。**当前内测统一使用 BSC 测试网（Chain 97）**，目录只接收此网络已部署测试币与结算池的公告，没有其他网络选项。查询页面不需要钱包；领取测试币时连接浏览器钱包，切换 BSC 测试网，并签署可读的领取消息。网站不收集买家钱包私钥。

公网入口：[https://shenjige.xyz/](https://shenjige.xyz/)。2026-10-07 已部署 HTTPS 首页、真实公告观察与独立测试币领取服务；公网领取 tUSDC / tBEM 已核对成功链上回执。当前有两个发现入口和一个 tUSDC 卖家，具体数量与库存随运行变化。领取测试币不会自动取得许可卖家的调用权限。见 部署与验证证据（运行记录仅保存在本地）。

## 项目介绍

首页默认展示项目介绍，品牌标志也返回介绍页。API 市场可通过菜单、介绍页按钮或 `#market` 链接进入；其他已有页面链接保持可用。

项目介绍可直接分享：[中文 BP 展示](https://shenjige.xyz/?lang=zh#about) · [English product brief](https://shenjige.xyz/?lang=en#about)。2026-10-08 按简报样式重做：白灰配色、衬线大标题、宽留白与章节导航，从“每天整理资料的 Agent 怎么选接口”讲起，再展示六步调用流程、五项技术机制、收费方式和测试进展。团队、融资和商业用户数据没有公开材料，页面不填写这些数字。

六步流程可播放、暂停或单步查看；图中请求和响应反向流动，最终付款账单从买家交给卖家，收款时才提交合约。充值上链，单次意向在链下签署。批量结算用八张账单合并为一个批次的示意展示，AIMM 滑块支持 α 为 0、1、2，99/1 的分账条说明当前测试协议费。演示不执行模型请求、签名或付款；实时统计复用市场观察结果，不代表累计用户或营收。

页面支持「中 / EN」按钮与分享链接语言选择，遵循系统减少动画偏好。流程动画在离开介绍页、标签隐藏或流程图滚出视野时停止。正文说明没有中心调度服务器，但连接、网站和上游仍有服务器组件；ZK 卡片标注接口已预留、真实验证待接入，避免将路线图当成已完成能力。

## 运行

先执行 `corepack pnpm cli:build`，然后执行（无需另选网络）：

```powershell
corepack pnpm market:web
```

默认监听 `http://127.0.0.1:18400`。不配置钱包时可以查市场，领币按钮会显示不可用。配置项见 [market.env.example](../deploy/env/market.env.example)。脚本读取进程环境变量，不会自动加载此文件。

```powershell
$env:TAM_MARKET_SEED_FILE = 'E:/private/seller-public-seed.json'
$env:TAM_FAUCET_STATE_DIR = 'E:/private/tam-faucet'
corepack pnpm market:web
```

`TAM_MARKET_SELLER_PEERS` 也可配置逗号分隔的公网卖家 multiaddr。观察节点每轮读取入口的最新地址列表、连接并读取 P2P 公告，发布前校验已部署的网络、币种、小数位和结算池组合。旧 seed 只提供连接地址，不作为当前公告。

观察轮次每 30 秒触发，连接失败或节点较多时发现可能延后。同一个目标节点的 TCP、WebSocket 和中继地址合并为一个扫描名额，每节点保留最多四条连接路径；每轮最多检查 24 个不同节点，超过时轮流扫描，避免一直停留在地址列表前部。

## 页面数据的含义

- “可见卖家”“可见模型”只统计最近成功读取到的公告。公告超过 120 秒或最近观察超过 90 秒标为过期，10 分钟后移除。目录是当前观察节点的视野，不是全网完整名单。
- “最近可连接”表示公告读取成功，不能证明模型来源、实际推理可用性或任意买家都获得许可。当前卖家仍需配置可信买家。
- 价格是卖家公告的输入/输出价格，单位为结算币 / 百万 Token。实际交易仍由买家节点重新报价。不同网络和币种分别比较，网站不做美元兑换或换币。
- 公网入口的在线状态来自 `/health`；耗时是 HTTP 健康查询耗时。Bootstrap/中继节点帮助连接，不负责代替买卖双方签名结算。
- “网络节点”分为入口与中继、已发现的卖家两组。卖家卡片展示模型、钱包、结算币、连接方式和公告/读取时间，包含通过中继连接的本机卖家；“查看服务与价格”跳转到对应钱包的市场报价。它与 API 市场使用同一份目录数据。
- 前台页面每 15 秒读取目录，也可手动刷新；重新切回标签时立即读取。页面刷新时间和卖家观察时间分开显示。网站连接失败时保留上次数据并提示，旧在线状态仍按时间失效。刷新网站只读取观察结果，不能强制其他节点立即发布公告。
- 网站仅公开经过筛选的公告字段，不公开管理接口、上游 URL、API key、请求队列或买家名单。
- 卖家、买家和领取服务都使用 BSC 测试网。每个卖家进程选择 tUSDC 或 tBEM 之一；买家仍需选择相同币种与结算池。其他网络的旧公告会被服务端过滤，不进入价格列表或在线统计。

## 测试币服务

此服务只支持 **BSC 测试网 Chain 97**：

| 币种 | 每次领取 | 精度 | 合约 |
| --- | --- | --- | --- |
| tUSDC | 20 | 6 | `0xFcc26b50731525a4452D0ED428cdf11058723B89` |
| tBEM | 100 | 8 | `0x6DD0Be28736F638844499B019DBaacc5897dAAC2` |

tUSDC 是 TAM 自建测试币，不是 Circle USDC；tBEM 与主网 BEM 独立。领币服务支付转账 Gas，领取地址可以没有 tBNB。之后充值托管池仍需自己的测试 Gas；页面在代币按钮之前单独展示 tBNB 的领取链接、步骤和备用方法。

### 如何领取测试 BNB（tBNB）

1. 在钱包选择 BSC 测试网（Chain 97），复制接收地址。页面提供「切换 / 添加 BSC 测试网」和「复制我的钱包地址」按钮。
2. 新钱包可以打开 [QuickNode BSC 测试网水龙头](https://faucet.quicknode.com/binance-smart-chain/bnb-testnet)，选择 `Binance Smart Chain / Testnet`，输入地址或连接钱包，按提示完成验证并领取。
3. 等交易确认，在同一地址的 BSC 测试网查看 BNB 余额；然后进行测试币充值或链上收款。领取 tUSDC / tBEM 只需消息签名，领取地址本身没有 tBNB 也可以领取。

截至 2026-10-07，QuickNode 页面说明基础领取不需要主网余额、注册账户或发推文，通常每钱包每网络 12 小时一次，具体数量显示在领取步骤中；它适合刚创建的钱包。BNB Chain 官方文档也列出这个入口。

也可使用 [BNB Chain 官方水龙头](https://www.bnbchain.org/en/testnet-faucet)，它当前要求接收地址在 BSC 主网持有至少 0.002 BNB，每 24 小时一次。官方文档另列 [Telegram 支持机器人](https://t.me/bnbchain_official_bot)：可以发送 `I would like to get tBNB to my wallet 0x你的地址`，把占位地址替换为自己的真实钱包地址，等待支持回复。另一个入口 [Chainstack 的 BSC 测试网水龙头](https://faucet.chainstack.com/bnb-testnet-faucet) 当前需要其 API key，页面另列至少 0.08 主网 ETH 和持币历史的条件，适合已有合格钱包的用户。各入口是否有额度、需要什么验证，以提供方页面为准；没有承诺保证发币。来源：[官方领取说明](https://docs.bnbchain.org/bnb-smart-chain/developers/faucet/)。

采用独立的、预先注资的转账钱包。**网站进程不加载代币管理员/部署钱包**，也不调用 mint。每钱包每币 24 小时一次，全站 24 小时最多 100 次，同源 IP 24 小时最多 4 次，每 IP 五分钟最多 10 个签名挑战。记录跨重启保留，IP 只保存带随机盐的哈希；限额含已提交的失败交易以限制 Gas 消耗。Gas 价格上限 1 gwei，单笔 Gas limit 上限 100000，低余额时停止发币。

在 Git 外创建仅运行用户可读取的目录，放入 `faucet-wallet.json`（字段 `address`、`privateKey`）。可使用准备脚本生成专用钱包并从已有部署钱包注资：

```powershell
$env:TAM_BSC_TESTNET_STATE_DIR = 'E:/private/tam-bsc-owner'
$env:TAM_FAUCET_STATE_DIR = 'E:/private/tam-faucet'
node scripts/prepare-market-faucet.mjs
# 查看准备结果后，以下命令才会发送测试网交易：
node scripts/prepare-market-faucet.mjs --broadcast
```

部署目录需已有 `deployer-wallet.json`。首次注资固定为 0.005 tBNB、1000 tUSDC、10000 tBEM。准备脚本通过固定标签的持久日志避免重试重复转账；重复执行不会额外补充已完成的初始注资。需要补充库存时，向专用地址转账即可。

签名前校验钱包所有权、站点、随机挑战、有效期、网络和额度。交易原始字节和哈希先持久保存，再广播；RPC 超时后的重试使用相同字节和相同哈希。上一笔结果未知时暂停新转账，避免跳过 nonce。只有成功回执才报告 `confirmed`。`pending` 不能当成已到账；`reverted` 表示失败。

私有目录的 `website.lock` 阻止多个网站进程共用钱包。正常关闭会释放锁；进程崩溃后须核对 `website.lock/pid` 对应进程已停止、同一钱包没有其他实例，再人工清理锁。**保留钱包和 `faucet-ledger.json`，不要删日志来重置限额。**

## 给 AI 使用

`GET /api/agent.json` 描述接口，`GET /api/market` 返回可见卖家与节点，`GET /api/faucet` 返回领取额度、专用服务地址与库存。领取示例：

```javascript
const base = 'https://shenjige.xyz'; // 本地预览可改为 http://127.0.0.1:18400
const post = async (route, body) => {
  const response = await fetch(base + route, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error.message);
  return result;
};
const challenge = await post('/api/faucet/challenge', {
  address: recipientWallet.address, currency: 'BEM',
});
// 人或 AI 在本机持有接收钱包；仅发出此次消息签名。
const signature = await recipientWallet.signMessage(challenge.message);
const claim = await post('/api/faucet/claim', { id: challenge.id, signature });
const receipt = await (await fetch(`${base}/api/faucet/claims/${claim.id}`)).json();
```

结果未知时查询同一编号，必要时重试相同编号和签名。不要另建请求。领取签名不授权代币支出。调用模型、买家充值和卖家收款使用现有本地 TAM 软件、SDK 或 AI 管理接口；网站没有接管用户资金管理。

## 公网部署

本地预览不会自动开放公网。公网部署需要配置准确的 `TAM_MARKET_ORIGIN`、HTTPS，并使用有权限保护的私有数据目录。服务有同源检查、无 CORS、限制请求体和请求频率、CSP 等基础保护。

当前站点由 Nginx 提供 HTTPS，代理至 `127.0.0.1:18400`，后台由独立的 `tam-market` 用户及 systemd 服务运行。钱包和领取记录在 `/var/lib/tam-market`，目录权限 700、钱包权限 600；此路径不在发布目录内。网站使用自己的有限库存钱包，和模型卖家、部署管理员的钱包分开。服务只在回环地址监听，公网无需开放 18400。配置参考 [systemd 模板](../deploy/systemd/tam-market.service.example)、[Nginx 代理模板](../deploy/nginx/tam-market-location.conf.example) 和 [环境配置](../deploy/env/market.env.example)。模板须按实际运行用户、Node 路径、HTTPS 域名和已有路由调整。

原有主页保留在 [shenjige.xyz/swap/](https://shenjige.xyz/swap/)，原 `/arc/`、`/bsc/`、`/redian` 路由保持原配置。变更 Nginx 前保存了配置备份并通过 `nginx -t`；后续切换发布目录前也应先备份，保留私有钱包和账本。

默认按 socket IP 限流并忽略 `X-Forwarded-For`。在本机 Nginx 反向代理后，可明确设置 `TAM_MARKET_TRUST_PROXY=loopback`：仅从回环地址接收单个有效的转发 IP，拒绝多地址链或非法值，非本机连接的该请求头始终无效。Nginx 必须使用 `proxy_set_header X-Forwarded-For $remote_addr` **覆盖**用户输入，不能使用追加客户端请求头的方式。这样每个真实用户拥有自己的 IP 限额，伪造请求头不能绕过。钱包每日限额不是防女巫身份认证；公开大规模领币可再加 CAPTCHA/allowlist。不要向测试币服务钱包存入主网资金。

自动测试覆盖签名、网络和币种绑定、限额、重启恢复、并发与不确定交易重试，以及公告公开范围、过期和 HTTP 输入验证。真实链上领币证据见 网站验证报告（运行记录仅保存在本地）。

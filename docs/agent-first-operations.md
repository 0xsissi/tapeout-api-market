# TAM：AI 操作，人看状态

TAM 提供一个本地 AI 管理入口，让用户自己的 AI 查询市场、调用 API、补充预算、结算收入和提出调价。人通过现有控制台设置经营规则、查看结果和暂停后续操作。

这是可调用的接口和规则执行功能。项目没有内置一个自动思考、持续调用模型的经营机器人；用户把自己的 AI 或定时任务接到此入口即可执行这些操作。

## 人怎样使用

先构建：`corepack pnpm build`。在项目根目录执行 `corepack pnpm tam console`。

- **总览**：查看买家可用预算、卖家待收款和服务状态。
- **余额与充值**：钱包里的币先充值为 API 可用预算，再用于调用服务；未使用的余额可申请退回钱包，等待 48 小时后完成。
- **收入与收款**：查看待结算收入、累计结算金额、钱包余额和最近交易；已有自动批量收款，也可选择「立即收款」。结算金额包含协议手续费，实际到账以钱包与链上交易为准。
- **AI 管理**：设置每日调用预算、单次上限、每日自动充值额度、允许的模型，以及卖家最低价、最高价、最大调幅和最短间隔。分别允许调用、充值、收款、调价，然后开启自动操作。

自动操作默认暂停、权限为空。设置规则不会直接发起充值或转账。人可随时暂停后续操作，已经提交的交易仍需等待结果。

当前内测统一使用 BSC 测试网（Chain 97）。USDC / BEM 模式分别使用 tUSDC / tBEM 与对应托管池，手续费使用 tBNB，不自动兑换币种。主网尚未启用。

## AI 怎样接入

控制台打开时启动 `http://127.0.0.1:18787` 管理服务。需要独立运行时执行：

```text
corepack pnpm tam agent serve
corepack pnpm tam agent tools
corepack pnpm tam agent status
corepack pnpm tam agent pause
```

默认买家和卖家地址仍由本地 CLI 配置决定。独立服务可使用 `--port` 修改端口。一次只运行一个管理服务；控制台退出时关闭由本次控制台启动的入口，独立服务不受影响。

管理令牌保存在 `~/.clawmarket/tam-agent-token`，启动命令显示路径，不输出令牌。接入程序可读取该文件；不要把钱包私钥或原有网关的主人令牌给受限 AI。规则与账本按 USDC/BEM 分开保存。

| 接口 | 用途 |
| --- | --- |
| `GET /v1/tam/status` | 余额、市场、服务、主人规则、今日预算和最近活动 |
| `GET /v1/tam/tools` | JSON Schema 参数、函数工具说明、调用方式与恢复说明 |
| `GET /v1/tam/operations` | 最近 100 条操作记录，按编号查询执行结果 |
| `POST /v1/tam/actions` | 发起已授权的调用、充值、收款或调价 |

接口需要 `Authorization: Bearer <管理令牌>`。只监听本机，并拒绝浏览器跨域调用。该令牌不能通过管理 API 改规则、导出钱包私钥、提现或修改网关地址。

工具说明包含 `functionTools`，例如 `tam_invoke`、`tam_deposit`、`tam_collect`、`tam_price`。AI 宿主把函数调用中的 `{id, reason, params}` 转成 `{id, action, reason, params}` 提交给管理接口，或调用下列 SDK；TAM 本身不调用定价模型。先读取状态检查模型清单、预算和服务是否在线，再考虑执行。

### TypeScript

```ts
import { readFileSync } from 'node:fs';
import { TAMAgentClient } from '@clawmarket/agent-sdk';

const ai = new TAMAgentClient({
  token: readFileSync(process.env.TAM_AGENT_TOKEN_FILE!, 'utf8').trim(),
});
const status = await ai.status();
const result = await ai.invoke('writing-task-001', {
  model: 'gpt-5.4',
  messages: [{ role: 'user', content: '写一句项目介绍' }],
  max_tokens: 100,
}, '模型与费用符合主人设置的范围');

// 必须检查 operation.status；HTTP 200 也可能表示 uncertain。
if (result.operation.status === 'succeeded' && !result.replay) {
  console.log(result.result.choices[0].message.content);
}
```

### Python

```python
import os
from pathlib import Path
from clawmarket_agent_sdk import TAMAgentClient

ai = TAMAgentClient(token=Path(os.environ['TAM_AGENT_TOKEN_FILE']).read_text().strip())
status = ai.status()
result = ai.collect('collect-income-001', '结算已经交付确认的收入')
print(result['operation']['status'])
ai.close()
```

其他操作：`deposit(id, "金额字符串", reason)`、`price(id, model, p0, alpha, reason)`。价格单位是当前结算币/百万推理 Token。管理客户端无需钱包私钥，不会自动重试付款。

## 规则怎样执行

- 调用前预留单次上限；完整交付后按网关返回的实际付款授权金额记账，释放剩余额度。底层网关仍执行自身的请求上限。
- 每日调用预算与每日充值额度分别计算，不把“充进资金池”当作“已经消费”。预算按 UTC 日计算，进行中和结果不确定的预留跨日保留。
- 操作编号和参数摘要在执行前保存。重复编号返回旧状态；换编号提交完全相同的进行中或不确定操作也会被拦截。重放结果不会重新返回完整模型回答，AI 应保存首次返回的内容。
- 调价检查模型清单、最低/最高价、单次幅度和间隔；AIMM 后续报价受最高价约束。调价作用于当前卖家运行实例，重启恢复原有启动配置，需要 AI 根据状态重新评估。
- 主人通过控制台或 `agent policy --file <JSON文件>` 修改规则，AI 的 HTTP 接口不能修改它们。

预算和权限仅约束经过此管理入口的操作。原有本地网关令牌、CLI 和钱包文件是主人权限，不能把这些入口同时交给受限 AI 后仍期待管理入口控制全部行为。

## 人能看到什么

「AI 管理」分成总览、预算与模型、操作权限、卖家调价规则、最近操作几个简短页面。可以看到今日已花、剩余额度、预留额度、自动充值用量、价格范围，以及最近操作的编号、时间、结果、金额和 AI 提供的原因。完整记录可通过接口读取。

操作记录不保存请求提示词、完整模型回答或钱包签名密钥。实际调用金额是已经签出的付款授权，并不表示卖家已完成链上收款；卖家到账状态由收款页展示。

## 异常与恢复

网络超时、付款确认丢失或结果缺少费用信息时，记录为 `uncertain` 并保留预算。不要换操作编号重新付款；先查询原操作记录，由主人核对交易与仍可兑现的付款授权。旧版本网关没有返回费用信息时也会进入待核对状态，需要一起更新网关。

本版本不自动裁决不确定付款。账本损坏、钱包/网关配置不匹配或锁尚未释放时，停止执行；不要直接删除账本来恢复额度。保留文件并核对资金状态后再进行维护。进程中断时的 `pending` 记录继续占用额度。

本次验证以本地模拟为主；真实上游、链上手续费和到账延迟仍需实际环境内测。

验证范围与重跑方法见 本次验证记录（运行记录仅保存在本地）。

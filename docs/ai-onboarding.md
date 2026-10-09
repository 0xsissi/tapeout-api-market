# 从一个网址接入 TAM

给具备本机安装权限的 AI 提供 https://shenjige.xyz/skill.md 。网站首页的“让 AI 帮你接入”提供复制按钮。`/llms.txt` 和 `/api/agent.json` 可以发现指南、安装器、当前版本和市场接口。普通网页聊天中的 AI 没有操作电脑权限时，不能仅凭网址完成安装。

## 公开客户端下载

源码仓库保持私有；公开发布经过文件白名单筛选的 BSC 内测客户端。下载包包含六个运行时包的编译产物、客户端网页、必要启动脚本与锁文件；不包含 Git、node_modules、环境文件、钱包、代理登录、服务器配置或私有部署材料。这不是将整个源码项目声明为 MIT 或完成开源。

运行 `node scripts/build-client-release.mjs /ABSOLUTE/EXTERNAL/DOWNLOADS https://shenjige.xyz 0.2.0-bsc-pilot.2` 生成普通文件 tar.gz 与清单。安装器需要 Node 22+ 和 npm，验证同源 HTTPS、固定网络、文件大小、SHA-256、tar 校验和，拒绝路径穿越、链接、重复路径和 Windows 设备名；随后通过固定 pnpm 10.18.3 执行生产依赖 frozen install，禁用 lifecycle scripts。参见 [pnpm install 文档](https://pnpm.io/cli/install)。

Windows 的 pnpm junction 使用绝对目标，因此解包完成后先进入最终版本路径，再安装依赖；启动器只在 CLI 完整加载检查成功后更新。不能先安装再移动目录。失败版本保留供检查，不能覆盖已有版本。默认安装 `~/.tam/client`，`node ~/.tam/client/tam.mjs` 是跨平台入口，没有修改 PATH。安装本身不创建钱包、不交易。

`join prepare` 要求角色、模型、单次与每日限额；卖家还必须提供输入/输出价。预算单位为选择的币种。已存在的钱包不被替换，损坏/不一致的钱包会停止流程。配置不会自动解锁 AI 权限。`join status` 输出余额、节点状态、预算与规则；敏感配置仅显示是否已配置。

可用 `TAM_HOME` 指定独立数据主目录（其内部使用 `.clawmarket`），避免测试覆盖原客户端。钱包、配置、网关 token、AI 账本与卖家 billing 使用该目录；已有用户未设置时继续使用原主目录。模型账号默认来源仍是主人明确选定的实际账号。多实例还须设置独立买家/卖家 URL、P2P、scheduler、UI、agent 端口；不会自动杀死已有进程。

## 买家审核

`join apply --seller ADDRESS` 从本站申请专用 EIP-191 消息，在本机对照完整固定模板后签名。签名证明地址归属，不授权代币花费，也不证明信用或模型身份。申请为 pending，不能调用许可卖家。重复运行查询原编号；未知结果不新建申请。

状态目录通过 `TAM_ADMISSION_STATE_DIR` 配置，位于安装/Git 之外。每个申请单独保存，IP 只保留带私有盐的摘要，不保存签名。限制每钱包/卖家/币种每日一次，每 IP 每日五次，全站每天二百次，并限制 challenge 频率、内存和总记录数。没有公开管理员批准接口。

运营方在服务器上执行：

```sh
runuser -u tam-market -- env TAM_ADMISSION_STATE_DIR=/var/lib/tam-admission TAM_MARKET_ORIGIN=https://shenjige.xyz node /opt/tam-market/current/scripts/review-admission.mjs list
runuser -u tam-market -- env TAM_ADMISSION_STATE_DIR=/var/lib/tam-admission TAM_MARKET_ORIGIN=https://shenjige.xyz node /opt/tam-market/current/scripts/review-admission.mjs approve APPLICATION_ID --hours 24
runuser -u tam-market -- env TAM_ADMISSION_STATE_DIR=/var/lib/tam-admission TAM_MARKET_ORIGIN=https://shenjige.xyz node /opt/tam-market/current/scripts/review-admission.mjs reject APPLICATION_ID
```

只能核实后授权，不能把有效钱包签名当作信用审核。授权 1–168 小时，操作锁防止并发审核；状态与有效授权写入同一原子文件。`/api/admission/approved` 只公开已批准且未过期的地址、卖家、币种、链、池和期限，不公开完整申请、签名或 IP。

我们的内测卖家明确设置 `TAM_ADMISSION_ORIGIN=https://shenjige.xyz`，每 30 秒通过同源 HTTPS 拉取经站长审核的授权，写入外部 `CLAWMARKET_TRUSTED_BUYERS_FILE`。这是当前许可内测卖家的集中审核服务，其他卖家不被强制使用它。客户端没有设置远端审核来源的权限。拉取失败不续期，保留原期限的已获取授权；撤销传播在网络正常时最多约 30 秒。卖家逐次读取文件核对地址、卖家、币种、链、池与 expiry，原本单独配置的可信买家仍有效。

服务 sandbox 需只额外允许写申请目录，例如 systemd drop-in `ReadWritePaths=/var/lib/tam-admission`；下载目录只读。不要扩大成整个 `/var/lib` 可写。私有文件权限不会用来保护公开下载目录中的材料；私有材料从未放入下载包。

## 卖家与主人权限

卖家可通过安装目录外的私有 `upstream-file` 使用自己的 OpenAI 兼容 API，无需嵌入账号代理；URL 使用 HTTPS 根地址或本机 HTTP 根地址，凭据使用 private headers。另一种入口保留主人账号登录与独立 CLIProxyAPI，要求 Git、合适 Go 和实际登录授权。

`join trust --buyer ADDRESS --hours 24` 是当前卖家的主人审核操作；撤销使用 `--revoke`。不发送链上交易，文件锁与原子写入防止并发覆盖；不是 AI 安装流程的默认步骤。AI 必须先取得主人明确授权。

`join start` 启动选定角色和 loopback 管理接口，买家默认还打开网页，headless 模式不需要浏览器。该命令不自动充值或调用。`agent tools` 提供准确参数，`agent policy`/主人界面控制权限。费用与操作通过原账本限额和 idempotency 规则处理。BEM 与 USDC 独立，不自动交换或照搬价格。

`join claim` 用同一钱包领取固定测试币；重跑查询同一编号。此快捷入口用于首次接入，不安排每日领币任务。重复领币使用网站当前规则；不可删除未知结果记录来发起另一交易。充值需要同一钱包的测试 BNB 与主人确认，领到测试币也不代表托管池已充值。

# Onboarding V2 QA

## 场景 1：新机器买家

1. 删除本机测试配置：`rm -rf ~/.clawmarket`。
2. 运行 `clawmarket`，选择 `buyer`。
3. 在 `buyer_wallet` 确认显示 Base Sepolia 钱包地址和二维码，手机扫码读出的地址与页面一致。
4. 等 `buyer_start` 启动完成后进入 `buyer_fund`。
5. 确认 0 ETH / 0 USDC 时页面显示水龙头链接；从 faucet 充值后按 `r` 或等待自动刷新。
6. 余额达标后选择模型，`buyer_purchase` 输入小额 USDC，确认能成功上链。
7. 进入 console 后发送一条 chat 请求。

## 场景 2：新机器卖家 Claude

1. 删除本机测试配置：`rm -rf ~/.clawmarket`。
2. 运行 `clawmarket`，选择 `seller`。
3. 在 `seller_wallet` 生成钱包，确认显示地址和二维码。
4. 在 `seller_upstream` 选择 Claude，完成 CLIProxyAPI OAuth 登录。
5. 在 `seller_models` 选择至少 1 个 Claude 模型。
6. 设置 input/output 价格，确认文案说明所有选中模型共享同一组价格。
7. 在 `seller_gas_check` 给钱包充值少量 ETH，刷新通过后启动 seller。
8. 请求 `http://127.0.0.1:8787/v1/seller/status`，确认模型、价格和 upstream 选择一致。

## 场景 3：两者都要

1. 删除本机测试配置：`rm -rf ~/.clawmarket`。
2. 运行 `clawmarket`，选择 `both`。
3. 走完 14 步后检查 `~/.clawmarket/config.json`，确认 buyer 与 seller 新字段均已写入。

## 场景 4：断网 / RPC 挂

1. 在无法访问 Base Sepolia RPC 的网络下进入 `buyer_fund` 或 `seller_gas_check`。
2. 确认页面显示 RPC 错误，不崩溃。
3. 恢复网络后按 `r` 可重新拉取余额。

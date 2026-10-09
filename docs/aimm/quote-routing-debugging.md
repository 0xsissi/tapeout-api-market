# AIMM Quote 路由调试手册

这份手册给 buyer / seller 联调时用。目标不是解释 AIMM 原理，而是看到 fallback 后，能立刻定位卡在哪一层。

## 先看 3 个信号

1. buyer 日志里有没有 `AIMM quote selection fallback`
2. buyer `GET /metrics` 里的 `aimm_quote_cache_size` 是否大于 0
3. seller 日志里有没有持续的 `[QuoteBroadcaster]`

如果 seller 在广播，但 buyer cache 一直是 0，优先排查 p2p topic 传播和模型 topic 是否对齐。

## Fallback reason 对照表

### `no_quote_cache`

含义：buyer 根本没有启用 AIMM quote cache。

排查：
- 确认 buyer 是新版本，启动流程里已经创建 `LocalQuoteCache`
- 确认 `QuoteSubscriber.start()` 没被跳过

### `no_active_quotes`

含义：当前模型没有可用 quote。

常见原因：
- seller 没广播
- buyer 订阅的模型和 seller 广播的模型没交集
- quote 已经过期，GC 清掉了

排查：
- 看 seller `MODELS_JSON`
- 看 buyer `REFRESH_MODELS`
- 看 buyer `Quote models:` 启动日志

### `no_provider_match`

含义：buyer 收到了 quote，但 router/provider cache 里没有同 peerId 的 provider。

常见原因：
- p2p provider discovery 还没 warm 完
- quote 比 provider announcement 更早到达
- seed bundle / bootstrap peers 不完整

排查：
- 先看 `aimm_quote_cache_size`
- 再看 provider refresh/warm 日志
- 用 seed provider bundle 做一次兜底验证

### `all_candidates_filtered`

含义：有 quote，也能对上 provider，但全被本地过滤规则排掉了。

常见原因：
- 用户手动排除了某些 peer
- `maxPriceInputPer1m` / `maxPriceOutputPer1m` 太低

排查：
- 检查 buyer 本地价格上限
- 检查 excluded peers 配置

### `price_circuit_tripped`

含义：maker 报价高得离谱，触发了 buyer 的价格熔断。

常见原因：
- maker `u_window` 很高
- seller 配置了过大的 `alpha`
- 上游 quota 已接近打满

排查：
- 看 seller `/v1/seller/status`
- 看 quote 里的 `currentPrice / p0`
- 看 quota tracker 是否已经接近 1

## 推荐排查顺序

1. 先看 buyer metrics 的 `aimm_quote_fallback_total{reason="..."}`
2. 再对照 seller `MODELS_JSON` 和 buyer `REFRESH_MODELS`
3. 再看 `aimm_quote_cache_size`
4. 最后才看 legacy scheduler

只要先把 fallback reason 看明白，AIMM 路由问题通常都不会再是“玄学”。

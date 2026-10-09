/**
 * @clawmarket/consumer-gateway — Consumer (Buyer) Local Gateway
 *
 * Exposes standard OpenAI-compatible API on localhost.
 * Routes requests through P2P network to optimal Provider.
 */

export { ConsumerGateway } from './local-server.js';
export type { ConsumerGatewayOptions } from './local-server.js';
export { P2PRouter } from './router.js';
export { WalletManager } from './wallet.js';
export { PoolManager } from './pool-manager.js';
export { QualityMonitor } from './quality-monitor.js';
export { LocalQuoteCache } from './quote-cache.js';
export { QuoteSubscriber } from './quote-subscriber.js';
export { SchedulerConfigManager, DEFAULT_CONFIG } from './scheduler/config.js';
export { SchedulerLogger } from './scheduler/logger.js';
export { Scheduler } from './scheduler/scheduler.js';
export { SessionStickyTable } from './scheduler/session-sticky.js';
export { SchedulerAdminServer } from './scheduler/admin-endpoint.js';
export { softmaxSample, greedyPick } from './scheduler/softmax.js';
export type { SchedulerConfig, SchedulerMode } from './scheduler/config.js';
export type { SchedulerDecisionLog, DecisionLogBuilder } from './scheduler/logger.js';

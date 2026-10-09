/**
 * @clawmarket/p2p-node — P2P Network Layer
 *
 * Replaces V1's centralized Registry + Relay with libp2p DHT
 */

export { createNode, loadOrCreateNodeIdentity, dialPeerAddress, type ClawMarketNode } from './node.js';
export { ensureQuoteSigningKey, type ManagedSigningKey } from './key-manager.js';
export { ProviderRegistry } from './provider-registry.js';
export { ConsumerRouter } from './consumer-router.js';
export {
  BOOTSTRAP_PEER_EXCHANGE_PROTOCOL_ID,
  registerBootstrapPeerExchangeHandler,
  requestBootstrapPeers,
} from './bootstrap-peer-exchange.js';
export {
  PROVIDER_DISCOVERY_PROTOCOL_ID,
  registerProviderDiscoveryHandler,
  requestProviderAnnouncement,
} from './provider-discovery.js';
export { PROTOCOL_ID } from './protocol.js';
export { StreamHandler, StreamWriter } from './stream-handler.js';
export { encodeMessage, decodeMessage, readMessages, writeBytes } from './protocol.js';

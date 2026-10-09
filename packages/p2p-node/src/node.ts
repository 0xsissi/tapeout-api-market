/**
 * libp2p node initialization for Tapeout API Market (TAM).
 * Creates a configured node with KadDHT, Noise, Yamux, TCP/WS transports.
 */

import { createLibp2p, type Libp2p } from 'libp2p';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { kadDHT } from '@libp2p/kad-dht';
import { bootstrap } from '@libp2p/bootstrap';
import { mdns } from '@libp2p/mdns';
import { autoNAT } from '@libp2p/autonat';
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2';
import type { CircuitRelayServerInit } from '@libp2p/circuit-relay-v2';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import type { PeerId, PrivateKey, Stream } from '@libp2p/interface';
import { DEFAULT_BOOTSTRAP_PEERS, DEFAULT_P2P_PORT } from '@clawmarket/shared';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { multiaddr } from '@multiformats/multiaddr';
import { readMessages, writeBytes, encodeMessage } from './protocol.js';

const DIRECT_PUBSUB_PROTOCOL_ID = '/clawmarket/direct-pubsub/1.0.0';

interface RelayCapableLibp2p extends Libp2p {
  components: {
    transportManager: {
      listen(addrs: ReturnType<typeof multiaddr>[]): Promise<void>;
    };
  };
}

export interface NodeConfig {
  privateKey?: PrivateKey;
  listenHost?: string;
  listenPort?: number;
  bootstrapPeers?: string[];
  announceAddresses?: string[];
  relayListenAddrs?: string[];
  enableRelay?: boolean; // Act as relay for other nodes
  relayServerOptions?: CircuitRelayServerInit;
  enableAutoNAT?: boolean; // Opt-in: AutoNAT may reuse and close active connections
}

export interface ClawMarketNode {
  libp2p: Libp2p;
  peerId: PeerId;
  start(): Promise<void>;
  stop(): Promise<void>;
  publish(topic: string, message: Uint8Array): Promise<void>;
  subscribe(topic: string, handler: (message: Uint8Array) => void): Promise<() => void>;
  reserveRelaySlots(): Promise<void>;
  getMultiaddrs(): string[];
}

interface PubsubMessage {
  topic: string;
  data: Uint8Array;
}

interface PubsubService {
  publish(topic: string, data: Uint8Array): Promise<unknown>;
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  addEventListener(type: 'message', listener: (event: CustomEvent<PubsubMessage>) => void): void;
  removeEventListener(type: 'message', listener: (event: CustomEvent<PubsubMessage>) => void): void;
}

interface Libp2pWithPubsub extends Libp2p {
  services: Libp2p['services'] & {
    pubsub?: PubsubService;
  };
}

interface DirectPubsubMessage {
  type: 'direct_pubsub_message';
  topic: string;
  dataBase64: string;
  timestamp: number;
}

export async function loadOrCreateNodeIdentity(identityPath?: string): Promise<PrivateKey> {
  if (!identityPath) {
    return await generateKeyPair('Ed25519');
  }

  try {
    const stored = await readFile(identityPath);
    return privateKeyFromProtobuf(new Uint8Array(stored));
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  const privateKey = await generateKeyPair('Ed25519');
  const serialised = privateKeyToProtobuf(privateKey);
  await mkdir(path.dirname(identityPath), { recursive: true });
  await writeFile(identityPath, Buffer.from(serialised));
  return privateKey;
}

export async function dialPeerAddress(libp2p: Libp2p, address: string): Promise<void> {
  await libp2p.dial(multiaddr(address));
  await ensurePubsubOutboundStreams(libp2p, 10);
}

/**
 * Create and configure a Tapeout API Market libp2p node.
 */
export async function createNode(config: NodeConfig): Promise<ClawMarketNode> {
  const privateKey = config.privateKey ?? await generateKeyPair('Ed25519');
  const host = config.listenHost ?? '0.0.0.0';
  const port = config.listenPort ?? DEFAULT_P2P_PORT;
  const bootstrapList = config.bootstrapPeers ?? DEFAULT_BOOTSTRAP_PEERS;
  const announce = config.announceAddresses?.length ? config.announceAddresses : undefined;
  const relayListenAddrs = config.relayListenAddrs?.length ? config.relayListenAddrs : [];
  const relayMultiaddrs = relayListenAddrs.map((addr) => multiaddr(addr));

  const peerDiscovery: any[] = [mdns()];
  if (bootstrapList.length > 0) {
    peerDiscovery.push(bootstrap({ list: bootstrapList }));
  }

  const services: Record<string, any> = {
    identify: identify(),
    ping: ping(),
    dht: kadDHT({ clientMode: false }),
    pubsub: gossipsub({
      allowPublishToZeroTopicPeers: true,
      // Quote publishers do not need to subscribe to their own model topics. Flood
      // connected pubsub peers so buyers receive fresh AIMM quotes before mesh
      // subscription gossip converges.
      floodPublish: true,
    }),
  };

  if (config.enableAutoNAT === true) {
    services.autoNAT = autoNAT();
  }

  if (config.enableRelay) {
    services.circuitRelay = circuitRelayServer(config.relayServerOptions);
  }

  const node = await createLibp2p({
    privateKey,
    // A congested relay can delay pings while inference is still progressing.
    // Request deadlines and transport closure handle failures without a probe
    // aborting every live stream on the connection.
    connectionMonitor: { abortConnectionOnPingFailure: false },
    addresses: {
      listen: [
        `/ip4/${host}/tcp/${port}`,
        `/ip4/${host}/tcp/${port + 1}/ws`,
      ],
      // Use appendAnnounce so explicit public addrs coexist with relay-observed addrs.
      appendAnnounce: announce,
    },
    transports: [
      tcp(),
      webSockets(),
      circuitRelayTransport(),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery,
    services,
  });

  const relayCapableNode = node as RelayCapableLibp2p;
  const pubsubNode = node as Libp2pWithPubsub;
  const directPubsubHandlers = new Map<string, Set<(message: Uint8Array) => void>>();
  let started = false;
  let relayReservationPromise: Promise<void> | null = null;

  node.handle(
    DIRECT_PUBSUB_PROTOCOL_ID,
    async (stream) => {
      try {
        for await (const rawMessage of readMessages(stream)) {
          const message = rawMessage as unknown as DirectPubsubMessage;
          if (message.type !== 'direct_pubsub_message') {
            continue;
          }
          const handlers = directPubsubHandlers.get(message.topic);
          if (!handlers?.size) {
            continue;
          }
          const payload = new Uint8Array(Buffer.from(message.dataBase64, 'base64'));
          for (const handler of handlers) {
            handler(payload);
          }
        }
      } finally {
        await stream.close().catch(() => {});
      }
    },
    { runOnLimitedConnection: true },
  );

  const cmNode: ClawMarketNode = {
    libp2p: node,
    peerId: node.peerId,

    async start() {
      await node.start();
      started = true;
      console.log(`[P2P] Node started: ${node.peerId.toString()}`);
      for (const ma of node.getMultiaddrs()) {
        console.log(`[P2P] Listening on: ${ma.toString()}`);
      }
    },

    async stop() {
      await node.stop();
      started = false;
      relayReservationPromise = null;
      console.log('[P2P] Node stopped');
    },

    async publish(topic, message) {
      const pubsub = pubsubNode.services.pubsub;
      if (!pubsub) {
        throw new Error('Pubsub service is not available on this node');
      }
      await ensurePubsubOutboundStreams(node);
      await Promise.allSettled([
        pubsub.publish(topic, message),
        publishDirectPubsub(node, topic, message),
      ]);
    },

    async subscribe(topic, handler) {
      const pubsub = pubsubNode.services.pubsub;
      if (!pubsub) {
        throw new Error('Pubsub service is not available on this node');
      }

      const listener = (event: CustomEvent<PubsubMessage>) => {
        if (event.detail.topic !== topic) {
          return;
        }
        handler(event.detail.data);
      };

      pubsub.subscribe(topic);
      const directHandlers = directPubsubHandlers.get(topic) ?? new Set<(message: Uint8Array) => void>();
      directHandlers.add(handler);
      directPubsubHandlers.set(topic, directHandlers);
      void ensurePubsubOutboundStreams(node);
      pubsub.addEventListener('message', listener);

      return async () => {
        pubsub.removeEventListener('message', listener);
        directHandlers.delete(handler);
        if (directHandlers.size === 0) {
          directPubsubHandlers.delete(topic);
        }
        pubsub.unsubscribe(topic);
      };
    },

    async reserveRelaySlots() {
      if (relayMultiaddrs.length === 0) {
        return;
      }
      if (!started) {
        throw new Error('Node must be started before reserving relay slots');
      }
      if (relayReservationPromise) {
        await relayReservationPromise;
        return;
      }

      // Only dedupe concurrent renewal attempts. A completed reservation must not
      // suppress future renewals, otherwise relay maintenance turns into a no-op
      // once the original reservation expires.
      const pendingReservation = relayCapableNode.components.transportManager.listen(relayMultiaddrs);
      relayReservationPromise = pendingReservation;
      try {
        await pendingReservation;
      } finally {
        if (relayReservationPromise === pendingReservation) {
          relayReservationPromise = null;
        }
      }
    },

    getMultiaddrs() {
      return node.getMultiaddrs().map((ma) => ma.toString());
    },
  };

  return cmNode;
}

async function publishDirectPubsub(libp2p: Libp2p, topic: string, message: Uint8Array): Promise<void> {
  const payload: DirectPubsubMessage = {
    type: 'direct_pubsub_message',
    topic,
    dataBase64: Buffer.from(message).toString('base64'),
    timestamp: Date.now(),
  };
  const encoded = encodeMessage(payload as any);
  const connections = libp2p.getConnections();

  const results = await Promise.allSettled(
    connections.map(async (connection) => {
      const opened = await connection.newStream(DIRECT_PUBSUB_PROTOCOL_ID, {
        runOnLimitedConnection: true,
      });
      const stream = (
        opened != null &&
        typeof opened === 'object' &&
        'stream' in opened &&
        opened.stream
      ) ? opened.stream as Stream : opened as Stream;
      try {
        await writeBytes(stream, encoded);
      } finally {
        await stream.close().catch(() => {});
      }
    }),
  );

  const fulfilledCount = results.filter((result) => result.status === 'fulfilled').length;
  if (connections.length > 0 && fulfilledCount === 0) {
    console.warn(`[P2P] direct pubsub publish to ${topic} reached 0/${connections.length} peers`);
  }
}

async function ensurePubsubOutboundStreams(libp2p: Libp2p, attempts = 3): Promise<void> {
  const pubsub = (libp2p.services as Record<string, any>).pubsub;
  if (typeof pubsub?.createOutboundStream !== 'function') {
    return;
  }

  // gossipsub creates protocol streams lazily after identify observes a peer.
  // This internal API keeps quote subscription gossip from missing the first
  // post-dial broadcast; review this when upgrading @chainsafe/libp2p-gossipsub.
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pubsubPeers = new Set(
      typeof pubsub.getPeers === 'function'
        ? pubsub.getPeers().map((peer: { toString(): string }) => peer.toString())
        : [],
    );
    const connections = libp2p
      .getConnections()
      .filter((connection) => pubsubPeers.has(connection.remotePeer.toString()));

    if (connections.length > 0 || attempt === attempts - 1) {
      await Promise.allSettled(
        connections.map((connection) =>
          pubsub.createOutboundStream(connection.remotePeer, connection),
        ),
      );
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

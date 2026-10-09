import {
  importDist,
  runBuild,
  parseBootstrapPeers,
  createAnnounceAddresses,
  createShareableBootstrapPeers,
  collectShareableConnectionPeers,
  isShareablePeerAddress,
  writeBootstrapManifest,
  startBootstrapMaintenance,
  waitForShutdown,
} from './lib/testnet-runtime.mjs';
import { startBootstrapStatusServer } from './lib/bootstrap-status-server.mjs';

const listenHost = process.env.P2P_LISTEN_HOST ?? '0.0.0.0';
const listenPort = Number(process.env.P2P_LISTEN_PORT ?? '9090');
const announceHost = process.env.ANNOUNCE_HOST ?? '';
const identityPath = process.env.P2P_IDENTITY_PATH ?? '';
const extraPeers = parseBootstrapPeers(process.env.BOOTSTRAP_EXTRA_PEERS ?? '');
const manifestOut = process.env.BOOTSTRAP_MANIFEST_OUT ?? '';
const manifestRefreshMs = Number(process.env.BOOTSTRAP_MANIFEST_REFRESH_MS ?? '30000');

async function main() {
  await runBuild();

  const p2pPkg = await importDist('packages/p2p-node/dist/index.js');
  const privateKey = await p2pPkg.loadOrCreateNodeIdentity(identityPath);
  const node = await p2pPkg.createNode({
    privateKey,
    listenHost,
    listenPort,
    announceAddresses: createAnnounceAddresses(announceHost, listenPort),
    enableRelay: true,
    relayServerOptions: {
      reservations: {
        maxReservations: Number(process.env.RELAY_MAX_RESERVATIONS ?? '32'),
        defaultDurationLimit: Number(process.env.RELAY_DURATION_LIMIT_MS ?? '600000'),
        defaultDataLimit: BigInt(process.env.RELAY_DATA_LIMIT_BYTES ?? '16777216'),
      },
      maxInboundHopStreams: 64,
      maxOutboundStopStreams: 64,
    },
    bootstrapPeers: [],
  });

  await node.start();

  console.log('');
  console.log('BOOTSTRAP NODE READY');
  console.log(`Peer ID:      ${node.peerId.toString()}`);
  console.log(`Listen host:  ${listenHost}`);
  console.log(`Listen port:  ${listenPort}`);
  if (identityPath) {
    console.log(`Identity:     ${identityPath}`);
  }

  const shareablePeers = createShareableBootstrapPeers(node.peerId.toString(), announceHost, listenPort);
  let currentManifestPeers = Array.from(
    new Set([...shareablePeers, ...extraPeers].filter(isShareablePeerAddress)),
  );

  p2pPkg.registerBootstrapPeerExchangeHandler(node.libp2p, () => currentManifestPeers);

  const persistManifest = async () => {
    const advertisedPeers = await collectAdvertisedConnectionPeers(node, p2pPkg);
    currentManifestPeers = Array.from(
      new Set([
        ...shareablePeers,
        ...extraPeers,
        ...(await collectShareableConnectionPeers(node)),
        ...advertisedPeers,
      ].filter(isShareablePeerAddress)),
    );
    const manifestPeers = currentManifestPeers;
    if (manifestOut && manifestPeers.length > 0) {
      await writeBootstrapManifest(manifestOut, manifestPeers, { role: 'bootstrap' });
    }
    return manifestPeers;
  };

  const manifestPeers = await persistManifest();
  const manifestTimer = setInterval(() => {
    persistManifest().catch((error) => {
      console.warn(
        `[bootstrap manifest] Failed to refresh manifest: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, manifestRefreshMs);
  if (shareablePeers.length > 0) {
    console.log('Share these bootstrap peers with buyers/providers:');
    for (const peer of shareablePeers) {
      console.log(peer);
    }
    if (extraPeers.length > 0) {
      console.log('Additional peers included in manifest:');
      for (const peer of extraPeers) {
        console.log(peer);
      }
    }
  } else {
    console.log('Set ANNOUNCE_HOST to your public IP or DNS name to generate shareable bootstrap peers.');
    console.log('Current local multiaddrs:');
    for (const addr of node.getMultiaddrs()) {
      console.log(addr);
    }
  }
  if (manifestOut && manifestPeers.length > 0) {
    console.log(`Bootstrap manifest: ${manifestOut}`);
  }

  let statusServer;
  if (process.env.BOOTSTRAP_STATUS_PORT) {
    try {
      statusServer = await startBootstrapStatusServer({
        host: process.env.BOOTSTRAP_STATUS_HOST ?? '127.0.0.1',
        port: Number(process.env.BOOTSTRAP_STATUS_PORT),
        getPeers: () => currentManifestPeers,
        getStatus: () => ({ peerId: node.peerId.toString(), connections: node.libp2p.getConnections().length, uptimeSeconds: Math.floor(process.uptime()) }),
      });
      console.log(`Bootstrap status port: ${statusServer.port}`);
    } catch (error) {
      clearInterval(manifestTimer);
      await node.stop();
      throw error;
    }
  }
  const maintenance = await startBootstrapMaintenance({
    node,
    staticPeers: extraPeers,
    peerCachePath: process.env.BOOTSTRAP_PEER_CACHE_PATH ?? '',
    refreshMs: Number(process.env.BOOTSTRAP_RECONNECT_MS ?? '30000'),
    dialPeer: peer => p2pPkg.dialPeerAddress(node.libp2p, peer),
    discoverPeers: peer => p2pPkg.requestBootstrapPeers(node.libp2p, peer.split('/p2p/').at(-1)),
    logLabel: 'bootstrap interconnect',
  });

  await waitForShutdown(async () => {
    clearInterval(manifestTimer);
    await maintenance.stop();
    await statusServer?.stop();
    await node.stop();
  });
}

async function collectAdvertisedConnectionPeers(node, p2pPkg) {
  const connections = node?.libp2p?.getConnections?.() ?? [];
  const discoveredPeers = [];

  for (const connection of connections) {
    const remotePeerId = connection?.remotePeer?.toString?.();
    if (!remotePeerId) {
      continue;
    }

    const advertisedPeers = await p2pPkg.requestBootstrapPeers(node.libp2p, remotePeerId);
    for (const peer of advertisedPeers) {
      if (isShareablePeerAddress(peer)) {
        discoveredPeers.push(peer);
      }
    }
  }

  return discoveredPeers;
}

main().catch((error) => {
  console.error('BOOTSTRAP NODE FAILED');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

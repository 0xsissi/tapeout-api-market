import path from 'node:path';
import { isIP } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, '..', '..');
export const DEFAULT_BOOTSTRAP_MANIFEST_URL = 'https://shenjige.xyz/api/bootstrap';
const bscTestnet = process.env.CLAWMARKET_PAYMENT_NETWORK === 'bsc-testnet';
const bem = process.env.CLAWMARKET_PAYMENT_TOKEN?.toUpperCase() === 'BEM';
if (process.env.CLAWMARKET_PAYMENT_NETWORK && !['default', 'bsc-testnet'].includes(process.env.CLAWMARKET_PAYMENT_NETWORK)) throw new Error('CLAWMARKET_PAYMENT_NETWORK must be default or bsc-testnet');
export const DEFAULT_RPC_URL = bscTestnet ? 'https://bsc-testnet-dataseed.bnbchain.org' : bem ? 'https://bsc-dataseed.binance.org/' : 'https://sepolia.base.org';
export const DEFAULT_CHAIN_ID = bscTestnet ? 97 : bem ? 56 : 84532;
export const DEFAULT_ESCROW_POOL_ADDRESS = bscTestnet ? (bem ? '0xfd95F0cA22D6c2Ca8dE3Bd42f88c6b94ABf6724e' : '0x90D30bA5d3e72A029335D2B879786ba912EA6e5F') : bem ? '0x0000000000000000000000000000000000000000' : '0x8A392a77eb88f477FeF060033937a2e4692Eb56E';

export async function importDist(relativePath) {
  const fullPath = path.join(repoRoot, relativePath);
  return import(`${pathToFileURL(fullPath).href}?t=${Date.now()}`);
}

export async function runBuild() {
  if (process.env.SKIP_PNPM_BUILD === '1') {
    return;
  }
  const filters = (process.env.CLAWMARKET_BUILD_FILTERS ?? [
    '@clawmarket/shared',
    '@clawmarket/crypto',
    '@clawmarket/p2p-node',
    '@clawmarket/consumer-gateway',
    '@clawmarket/provider-gateway',
    '@clawmarket/cli',
  ].join(','))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const filterArgs = filters.flatMap((filter) => ['--filter', filter]);
  await runCommand('corepack', ['pnpm', ...filterArgs, 'build']);
}

export async function runCommand(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
      ...options,
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

export function parseBootstrapPeers(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function parseModels(raw, fallbackModel = 'gpt-4o-mini') {
  if (!raw) {
    return [{
      model: fallbackModel,
      inputPer1m: 80,
      outputPer1m: 80,
    }];
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('MODELS_JSON must be a non-empty JSON array');
  }
  return parsed;
}

export function createAnnounceAddresses(host, port) {
  if (!host) return undefined;
  const protocol = toMultiaddrHostProtocol(host);
  return [
    `/${protocol}/${host}/tcp/${port}`,
    `/${protocol}/${host}/tcp/${port + 1}/ws`,
  ];
}

export function createShareableBootstrapPeers(peerId, host, port) {
  if (!host) return [];
  const protocol = toMultiaddrHostProtocol(host);
  return [
    `/${protocol}/${host}/tcp/${port}/p2p/${peerId}`,
    `/${protocol}/${host}/tcp/${port + 1}/ws/p2p/${peerId}`,
  ];
}

export function createProviderNodeAdapter(node) {
  const isStreamLike = (value) => value != null && (
    typeof value.send === 'function' ||
    typeof value.close === 'function' ||
    typeof value[Symbol.asyncIterator] === 'function'
  );
  return {
    peerId: node.peerId,
    async start() {
      await node.start();
    },
    async stop() {
      await node.stop();
    },
    async publish(topic, message) {
      if (typeof node.publish !== 'function') {
        throw new Error('Underlying node does not support pubsub publish');
      }
      return node.publish(topic, message);
    },
    async subscribe(topic, handler) {
      if (typeof node.subscribe !== 'function') {
        throw new Error('Underlying node does not support pubsub subscribe');
      }
      return node.subscribe(topic, handler);
    },
    handle(protocol, handler, options = {}) {
      node.libp2p.handle(protocol, (incoming, connection) => {
        const stream = isStreamLike(incoming) ? incoming : (incoming?.stream ?? incoming);
        const resolvedConnection = connection ?? incoming?.connection;
        const writer = createAsyncChunkQueue();
        let sinkPromise = null;
        const ensureSinkStarted = () => {
          if (sinkPromise == null) {
            sinkPromise = Promise.resolve(stream.sink(writer.iterate())).catch((error) => {
              if (writer.isEnded()) {
                return;
              }
              throw error;
            });
          }
          return sinkPromise;
        };
        const canUseNativeSend = typeof stream.send === 'function';
        const canUsePersistentSink = !canUseNativeSend && typeof stream.sink === 'function';
        const wrappedStream = {
          source: typeof stream[Symbol.asyncIterator] === 'function' ? undefined : (stream.source ?? stream),
          [Symbol.asyncIterator]: typeof stream[Symbol.asyncIterator] === 'function'
            ? stream[Symbol.asyncIterator].bind(stream)
            : undefined,
          get status() {
            return stream.status;
          },
          get writeStatus() {
            return stream.writeStatus;
          },
          get readStatus() {
            return stream.readStatus;
          },
          get remoteWriteStatus() {
            return stream.remoteWriteStatus;
          },
          get remoteReadStatus() {
            return stream.remoteReadStatus;
          },
          get timeline() {
            return stream.timeline;
          },
          get writableNeedsDrain() {
            return stream.writableNeedsDrain;
          },
          get writeBufferLength() {
            return stream.writeBufferLength;
          },
          get readBufferLength() {
            return stream.readBufferLength;
          },
          get inactivityTimeout() {
            return stream.inactivityTimeout;
          },
          get maxReadBufferLength() {
            return stream.maxReadBufferLength;
          },
          get maxWriteBufferLength() {
            return stream.maxWriteBufferLength;
          },
          addEventListener(type, listener, options) {
            if (typeof stream.addEventListener === 'function') {
              return stream.addEventListener(type, listener, options);
            }
          },
          send(data) {
            const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
            if (canUsePersistentSink) {
              ensureSinkStarted();
              writer.push(bytes);
              return true;
            }
            if (canUseNativeSend) {
              return stream.send(bytes);
            }
            return stream.send(bytes);
          },
          onDrain() {
            if (typeof stream.onDrain === 'function') {
              return stream.onDrain();
            }
            return Promise.resolve();
          },
          async sink(source) {
            for await (const chunk of source) {
              const bytes = chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk);
              if (canUsePersistentSink) {
                ensureSinkStarted();
                writer.push(bytes);
                continue;
              }
              const ok = stream.send(bytes);
              if (!ok && typeof stream.onDrain === 'function') {
                await stream.onDrain();
              }
            }
          },
          async close() {
            writer.end();
            if (canUsePersistentSink && sinkPromise != null) {
              await sinkPromise.catch(() => {});
            }
            return stream.close();
          },
        };

        let result;
        try {
          result = handler({ stream: wrappedStream, connection: resolvedConnection });
        } catch (error) {
          console.error(`[provider adapter] handler threw synchronously for ${protocol}:`, error);
          throw error;
        }

        return Promise.resolve(result)
          .finally(async () => {
            if (!writer.isEnded()) {
              writer.end();
            }
            if (canUsePersistentSink && sinkPromise != null) {
              await sinkPromise.catch(() => {});
            }
          });
      }, options);
    },
    getMultiaddrs() {
      return node.libp2p.getMultiaddrs();
    },
    contentRouting: {
      provide(key) {
        return node.libp2p.contentRouting.provide(key);
      },
    },
  };
}

function createAsyncChunkQueue() {
  const values = [];
  let ended = false;
  let resolveNext = null;

  return {
    push(value) {
      if (ended) {
        throw new Error('Chunk queue already ended');
      }
      if (resolveNext) {
        const next = resolveNext;
        resolveNext = null;
        next({ value, done: false });
        return;
      }
      values.push(value);
    },
    end() {
      if (ended) return;
      ended = true;
      if (resolveNext) {
        const next = resolveNext;
        resolveNext = null;
        next({ value: undefined, done: true });
      }
    },
    isEnded() {
      return ended;
    },
    async *iterate() {
      while (true) {
        if (values.length > 0) {
          yield values.shift();
          continue;
        }
        if (ended) {
          return;
        }
        const next = await new Promise((resolve) => {
          resolveNext = resolve;
        });
        if (next.done) {
          return;
        }
        yield next.value;
      }
    },
  };
}

export async function resolveBootstrapPeers(options = {}) {
  const staticPeers = dedupePeers(options.staticPeers ?? []);
  const manifestUrls = normaliseList(options.manifestUrls);
  const manifestFiles = normaliseList(options.manifestFiles);
  const cachePath = options.cachePath ?? '';
  const peerCachePath = options.peerCachePath ?? '';

  let loadedFromNetwork = false;
  const manifests = [];
  const errors = [];

  for (const source of manifestUrls) {
    try {
      const response = await fetch(source, { signal: AbortSignal.timeout(8000), redirect: 'error' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      manifests.push(parseBootstrapManifest(await response.text(), source));
      loadedFromNetwork = true;
    } catch (error) {
      errors.push(`[bootstrap] Failed to load manifest ${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const filePath of manifestFiles) {
    try {
      manifests.push(parseBootstrapManifest(await readFile(filePath, 'utf8'), filePath));
    } catch (error) {
      errors.push(`[bootstrap] Failed to read manifest file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (cachePath) {
    if (loadedFromNetwork && manifests.length > 0) {
      await persistBootstrapCache(cachePath, manifests);
    } else if (manifestUrls.length > 0) {
      try {
        manifests.push(parseBootstrapManifest(await readFile(cachePath, 'utf8'), cachePath));
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          errors.push(`[bootstrap] Failed to read bootstrap cache ${cachePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  let peerCachePeers = [];
  if (peerCachePath) {
    try {
      peerCachePeers = parseBootstrapManifest(await readFile(peerCachePath, 'utf8'), peerCachePath).peers;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        errors.push(`[bootstrap] Failed to read peer cache ${peerCachePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const manifestPeers = manifests.flatMap((manifest) => manifest.peers);
  return {
    peers: dedupePeers([...staticPeers, ...manifestPeers, ...peerCachePeers]),
    manifests,
    errors,
  };
}

export async function startBootstrapMaintenance(options) {
  const {
    node,
    dialPeer,
    discoverPeers,
    onPeerReachable,
    onPeerUnreachable,
    staticPeers = [],
    manifestUrls = [],
    manifestFiles = [],
    cachePath = '',
    peerCachePath = '',
    refreshMs = 60_000,
    operationTimeoutMs = 10_000,
    logLabel = 'bootstrap',
    waitForInitialRefresh = true,
  } = options;
  const localPeerId = node?.peerId?.toString?.() ?? '';

  let lastPeers = [];
  let rememberedPeers = [];
  let stopped = false;
  let inFlight = null;

  const refresh = async () => {
    const { peers, errors } = await resolveBootstrapPeers({
      staticPeers,
      manifestUrls,
      manifestFiles,
      cachePath,
      peerCachePath,
    });
    if (stopped) return;
    for (const error of errors) {
      console.warn(error);
    }

    const filteredPeers = peers.filter((peer) => peerIdFromAddress(peer) !== localPeerId);
    const changed = filteredPeers.join('|') !== lastPeers.join('|');
    lastPeers = filteredPeers;
    if (changed && filteredPeers.length > 0) {
      console.log(`[${logLabel}] Active bootstrap peers: ${filteredPeers.length}`);
    }

    const dialedPeers = [];
    const discoveredPeers = [];
    const queue = [...filteredPeers];
    const attemptedPeers = new Set();

    while (queue.length > 0 && !stopped) {
      const peer = queue.shift();
      if (!peer || attemptedPeers.has(peer)) {
        continue;
      }
      attemptedPeers.add(peer);

      let reachable = hasConnectionToPeer(node, peer);
      try {
        if (!reachable) {
          if (typeof dialPeer === 'function') {
            await withTimeout(dialPeer(peer), operationTimeoutMs, `${logLabel} dial ${peer}`);
          } else {
            await withTimeout(node.libp2p.dial(peer), operationTimeoutMs, `${logLabel} dial ${peer}`);
          }
        }
        reachable = true;
        if (stopped) return;
        dialedPeers.push(peer);
        if (typeof onPeerReachable === 'function') {
          await Promise.resolve(onPeerReachable(peer));
        }
      } catch (error) {
        if (stopped) return;
        reachable = hasConnectionToPeer(node, peer);
        if (!reachable) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes('Can not dial self')) {
            console.warn(`[${logLabel}] Dial failed for ${peer}: ${message}`);
          }
          if (typeof onPeerUnreachable === 'function') {
            await Promise.resolve(onPeerUnreachable(peer, message));
          }
          continue;
        }
        if (typeof onPeerReachable === 'function') {
          await Promise.resolve(onPeerReachable(peer));
        }
      }

      if (stopped) return;
      if (typeof discoverPeers === 'function') {
        const extraPeers = dedupePeers(
          await withTimeout(
            Promise.resolve(discoverPeers(peer)),
            operationTimeoutMs,
            `${logLabel} discover ${peer}`,
          ).catch(() => []),
        )
          .filter(isShareablePeerAddress)
          .filter((extraPeer) => peerIdFromAddress(extraPeer) !== localPeerId);
        if (stopped) return;
        for (const extraPeer of extraPeers) {
          if (attemptedPeers.has(extraPeer)) {
            continue;
          }
          discoveredPeers.push(extraPeer);
          queue.push(extraPeer);
        }
      }
    }

    if (stopped) return;
    const learnedPeers = await collectShareableConnectionPeers(node);
    if (stopped) return;
    const nextRememberedPeers = dedupePeers([
      ...rememberedPeers,
      ...dialedPeers,
      ...discoveredPeers,
      ...learnedPeers,
    ])
      .filter(isShareablePeerAddress)
      .filter((peer) => peerIdFromAddress(peer) !== localPeerId);

    if (peerCachePath && nextRememberedPeers.join('|') !== rememberedPeers.join('|')) {
      rememberedPeers = nextRememberedPeers;
      await persistBootstrapPeerCache(peerCachePath, rememberedPeers);
      if (rememberedPeers.length > 0) {
        console.log(`[${logLabel}] Remembered public peers: ${rememberedPeers.length}`);
      }
    }
  };

  const tick = () => {
    if (stopped || inFlight) return inFlight ?? Promise.resolve();
    inFlight = refresh().catch((error) => {
      if (!stopped) console.warn(`[${logLabel}] Bootstrap refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { inFlight = null; });
    return inFlight;
  };
  const initial = tick();
  if (waitForInitialRefresh) await initial;
  const timer = setInterval(() => {
    void tick();
  }, refreshMs);

  return {
    getPeers() {
      return [...lastPeers];
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export function startRelayReservationMaintenance(node, options = {}) {
  const intervalMs = Number(options.intervalMs ?? 15_000);
  const renewEveryMs = Number(options.renewEveryMs ?? Math.max(intervalMs, 45_000));
  const waitForReadyMs = Number(options.waitForReadyMs ?? 2_000);
  const logLabel = options.logLabel ?? '[seller relay]';

  let stopped = false;
  let inFlight = false;
  let wasReady = false;
  let lastErrorMessage = '';
  let lastReservationAttemptAt = 0;

  const tick = async () => {
    if (stopped || inFlight) {
      return;
    }

    const now = Date.now();
    const hasRelayAddress = hasRelayReservationAddress(node);
    const shouldRenew = !hasRelayAddress || (now - lastReservationAttemptAt >= renewEveryMs);

    if (!shouldRenew) {
      if (hasRelayAddress && !wasReady) {
        wasReady = true;
        console.log(`${logLabel} Relay reservation ready; this seller can be reached through /p2p-circuit`);
      }
      return;
    }

    inFlight = true;
    lastReservationAttemptAt = now;
    try {
      await node.reserveRelaySlots();
      const relayReady = await waitForRelayReservation(node, waitForReadyMs);
      if (relayReady) {
        if (!wasReady) {
          console.log(`${logLabel} Relay reservation ready; this seller can be reached through /p2p-circuit`);
        }
        wasReady = true;
        lastErrorMessage = '';
      } else {
        wasReady = false;
        console.warn(`${logLabel} Relay reservation completed but no /p2p-circuit address became visible yet`);
      }
    } catch (error) {
      wasReady = false;
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastErrorMessage) {
        console.warn(`${logLabel} Failed to reserve relay slot: ${message}`);
        lastErrorMessage = message;
      }
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function writeBootstrapManifest(outputPath, peers, meta = {}) {
  const payload = JSON.stringify({
    peers: dedupePeers(peers),
    updatedAt: new Date().toISOString(),
    ...meta,
  }, null, 2);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${payload}\n`, 'utf8');
}

export async function collectShareableConnectionPeers(node) {
  const connections = node?.libp2p?.getConnections?.() ?? [];
  const learnedPeers = [];
  const localPeerId = node?.peerId?.toString?.() ?? '';

  for (const connection of connections) {
    const peerId = connection?.remotePeer;
    const peerIdString = peerId?.toString?.() ?? '';
    if (!peerIdString || peerIdString === localPeerId) {
      continue;
    }
    if (peerId && node?.libp2p?.peerStore) {
      try {
        const peerInfo = typeof node.libp2p.peerStore.getInfo === 'function'
          ? await node.libp2p.peerStore.getInfo(peerId)
          : null;
        const peerInfoAddrs = peerInfo?.multiaddrs ?? [];
        for (const addr of peerInfoAddrs) {
          const value = normalisePeerAddress(
            typeof addr === 'string' ? addr : addr?.toString?.(),
            peerIdString,
          );
          if (isShareablePeerAddress(value)) {
            learnedPeers.push(value);
          }
        }

        if (peerInfoAddrs.length > 0) {
          continue;
        }

        const peer = typeof node.libp2p.peerStore.get === 'function'
          ? await node.libp2p.peerStore.get(peerId)
          : null;
        const peerAddrs = peer?.addresses ?? [];
        for (const addr of peerAddrs) {
          const value = normalisePeerAddress(addr?.multiaddr?.toString?.(), peerIdString);
          if (isShareablePeerAddress(value)) {
            learnedPeers.push(value);
          }
        }

        if (peerAddrs.length > 0) {
          continue;
        }
      } catch {
        // Skip connection-level fallbacks; remoteAddr often reflects transient
        // source ports rather than the peer's advertised listening addresses.
      }
    }
  }

  return dedupePeers(learnedPeers);
}

function hasRelayReservationAddress(node) {
  return node.getMultiaddrs().some((addr) => String(addr).includes('/p2p-circuit'));
}

async function waitForRelayReservation(node, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasRelayReservationAddress(node)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return hasRelayReservationAddress(node);
}

export function isShareablePeerAddress(peer) {
  if (!peer || typeof peer !== 'string') {
    return false;
  }

  const trimmed = peer.trim();
  if (!trimmed) {
    return false;
  }

  const dnsHost = extractMultiaddrSegment(trimmed, 'dns4') ?? extractMultiaddrSegment(trimmed, 'dns6');
  if (dnsHost) {
    return true;
  }

  const ipv4Host = extractMultiaddrSegment(trimmed, 'ip4');
  if (ipv4Host) {
    return isPublicIpv4(ipv4Host);
  }

  const ipv6Host = extractMultiaddrSegment(trimmed, 'ip6');
  if (ipv6Host) {
    return isPublicIpv6(ipv6Host);
  }

  return false;
}

export function hasConnectionToPeer(node, peerAddress) {
  const peerId = peerIdFromAddress(peerAddress);
  if (!peerId) {
    return false;
  }

  const connections = node?.libp2p?.getConnections?.() ?? [];
  return connections.some((connection) => connection?.remotePeer?.toString?.() === peerId);
}

export async function waitForShutdown(cleanup) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[runtime] Received ${signal}, shutting down...`);
    try {
      await cleanup();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((error) => {
      console.error(error);
      process.exit(1);
    });
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((error) => {
      console.error(error);
      process.exit(1);
    });
  });

  await new Promise(() => {});
}

function toMultiaddrHostProtocol(host) {
  const family = isIP(host);
  if (family === 4) return 'ip4';
  if (family === 6) return 'ip6';
  return 'dns4';
}

function withTimeout(promise, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      promise.finally(() => clearTimeout(timer)).catch(() => {});
    }),
  ]);
}

function peerIdFromAddress(peerAddress) {
  if (!peerAddress || typeof peerAddress !== 'string') {
    return null;
  }

  const marker = '/p2p/';
  const segments = peerAddress
    .split(marker)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  return segments[segments.length - 1] || null;
}

function normalisePeerAddress(peerAddress, peerId) {
  if (!peerAddress || typeof peerAddress !== 'string') {
    return peerAddress;
  }

  const trimmed = peerAddress.trim();
  if (!trimmed || trimmed.includes('/p2p/') || !peerId) {
    return trimmed;
  }

  return `${trimmed}/p2p/${peerId}`;
}

function normaliseList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).filter(Boolean);
  }
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBootstrapManifest(raw, source) {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return { source, peers: dedupePeers(parsed) };
  }
  if (Array.isArray(parsed.peers)) {
    return { source, peers: dedupePeers(parsed.peers) };
  }
  throw new Error(`Bootstrap manifest ${source} must be an array or { peers: [] }`);
}

async function persistBootstrapCache(cachePath, manifests) {
  await mkdir(path.dirname(cachePath), { recursive: true });
  const payload = JSON.stringify({
    peers: dedupePeers(manifests.flatMap((manifest) => manifest.peers)),
    updatedAt: new Date().toISOString(),
  }, null, 2);
  await writeFile(cachePath, `${payload}\n`, 'utf8');
}

async function persistBootstrapPeerCache(peerCachePath, peers) {
  await mkdir(path.dirname(peerCachePath), { recursive: true });
  const payload = JSON.stringify({
    peers: dedupePeers(peers).filter(isShareablePeerAddress),
    updatedAt: new Date().toISOString(),
  }, null, 2);
  await writeFile(peerCachePath, `${payload}\n`, 'utf8');
}

function extractMultiaddrSegment(value, protocol) {
  const marker = `/${protocol}/`;
  const start = value.indexOf(marker);
  if (start === -1) {
    return null;
  }
  const rest = value.slice(start + marker.length);
  const end = rest.indexOf('/');
  return end === -1 ? rest : rest.slice(0, end);
}

function isPublicIpv4(host) {
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIpv6(host) {
  const normalised = host.toLowerCase();
  if (normalised === '::' || normalised === '::1') {
    return false;
  }
  if (normalised.startsWith('fc') || normalised.startsWith('fd')) {
    return false;
  }
  if (normalised.startsWith('fe8') || normalised.startsWith('fe9') || normalised.startsWith('fea') || normalised.startsWith('feb')) {
    return false;
  }
  return true;
}

function dedupePeers(peers) {
  return Array.from(new Set(peers.map((peer) => String(peer).trim()).filter(Boolean)));
}

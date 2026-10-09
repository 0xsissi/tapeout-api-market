/**
 * Stream Handler — Request/response and streaming over libp2p streams.
 * Handles the /clawmarket/inference/1.0.0 protocol for both Provider and Consumer sides.
 */

import type { Libp2p } from 'libp2p';
import type { Stream, Connection } from '@libp2p/interface';
import type {
  ProtocolMessage,
  InferenceRequest,
  InferenceResponse,
  StreamChunkMessage,
  StreamEndMessage,
  AuthorizationRequiredMessage,
  SignedAuthorization,
} from '@clawmarket/shared';
import { PROTOCOL_ID, readMessages, encodeMessage, writeBytes } from './protocol.js';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import type { Multiaddr } from '@multiformats/multiaddr';

const STREAM_DEBUG = process.env.CLAWMARKET_STREAM_DEBUG === '1' || process.env.CLAWMARKET_STREAM_DEBUG === 'true';

export type InferenceHandler = (
  request: InferenceRequest,
  writer: StreamWriter
) => Promise<void>;

/**
 * Wraps a libp2p stream sink for writing protocol messages.
 */
export class StreamWriter {
  private stream: Stream;

  constructor(stream: Stream) {
    this.stream = stream;
  }

  /** Send a stream_start message */
  async sendStreamStart(requestId: string): Promise<void> {
    await this.write({
      type: 'stream_start',
      requestId,
      timestamp: Date.now(),
    });
  }

  /** Send a stream_chunk message (encrypted payload) */
  async sendStreamChunk(requestId: string, payload: string): Promise<void> {
    await this.write({
      type: 'stream_chunk',
      requestId,
      payload,
      timestamp: Date.now(),
    });
  }

  /** Send a stream_end message with final usage data */
  async sendStreamEnd(requestId: string, usage?: InferenceResponse['usage'], proof?: InferenceResponse['upstreamProof'], modelProvenanceProof?: InferenceResponse['modelProvenanceProof']): Promise<void> {
    const msg: StreamEndMessage = {
      type: 'stream_end',
      requestId,
      usage,
      upstreamProof: proof,
      modelProvenanceProof,
      timestamp: Date.now(),
    };
    await this.write(msg);
  }

  /** Send a complete (non-streaming) response */
  async sendResponse(requestId: string, payload: string, usage?: InferenceResponse['usage'], modelProvenanceProof?: InferenceResponse['modelProvenanceProof']): Promise<void> {
    const msg: InferenceResponse = {
      type: 'response',
      requestId,
      payload,
      usage,
      modelProvenanceProof,
      timestamp: Date.now(),
    };
    await this.write(msg);
  }

  /** Request an updated authorization from the buyer. */
  async sendAuthorizationRequired(
    requestId: string,
    amount: bigint,
    nonce: bigint,
    expiresAt: number,
  ): Promise<void> {
    const msg: AuthorizationRequiredMessage = {
      type: 'authorization_required',
      requestId,
      requiredAmount: amount,
      requiredNonce: nonce,
      expiresAt,
      timestamp: Date.now(),
    };
    await this.write(msg);
  }

  /** Send an error message */
  async sendError(requestId: string, error: string): Promise<void> {
    await this.write({
      type: 'error',
      requestId,
      error,
      timestamp: Date.now(),
    });
  }

  /** Close the stream */
  async close(): Promise<void> {
    await this.stream.close();
  }

  private async write(msg: ProtocolMessage): Promise<void> {
    const encoded = encodeMessage(msg);
    await writeBytes(this.stream, encoded);
  }
}

/**
 * Handles inference protocol interactions on both Provider and Consumer sides.
 */
export class StreamHandler {
  private libp2p: Libp2p;
  private handler: InferenceHandler | null = null;

  constructor(libp2p: Libp2p) {
    this.libp2p = libp2p;
  }

  /**
   * Register a handler for incoming inference requests (Provider side).
   */
  handleIncoming(handler: InferenceHandler): void {
    this.handler = handler;
    this.libp2p.handle(PROTOCOL_ID, async (stream: Stream, _connection: Connection) => {
      const writer = new StreamWriter(stream);
      try {
        // Read the first message — should be an InferenceRequest
        for await (const msg of readMessages(stream)) {
          if (msg.type === 'request') {
            await handler(msg as InferenceRequest, writer);
          }
          break; // Only process the first request per stream
        }
      } catch (err) {
        console.error('[StreamHandler] Error handling incoming stream:', err);
        await writer.sendError('unknown', (err as Error).message).catch(() => {});
      } finally {
        await writer.close().catch(() => {});
      }
    });

    console.log(`[StreamHandler] Registered handler for ${PROTOCOL_ID}`);
  }

  /**
   * Send an inference request to a provider (Consumer side).
   * Returns an async generator of response messages.
   */
  async *sendRequest(
    targetPeerId: string,
    request: InferenceRequest,
    options: {
      addresses?: string[];
      settle?: (message: ProtocolMessage) => Promise<SignedAuthorization>;
      timeoutMs?: number;
    } = {},
  ): AsyncGenerator<ProtocolMessage> {
    const peerId = peerIdFromString(targetPeerId);
    let stream: Stream | null = null;
    let connection: Connection | null = null;
    let stage = 'initializing';
    const dialErrors: string[] = [];
    const announcedMultiaddrs = normalizeDialAddresses(options.addresses);

    if (announcedMultiaddrs.length > 0) {
      stage = 'merging peerstore addresses';
      await this.libp2p.peerStore.merge(peerId, { multiaddrs: announcedMultiaddrs }).catch(() => {});
      debugLog(
        `[StreamHandler] Request ${request.requestId} merged ${announcedMultiaddrs.length} announced address(es) into peerstore`,
      );
    }

    for (const address of announcedMultiaddrs) {
      try {
        stage = `dial direct address ${address.toString()}`;
        connection = await this.libp2p.dial(address);
        attachConnectionDebugListeners(connection, `[Connection ${request.requestId}]`);
        instrumentConnectionControlCalls(connection, `[Connection ${request.requestId}]`);
        stage = `open stream on direct connection ${address.toString()}`;
        stream = await connection.newStream(PROTOCOL_ID, {
          runOnLimitedConnection: true,
        }) as Stream;
        attachStreamDebugListeners(stream, `[StreamHandler ${request.requestId}]`);
        instrumentStreamControlCalls(stream, `[StreamHandler ${request.requestId}]`);
        debugLog(
          `[StreamHandler] Request ${request.requestId} opened stream via direct dial ${address.toString()} | ${describeStreamState(stream)} | ${describeConnectionState(connection)}`,
        );
        break;
      } catch (error) {
        dialErrors.push(`${stage}: ${formatStreamError(error)}`);
        stream = null;
        connection = null;
      }
    }

    if (stream == null) {
      try {
        stage = `dialProtocol fallback for ${targetPeerId}`;
        stream = (await this.libp2p.dialProtocol(peerId, PROTOCOL_ID, {
          runOnLimitedConnection: true,
        })) as Stream;
        attachStreamDebugListeners(stream, `[StreamHandler ${request.requestId}]`);
        instrumentStreamControlCalls(stream, `[StreamHandler ${request.requestId}]`);
        debugLog(`[StreamHandler] Request ${request.requestId} opened stream via dialProtocol | ${describeStreamState(stream)}`);
      } catch (error) {
        throw wrapDialError(error, stage, dialErrors);
      }
    }

    let settlementTimer: ReturnType<typeof setTimeout> | undefined;
    const requestTimer = setTimeout(() => stream?.abort(new Error('Inference request timed out')), options.timeoutMs ?? 300_000);
    try {
      // Send the request
      stage = 'writing request payload';
      const encoded = encodeMessage(request);
      debugLog(`[StreamHandler] Request ${request.requestId} before write | ${describeStreamState(stream)}`);
      await writeBytes(stream, encoded);
      debugLog(`[StreamHandler] Request ${request.requestId} after write | ${describeStreamState(stream)}`);

      // Read responses (may be multiple for streaming)
      stage = 'reading provider responses';
      let awaitingSettlement = false;
      for await (const msg of readMessages(stream)) {
        if (msg.requestId !== request.requestId) throw new Error('Response request ID mismatch');
        if (awaitingSettlement) {
          if (msg.type !== 'settlement_ack') throw new Error('Provider did not acknowledge settlement');
          awaitingSettlement = false;
          break;
        }
        debugLog(`[StreamHandler] Request ${request.requestId} received ${msg.type} | ${describeStreamState(stream)}`);
        yield msg;

        if ((msg.type === 'response' || msg.type === 'stream_end') && options.settle) {
          settlementTimer = setTimeout(() => stream?.abort(new Error('Settlement acknowledgement timed out')), 15_000);
          const authorization = await options.settle(msg);
          await writeBytes(stream, encodeMessage({ type: 'authorization', requestId: request.requestId, authorization, timestamp: Date.now() } as ProtocolMessage));
          awaitingSettlement = true;
          continue;
        }

        // Stop reading after response or stream_end or error
        if (msg.type === 'response' || msg.type === 'stream_end' || msg.type === 'error') {
          break;
        }
      }
      if (awaitingSettlement) throw new Error('Provider closed before settlement acknowledgement');
    } catch (error) {
      console.error(
        `[StreamHandler] Request ${request.requestId} failed at ${stage}: ${formatStreamError(error)} | ${describeStreamState(stream)} | ${describeConnectionState(connection)}`,
      );
      throw error;
    } finally {
      clearTimeout(requestTimer);
      if (settlementTimer) clearTimeout(settlementTimer);
      debugLog(
        `[StreamHandler] Request ${request.requestId} closing stream | ${describeStreamState(stream)} | ${describeConnectionState(connection)}`,
      );
      await stream.close().catch(() => {});
    }
  }

  /**
   * Unregister the protocol handler.
   */
  unhandle(): void {
    this.libp2p.unhandle(PROTOCOL_ID);
    this.handler = null;
  }
}

function normalizeDialAddresses(addresses: string[] | undefined): Multiaddr[] {
  if (!Array.isArray(addresses)) {
    return [];
  }

  return sortDialAddresses(addresses)
    .map((address) => {
      try {
        return multiaddr(address);
      } catch {
        return null;
      }
    })
    .filter((address): address is Multiaddr => address != null);
}

function sortDialAddresses(addresses: string[]): string[] {
  return [...new Set(addresses.filter((address) => typeof address === 'string' && address.trim().length > 0))]
    .sort((left, right) => {
      const leftRelay = left.includes('/p2p-circuit');
      const rightRelay = right.includes('/p2p-circuit');
      if (leftRelay === rightRelay) {
        return 0;
      }
      return leftRelay ? 1 : -1;
    });
}

function wrapDialError(error: unknown, stage: string, priorErrors: string[] = []): Error {
  const message = error instanceof Error ? error.message : String(error);
  const context = priorErrors.length > 0 ? ` | prior attempts: ${priorErrors.join(' ; ')}` : '';
  return new Error(`${stage}: ${message}${context}`);
}

const debuggedStreams = new WeakSet<Stream>();
const instrumentedStreams = new WeakSet<Stream>();
const debuggedConnections = new WeakSet<Connection>();
const instrumentedConnections = new WeakSet<Connection>();

function attachStreamDebugListeners(stream: Stream, label: string): void {
  if (
    !STREAM_DEBUG ||
    debuggedStreams.has(stream) ||
    typeof (stream as Stream & { addEventListener?: unknown }).addEventListener !== 'function'
  ) {
    return;
  }

  debuggedStreams.add(stream);
  const eventTarget = stream as Stream & {
    addEventListener: (type: string, listener: (event?: unknown) => void, options?: unknown) => void;
    status?: unknown;
    timeline?: unknown;
    writableNeedsDrain?: unknown;
    writeBufferLength?: unknown;
    readBufferLength?: unknown;
    inactivityTimeout?: unknown;
    maxReadBufferLength?: unknown;
    maxWriteBufferLength?: unknown;
  };

  eventTarget.addEventListener('remoteCloseWrite', () => {
    debugWarn(`${label} remoteCloseWrite | ${describeStreamState(stream)}`);
  });
  eventTarget.addEventListener('drain', () => {
    debugLog(`${label} drain | ${describeStreamState(stream)}`);
  });
  eventTarget.addEventListener('close', (event?: unknown) => {
    debugWarn(`${label} close | ${describeCloseEvent(event)} | ${describeStreamState(stream)}`);
  });
}

function attachConnectionDebugListeners(connection: Connection, label: string): void {
  if (
    !STREAM_DEBUG ||
    debuggedConnections.has(connection) ||
    typeof (connection as Connection & { addEventListener?: unknown }).addEventListener !== 'function'
  ) {
    return;
  }

  debuggedConnections.add(connection);
  const eventTarget = connection as Connection & {
    addEventListener: (type: string, listener: (event?: unknown) => void, options?: unknown) => void;
  };

  eventTarget.addEventListener('remoteCloseWrite', () => {
    debugWarn(`${label} remoteCloseWrite | ${describeConnectionState(connection)}`);
  });
  eventTarget.addEventListener('idle', () => {
    debugLog(`${label} idle | ${describeConnectionState(connection)}`);
  });
  eventTarget.addEventListener('close', (event?: unknown) => {
    debugWarn(`${label} close | ${describeCloseEvent(event)} | ${describeConnectionState(connection)}`);
  });
}

function instrumentStreamControlCalls(stream: Stream, label: string): void {
  if (!STREAM_DEBUG || instrumentedStreams.has(stream)) {
    return;
  }

  instrumentedStreams.add(stream);
  const originalClose = stream.close.bind(stream);
  stream.close = (async (...args: Parameters<Stream['close']>) => {
    debugWarn(
      `${label} close() invoked at ${new Date().toISOString()} | ${describeStreamState(stream)} | stack=${captureCallerStack()}`,
    );
    return await originalClose(...args);
  }) as Stream['close'];

  const originalAbort = stream.abort.bind(stream);
  stream.abort = ((...args: Parameters<Stream['abort']>) => {
    debugWarn(
      `${label} abort() invoked at ${new Date().toISOString()} | ${describeStreamState(stream)} | error=${formatStreamError(args[0])} | stack=${captureCallerStack()}`,
    );
    return originalAbort(...args);
  }) as Stream['abort'];
}

function instrumentConnectionControlCalls(connection: Connection, label: string): void {
  if (!STREAM_DEBUG || instrumentedConnections.has(connection)) {
    return;
  }

  instrumentedConnections.add(connection);
  const originalClose = connection.close.bind(connection);
  connection.close = (async (...args: Parameters<Connection['close']>) => {
    debugWarn(
      `${label} close() invoked at ${new Date().toISOString()} | ${describeConnectionState(connection)} | stack=${captureCallerStack()}`,
    );
    return await originalClose(...args);
  }) as Connection['close'];

  const originalAbort = connection.abort.bind(connection);
  connection.abort = ((...args: Parameters<Connection['abort']>) => {
    debugWarn(
      `${label} abort() invoked at ${new Date().toISOString()} | ${describeConnectionState(connection)} | error=${formatStreamError(args[0])} | stack=${captureCallerStack()}`,
    );
    return originalAbort(...args);
  }) as Connection['abort'];
}

function describeStreamState(stream: Stream | null): string {
  if (stream == null) {
    return 'stream=null';
  }

  const candidate = stream as Stream & {
    status?: unknown;
    writeStatus?: unknown;
    readStatus?: unknown;
    remoteWriteStatus?: unknown;
    remoteReadStatus?: unknown;
    timeline?: unknown;
    writableNeedsDrain?: unknown;
    writeBufferLength?: unknown;
    readBufferLength?: unknown;
    inactivityTimeout?: unknown;
    maxReadBufferLength?: unknown;
    maxWriteBufferLength?: unknown;
  };

  return [
    `status=${String(candidate.status ?? 'n/a')}`,
    `writeStatus=${String(candidate.writeStatus ?? 'n/a')}`,
    `readStatus=${String(candidate.readStatus ?? 'n/a')}`,
    `remoteWriteStatus=${String(candidate.remoteWriteStatus ?? 'n/a')}`,
    `remoteReadStatus=${String(candidate.remoteReadStatus ?? 'n/a')}`,
    `writeBuffer=${String(candidate.writeBufferLength ?? 'n/a')}`,
    `readBuffer=${String(candidate.readBufferLength ?? 'n/a')}`,
    `needsDrain=${String(candidate.writableNeedsDrain ?? 'n/a')}`,
    `inactivityTimeout=${String(candidate.inactivityTimeout ?? 'n/a')}`,
    `maxReadBuffer=${String(candidate.maxReadBufferLength ?? 'n/a')}`,
    `maxWriteBuffer=${String(candidate.maxWriteBufferLength ?? 'n/a')}`,
    `timeline=${formatStreamValue(candidate.timeline)}`,
  ].join(' ');
}

function describeConnectionState(connection: Connection | null): string {
  if (connection == null) {
    return 'connection=null';
  }

  const limits = connection.limits == null
    ? 'n/a'
    : JSON.stringify({
        bytes: connection.limits.bytes?.toString(),
        seconds: connection.limits.seconds,
      });

  return [
    `connectionId=${connection.id}`,
    `connectionStatus=${String(connection.status ?? 'n/a')}`,
    `connectionDirection=${String(connection.direction ?? 'n/a')}`,
    `connectionDirect=${String(connection.direct ?? 'n/a')}`,
    `connectionRemote=${connection.remoteAddr?.toString?.() ?? 'n/a'}`,
    `connectionStreams=${String(connection.streams?.length ?? 'n/a')}`,
    `connectionMultiplexer=${String(connection.multiplexer ?? 'n/a')}`,
    `connectionEncryption=${String(connection.encryption ?? 'n/a')}`,
    `connectionRtt=${String(connection.rtt ?? 'n/a')}`,
    `connectionLimits=${limits}`,
    `connectionTimeline=${formatStreamValue(connection.timeline)}`,
  ].join(' ');
}

function describeCloseEvent(event: unknown): string {
  if (event == null || typeof event !== 'object') {
    return 'event=none';
  }

  const candidate = event as {
    error?: unknown;
    detail?: { error?: unknown; local?: unknown };
    local?: unknown;
    type?: unknown;
  };
  const error = candidate.error ?? candidate.detail?.error;
  const local = candidate.local ?? candidate.detail?.local;
  const type = candidate.type;
  return `type=${String(type ?? 'unknown')} local=${String(local ?? 'n/a')} error=${formatStreamError(error)}`;
}

function formatStreamValue(value: unknown): string {
  if (value == null) {
    return 'n/a';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function formatStreamError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function captureCallerStack(): string {
  const stack = new Error().stack;
  if (stack == null) {
    return 'n/a';
  }

  return stack
    .split('\n')
    .slice(2, 8)
    .map((line) => line.trim())
    .join(' <- ');
}

function debugLog(message: string): void {
  if (STREAM_DEBUG) {
    console.log(message);
  }
}

function debugWarn(message: string): void {
  if (STREAM_DEBUG) {
    console.warn(message);
  }
}

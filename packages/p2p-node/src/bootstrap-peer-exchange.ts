import { randomUUID } from 'node:crypto';

import type { Libp2p } from 'libp2p';
import type { Connection, Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';

import { encodeMessage, readMessage, writeBytes } from './protocol.js';

export const BOOTSTRAP_PEER_EXCHANGE_PROTOCOL_ID = '/clawmarket/bootstrap-peers/1.0.0';

interface BootstrapPeerExchangeRequest {
  type: 'bootstrap_peers_request';
  requestId: string;
  timestamp: number;
}

interface BootstrapPeerExchangeResponse {
  type: 'bootstrap_peers_response';
  requestId: string;
  timestamp: number;
  peers: string[];
}

type BootstrapPeerExchangeMessage =
  | BootstrapPeerExchangeRequest
  | BootstrapPeerExchangeResponse;

export function registerBootstrapPeerExchangeHandler(
  libp2p: Libp2p,
  getPeers: () => string[],
): void {
  libp2p.handle(
    BOOTSTRAP_PEER_EXCHANGE_PROTOCOL_ID,
    async (stream: Stream, _connection: Connection) => {
      try {
        const message = (await readMessage(stream)) as unknown as BootstrapPeerExchangeMessage;
        if (message.type !== 'bootstrap_peers_request') {
          return;
        }

        const response: BootstrapPeerExchangeResponse = {
          type: 'bootstrap_peers_response',
          requestId: message.requestId,
          timestamp: Date.now(),
          peers: getPeers(),
        };

        await writeBytes(stream, encodeMessage(response as any));
      } finally {
        await stream.close().catch(() => {});
      }
    },
    { runOnLimitedConnection: true },
  );
}

export async function requestBootstrapPeers(
  libp2p: Libp2p,
  targetPeerId: string,
): Promise<string[]> {
  let stream: Stream | null = null;

  try {
    stream = (await libp2p.dialProtocol(
      peerIdFromString(targetPeerId),
      BOOTSTRAP_PEER_EXCHANGE_PROTOCOL_ID,
      { runOnLimitedConnection: true },
    )) as Stream;

    const request: BootstrapPeerExchangeRequest = {
      type: 'bootstrap_peers_request',
      requestId: randomUUID(),
      timestamp: Date.now(),
    };
    await writeBytes(stream, encodeMessage(request as any));

    const response = (await readMessage(stream)) as unknown as BootstrapPeerExchangeMessage;
    if (response.type !== 'bootstrap_peers_response' || !Array.isArray(response.peers)) {
      return [];
    }

    return response.peers;
  } catch {
    return [];
  } finally {
    await stream?.close().catch(() => {});
  }
}

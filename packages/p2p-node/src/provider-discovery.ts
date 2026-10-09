import { randomUUID } from 'node:crypto';

import type { Libp2p } from 'libp2p';
import type { Stream, Connection } from '@libp2p/interface';
import type { ProviderAnnouncement } from '@clawmarket/shared';
import { peerIdFromString } from '@libp2p/peer-id';

import { encodeMessage, readMessage, writeBytes } from './protocol.js';

export const PROVIDER_DISCOVERY_PROTOCOL_ID = '/clawmarket/provider-discovery/1.0.0';

interface ProviderDiscoveryRequest {
  type: 'provider_announcement_request';
  requestId: string;
  timestamp: number;
}

interface ProviderDiscoveryResponse {
  type: 'provider_announcement_response';
  requestId: string;
  timestamp: number;
  announcement?: ProviderAnnouncement;
}

type ProviderDiscoveryMessage = ProviderDiscoveryRequest | ProviderDiscoveryResponse;

export function registerProviderDiscoveryHandler(
  libp2p: Libp2p,
  getAnnouncement: () => ProviderAnnouncement | null,
): void {
  libp2p.handle(
    PROVIDER_DISCOVERY_PROTOCOL_ID,
    async (stream: Stream, _connection: Connection) => {
      try {
        const message = (await readMessage(stream)) as unknown as ProviderDiscoveryMessage;
        if (message.type !== 'provider_announcement_request') {
          return;
        }

        const response: ProviderDiscoveryResponse = {
          type: 'provider_announcement_response',
          requestId: message.requestId,
          timestamp: Date.now(),
        };
        const announcement = getAnnouncement();
        if (announcement) {
          response.announcement = announcement;
        }

        await writeBytes(stream, encodeMessage(response as any));
      } finally {
        await stream.close().catch(() => {});
      }
    },
    { runOnLimitedConnection: true },
  );
}

export async function requestProviderAnnouncement(
  libp2p: Libp2p,
  targetPeerId: string,
): Promise<ProviderAnnouncement | null> {
  let stream: Stream | null = null;

  try {
    stream = (await libp2p.dialProtocol(
      peerIdFromString(targetPeerId),
      PROVIDER_DISCOVERY_PROTOCOL_ID,
      { runOnLimitedConnection: true },
    )) as Stream;

    const request: ProviderDiscoveryRequest = {
      type: 'provider_announcement_request',
      requestId: randomUUID(),
      timestamp: Date.now(),
    };
    await writeBytes(stream, encodeMessage(request as any));

    const response = (await readMessage(stream)) as unknown as ProviderDiscoveryMessage;
    if (response.type !== 'provider_announcement_response' || !response.announcement) {
      return null;
    }

    return response.announcement;
  } catch {
    return null;
  } finally {
    await stream?.close().catch(() => {});
  }
}

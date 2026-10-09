import { describe, expect, it, vi } from 'vitest';

vi.mock('@libp2p/peer-id', () => ({
  peerIdFromString: vi.fn((value: string) => ({
    toString: () => value,
  })),
}));

import { encodeMessage, PROTOCOL_ID } from './protocol.js';
import { StreamHandler } from './stream-handler.js';
import type { InferenceRequest } from '@clawmarket/shared';

describe('StreamHandler connection lifecycle', () => {
  it('sends final authorization after the terminal delivery and waits for acknowledgement', async () => {
    const request = makeRequest();
    const stream = createFakeStream([
      encodeMessage({ type: 'stream_end', requestId: request.requestId, timestamp: Date.now() }),
      encodeMessage({ type: 'settlement_ack', requestId: request.requestId, timestamp: Date.now() }),
    ]);
    const handler = new StreamHandler({ dialProtocol: vi.fn(async () => stream) } as any);
    let delivered = false;
    const settle = vi.fn(async () => { expect(delivered).toBe(true); return request.authorization; });
    for await (const message of handler.sendRequest('test-peer', request, { settle })) {
      expect(message.type).toBe('stream_end'); delivered = true;
    }
    expect(settle).toHaveBeenCalledOnce();
    expect(stream.send).toHaveBeenCalledTimes(2);
    expect(stream.close).toHaveBeenCalledOnce();
  });

  it('rejects closure before acknowledgement', async () => {
    const request = makeRequest();
    const stream = createFakeStream([encodeMessage({ type: 'stream_end', requestId: request.requestId, timestamp: Date.now() })]);
    const handler = new StreamHandler({ dialProtocol: vi.fn(async () => stream) } as any);
    const run = async () => { for await (const _ of handler.sendRequest('test-peer', request, { settle: async () => request.authorization })) { /* receive */ } };
    await expect(run()).rejects.toThrow('acknowledgement');
  });

  it('closes only the request stream after a terminal response, not the underlying connection', async () => {
    const stream = createFakeStream([
      encodeMessage({
        type: 'response',
        requestId: 'req-connection-lifecycle',
        payload: 'encrypted-response',
        timestamp: Date.now(),
      }),
    ]);
    const connection = {
      id: 'conn-1',
      status: 'open',
      direction: 'outbound',
      direct: true,
      remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/19190' },
      streams: [stream],
      close: vi.fn(async () => {}),
      abort: vi.fn(),
      newStream: vi.fn(async (protocol: string, options: unknown) => {
        expect(protocol).toBe(PROTOCOL_ID);
        expect(options).toMatchObject({ runOnLimitedConnection: true });
        return stream;
      }),
    };
    const libp2p = {
      peerStore: {
        merge: vi.fn(async () => {}),
      },
      dial: vi.fn(async () => connection),
      dialProtocol: vi.fn(),
    };
    const handler = new StreamHandler(libp2p as any);

    const messages = [];
    for await (const message of handler.sendRequest(
      'peer-provider',
      makeRequest(),
      { addresses: ['/ip4/127.0.0.1/tcp/19190'] },
    )) {
      messages.push(message);
    }

    expect(messages.map((message) => message.type)).toEqual(['response']);
    expect(stream.send).toHaveBeenCalledOnce();
    expect(stream.close).toHaveBeenCalledOnce();
    expect(connection.close).not.toHaveBeenCalled();
    expect(connection.abort).not.toHaveBeenCalled();
    expect(libp2p.dialProtocol).not.toHaveBeenCalled();
  });
});

function makeRequest(): InferenceRequest {
  return {
    type: 'request',
    requestId: 'req-connection-lifecycle',
    buyerAddress: '0x00000000000000000000000000000000000000bb',
    buyerPublicKey: 'buyer-public-key',
    model: 'gpt-5.4',
    payload: 'encrypted-request',
    authorization: {
      buyer: '0x00000000000000000000000000000000000000bb',
      seller: '0x00000000000000000000000000000000000000cc',
      amount: 1n,
      nonce: 1n,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      poolId: '0x0000000000000000000000000000000000000000000000000000000000000001',
      signature: '0xauth',
    },
    timestamp: Date.now(),
  };
}

function createFakeStream(chunks: Uint8Array[]) {
  return {
    status: 'open',
    writeStatus: 'writable',
    readStatus: 'readable',
    remoteWriteStatus: 'writable',
    remoteReadStatus: 'readable',
    send: vi.fn(() => true),
    onDrain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    abort: vi.fn(),
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

import { describe, expect, it, vi } from 'vitest';

import {
  decodeMessage,
  encodeMessage,
  encodeMessages,
  readMessage,
  readMessages,
  writeBytes,
  writeMessage,
} from './protocol.js';

describe('protocol', () => {
  const message = {
    type: 'authorization_required' as const,
    requestId: 'req-1',
    requiredAmount: 42n,
    requiredNonce: 7n,
    expiresAt: 999,
    timestamp: 123,
  };

  it('encodes and decodes messages with bigint fields', () => {
    const encoded = encodeMessage(message as any);
    const decoded = decodeMessage(encoded);

    expect(decoded?.message).toEqual(message);
    expect(decoded?.bytesRead).toBe(encoded.length);
  });

  it('returns null for incomplete buffers', () => {
    const encoded = encodeMessage(message as any);

    expect(decodeMessage(encoded.slice(0, 2))).toBeNull();
    expect(decodeMessage(encoded.slice(0, encoded.length - 1))).toBeNull();
  });

  it('reads a single message from chunked stream data', async () => {
    const encoded = encodeMessage(message as any);
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield encoded.slice(0, 3);
        yield encoded.slice(3);
      },
    };

    await expect(readMessage(stream as any)).resolves.toEqual(message);
  });

  it('reads multiple messages from a stream', async () => {
    const messages = [
      message,
      { ...message, requestId: 'req-2', requiredAmount: 99n, requiredNonce: 8n, expiresAt: 1001 },
    ];
    const encoded = encodeMessages(messages as any);
    const stream = {
      async *[Symbol.asyncIterator]() {
        const combined = new Uint8Array(encoded[0].length + encoded[1].length);
        combined.set(encoded[0]);
        combined.set(encoded[1], encoded[0].length);
        yield combined;
      },
    };

    const received: any[] = [];
    for await (const msg of readMessages(stream as any)) {
      received.push(msg);
    }

    expect(received).toEqual(messages);
  });

  it('waits for drain when the stream applies backpressure', async () => {
    const onDrain = vi.fn().mockResolvedValue(undefined);
    const stream = {
      send: vi.fn().mockReturnValue(false),
      onDrain,
    };

    await writeBytes(stream as any, new Uint8Array([1, 2, 3]));

    expect(stream.send).toHaveBeenCalledOnce();
    expect(onDrain).toHaveBeenCalledOnce();
  });

  it('writes encoded messages through the stream', async () => {
    const stream = {
      send: vi.fn().mockReturnValue(true),
      onDrain: vi.fn(),
    };

    await writeMessage(stream as any, message as any);

    expect(stream.send).toHaveBeenCalledOnce();
    expect(Array.from(stream.send.mock.calls[0][0])).toEqual(
      Array.from(encodeMessage(message as any)),
    );
  });
});

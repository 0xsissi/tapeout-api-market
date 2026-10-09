/**
 * Custom libp2p protocol definition for Tapeout API Market inference requests.
 *
 * Uses length-prefixed JSON (4-byte big-endian length + JSON payload)
 * over libp2p streams for message serialization/deserialization.
 */

import type { Stream } from '@libp2p/interface';
import { PROTOCOL_ID, type ProtocolMessage } from '@clawmarket/shared';

export { PROTOCOL_ID };

/**
 * Custom replacer for JSON.stringify that handles bigint serialization.
 * Bigints are encoded as strings with a `__bigint__:` prefix.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return `__bigint__:${value.toString()}`;
  }
  return value;
}

/**
 * Custom reviver for JSON.parse that handles bigint deserialization.
 */
function jsonReviver(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith('__bigint__:')) {
    return BigInt(value.slice('__bigint__:'.length));
  }
  return value;
}

/**
 * Encode a ProtocolMessage into a length-prefixed buffer.
 * Format: [4-byte big-endian length][JSON payload]
 */
export function encodeMessage(msg: ProtocolMessage): Uint8Array {
  const json = JSON.stringify(msg, jsonReplacer);
  const payload = new TextEncoder().encode(json);
  const buf = new Uint8Array(4 + payload.length);
  const view = new DataView(buf.buffer);
  view.setUint32(0, payload.length, false); // big-endian
  buf.set(payload, 4);
  return buf;
}

/**
 * Decode a single ProtocolMessage from a length-prefixed buffer.
 * Returns the decoded message and the number of bytes consumed.
 * Returns null if the buffer does not contain a complete message.
 */
export function decodeMessage(buf: Uint8Array): { message: ProtocolMessage; bytesRead: number } | null {
  if (buf.length < 4) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const length = view.getUint32(0, false);
  if (length === 0 || length > 2_097_152) throw new Error('Protocol frame exceeds size limit');
  if (buf.length < 4 + length) return null;
  const json = new TextDecoder().decode(buf.slice(4, 4 + length));
  const message = JSON.parse(json, jsonReviver) as ProtocolMessage;
  return { message, bytesRead: 4 + length };
}

/** Convert any stream chunk (Uint8Array or Uint8ArrayList) to Uint8Array. */
function chunkToBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  // Uint8ArrayList exposes .subarray() returning a Uint8Array copy.
  const anyChunk = chunk as { subarray?: () => Uint8Array };
  if (typeof anyChunk.subarray === 'function') return anyChunk.subarray();
  throw new Error('Unknown stream chunk type');
}

/**
 * Read exactly one length-prefixed ProtocolMessage from a libp2p stream.
 */
export async function readMessage(stream: Stream): Promise<ProtocolMessage> {
  let buffer = new Uint8Array(0);

  for await (const chunk of stream as AsyncIterable<unknown>) {
    const data = chunkToBytes(chunk);
    const combined = new Uint8Array(buffer.length + data.length);
    combined.set(buffer);
    combined.set(data, buffer.length);
    buffer = combined;

    const result = decodeMessage(buffer);
    if (result) {
      return result.message;
    }
  }

  throw new Error('Stream ended before a complete message was received');
}

/**
 * Read all messages from a libp2p stream until it closes.
 * Yields each decoded ProtocolMessage as it arrives.
 */
export async function* readMessages(stream: Stream): AsyncGenerator<ProtocolMessage> {
  let buffer = new Uint8Array(0);

  for await (const chunk of stream as AsyncIterable<unknown>) {
    const data = chunkToBytes(chunk);
    const combined = new Uint8Array(buffer.length + data.length);
    combined.set(buffer);
    combined.set(data, buffer.length);
    buffer = combined;

    let result = decodeMessage(buffer);
    while (result) {
      yield result.message;
      buffer = buffer.slice(result.bytesRead);
      result = decodeMessage(buffer);
    }
  }
}

/**
 * Write bytes to a libp2p v3 stream, respecting backpressure.
 */
export async function writeBytes(stream: Stream, data: Uint8Array): Promise<void> {
  const ok = stream.send(data);
  if (!ok) {
    await stream.onDrain();
  }
}

/**
 * Write a ProtocolMessage to a libp2p stream.
 */
export async function writeMessage(stream: Stream, msg: ProtocolMessage): Promise<void> {
  const encoded = encodeMessage(msg);
  await writeBytes(stream, encoded);
}

/**
 * Write a ProtocolMessage to a stream sink without closing it.
 * Uses the pushable pattern — caller must manage the sink lifecycle.
 */
export function encodeMessages(messages: ProtocolMessage[]): Uint8Array[] {
  return messages.map(encodeMessage);
}

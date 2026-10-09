import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestChat, requestChatStream, executePurchase, executeWithdrawRequest } from './buyer.js';
import { PAYMENT_TOKEN, CONTRACTS } from '@clawmarket/shared';

const originalFetch = globalThis.fetch;

describe('buyer services', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('preserves exact decimal strings for deposits and withdrawals and rejects unsupported precision', async () => {
    globalThis.fetch = vi.fn(async (url) => String(url).endsWith('/v1/credits') ? gatewayResponse() : new Response('{"depositTx":"0xmock","tx":"0xmock"}', { status: 200 }));
    const amount = PAYMENT_TOKEN.decimals === 8 ? '90000000.12345678' : '90000000.123456';
    await executePurchase('http://127.0.0.1:18080', amount);
    await executeWithdrawRequest('http://127.0.0.1:18080', amount);
    for (const call of (globalThis.fetch as any).mock.calls.filter((call: any[]) => call[1]?.method === 'POST')) expect(JSON.parse(call[1].body).amountToken).toBe(amount);
    await expect(executePurchase('http://127.0.0.1:18080', '0.' + '0'.repeat(PAYMENT_TOKEN.decimals) + '1')).rejects.toThrow();
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });

  it('parses streaming chat responses and emits deltas', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encodeSse({
          id: 'chat-1',
          object: 'chat.completion.chunk',
          created: 123,
          model: 'gpt-5.4-mini',
          choices: [{ index: 0, delta: { content: 'hel' }, finish_reason: null }],
        }));
        controller.enqueue(encodeSse({
          id: 'chat-1',
          object: 'chat.completion.chunk',
          created: 123,
          model: 'gpt-5.4-mini',
          choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }],
        }));
        controller.enqueue(encodeSse({
          id: 'chat-1',
          object: 'chat.completion.chunk',
          created: 123,
          model: 'gpt-5.4-mini',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValueOnce(gatewayResponse()).mockResolvedValue(new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    const deltas: string[] = [];
    const response = await requestChatStream({
      url: 'http://127.0.0.1:18080',
      model: 'gpt-5.4-mini',
      promptText: 'hello',
    }, {
      onDelta(delta) {
        deltas.push(delta);
      },
    });

    expect(deltas).toEqual(['hel', 'lo']);
    expect(response.choices?.[0]?.message?.content).toBe('hello');
    expect(response.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  });

  it('throws on streaming error payloads', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encodeSse({
          error: { message: 'provider unavailable', type: 'upstream_error' },
        }));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValueOnce(gatewayResponse()).mockResolvedValue(new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    await expect(requestChatStream({
      url: 'http://127.0.0.1:18080',
      model: 'gpt-5.4-mini',
      promptText: 'hello',
    })).rejects.toThrow('provider unavailable');
  });

  it('extracts text from structured streaming payloads', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encodeSse({
          id: 'chat-2',
          object: 'chat.completion.chunk',
          created: 456,
          model: 'gpt-5.4-mini',
          choices: [{
            index: 0,
            delta: {
              content: [
                { type: 'output_text', text: 'struc' },
                { type: 'output_text', text: 'tured' },
              ],
            },
            finish_reason: null,
          }],
        }));
        controller.enqueue(encodeSse({
          id: 'chat-2',
          object: 'chat.completion.chunk',
          created: 456,
          model: 'gpt-5.4-mini',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValueOnce(gatewayResponse()).mockResolvedValue(new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    const response = await requestChatStream({
      url: 'http://127.0.0.1:18080',
      model: 'gpt-5.4-mini',
      promptText: 'hello',
    });

    expect(response.choices?.[0]?.message?.content).toBe('structured');
  });

  it('sends the previous turns and configured response limit to the gateway', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(gatewayResponse()).mockResolvedValue(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    const messages = [{ role: 'user' as const, content: 'remember blue' }, { role: 'assistant' as const, content: 'okay' }, { role: 'user' as const, content: 'what color?' }];
    await requestChatStream({ url: 'http://127.0.0.1:18080', model: 'test-model', messages, maxTokens: 4096 });
    const sent = JSON.parse((globalThis.fetch as any).mock.calls[1][1].body);
    expect(sent.messages).toEqual(messages); expect(sent.max_tokens).toBe(4096);
  });
  it('does not report an interrupted stream as a complete answer', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(gatewayResponse()).mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    await expect(requestChatStream({ url: 'http://127.0.0.1:18080', model: 'test-model', promptText: 'hello' })).rejects.toThrow('中断');
  });

  it.each([requestChat, requestChatStream])('shows useful guidance when no seller is available', async request => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(gatewayResponse()).mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: 'service_unavailable', code: 'no_provider', message: 'No provider available for model test-model' } }), { status: 503 }));
    await expect(request({ url: 'http://127.0.0.1:18080', model: 'test-model', promptText: 'hello' })).rejects.toThrow('当前没有可用卖家提供 test-model');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('distinguishes a disconnected buyer from an unreachable seller', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));
    await expect(requestChatStream({ url: 'http://127.0.0.1:18080', model: 'test-model', promptText: 'hello' })).rejects.toThrow('买家服务尚未连接');
    globalThis.fetch = vi.fn().mockResolvedValueOnce(gatewayResponse()).mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: 'upstream_error', code: 'transport_unreachable', message: 'Provider request failed for model test-model' } }), { status: 502 }));
    await expect(requestChatStream({ url: 'http://127.0.0.1:18080', model: 'test-model', promptText: 'hello' })).rejects.toThrow('已发现卖家，但暂时无法连接');
  });

  it('preserves budget errors and uncertain settlement warnings instead of suggesting a connection retry', async () => {
    for (const type of ['budget_exceeded', 'settlement_uncertain']) {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(gatewayResponse()).mockResolvedValueOnce(new Response(JSON.stringify({ error: { type, message: type } }), { status: 422 }));
      await expect(requestChatStream({ url: 'http://127.0.0.1:18080', model: 'test-model', promptText: 'hello' })).rejects.toThrow(type);
    }
  });

  it('does not suggest blindly resending when the connection fails after submitting a request', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(gatewayResponse()).mockRejectedValueOnce(new Error('fetch failed'));
    await expect(requestChatStream({ url: 'http://127.0.0.1:18080', model: 'test-model', promptText: 'hello' })).rejects.toThrow('请先核对调用结果和余额');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('handles a structured seller connection error inside an SSE response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(gatewayResponse()).mockResolvedValueOnce(new Response('data: ' + JSON.stringify({ error: { type: 'upstream_error', code: 'transport_unreachable', message: 'connection failed' } }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    await expect(requestChatStream({ url: 'http://127.0.0.1:18080', model: 'test-model', promptText: 'hello' })).rejects.toThrow('已发现卖家，但暂时无法连接');
  });
});

function encodeSse(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function gatewayResponse(): Response {
  return new Response(JSON.stringify({ paymentToken: PAYMENT_TOKEN, escrowPool: process.env.ESCROW_POOL_ADDRESS ?? CONTRACTS.ESCROW_POOL }));
}

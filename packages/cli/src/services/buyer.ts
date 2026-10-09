import type {
  BuyerNetworkStatus,
  BuyerWalletSummary,
  ChatOptions,
  ChatResponse,
  PurchaseCreditsResponse,
  WithdrawResponse,
} from '../types.js';
import { parsePaymentAmount } from '@clawmarket/shared';
import { normalizeUrl } from '../utils.js';
import { CLI_VERSION } from '../version.js';
import { extractErrorMessage, fetchJson, fetchWithTimeout, postJson, safeJsonParse, parseResponse, HttpResponseError } from './http.js';
import { friendlyChatError } from './chat-error.js';
import { assertGatewaySettlement, checkGatewaySettlement } from '../payment/gateway.js';

const CHAT_TIMEOUT_MS = 180_000;

export interface ChatStreamHandlers {
  onDelta?: (delta: string) => void;
}

export async function loadBuyerSummary(
  url: string,
): Promise<[health: { status: string; address: string; port: number }, wallet: BuyerWalletSummary]> {
  const baseUrl = normalizeUrl(url);
  const result = await Promise.all([
    fetchJson<{ status: string; address: string; port: number }>(`${baseUrl}/health`),
    fetchJson<BuyerWalletSummary>(`${baseUrl}/v1/credits`),
  ]);
  assertGatewaySettlement(result[1]);
  return result;
}

export async function loadBuyerNetworkStatus(url: string): Promise<BuyerNetworkStatus> {
  const status = await fetchJson<BuyerNetworkStatus>(`${normalizeUrl(url)}/v1/network/status`);
  assertGatewaySettlement(status);
  return { ...status, source: 'buyer' };
}

export async function executePurchase(url: string, amountUsd: number | string): Promise<PurchaseCreditsResponse> {
  if (parsePaymentAmount(amountUsd) <= 0n) {
    throw new Error('Amount must be a positive number.');
  }

  await checkGatewaySettlement(url, 'buyer');
  return await postJson<PurchaseCreditsResponse>(`${normalizeUrl(url)}/v1/credits/purchase`, {
    amountToken: amountUsd,
  }, {
    timeoutMs: 180_000,
  });
}

export async function executeWithdrawRequest(url: string, amountUsd: number | string): Promise<WithdrawResponse> {
  if (parsePaymentAmount(amountUsd) <= 0n) {
    throw new Error('Amount must be a positive number.');
  }

  await checkGatewaySettlement(url, 'buyer');
  return await postJson<WithdrawResponse>(`${normalizeUrl(url)}/v1/escrow/withdraw/request`, {
    amountToken: amountUsd,
  });
}

export async function executeWithdrawCancel(url: string): Promise<WithdrawResponse> {
  await checkGatewaySettlement(url, 'buyer');
  return await postJson<WithdrawResponse>(`${normalizeUrl(url)}/v1/escrow/withdraw/cancel`, {});
}

export async function executeWithdrawComplete(url: string): Promise<WithdrawResponse> {
  await checkGatewaySettlement(url, 'buyer');
  return await postJson<WithdrawResponse>(`${normalizeUrl(url)}/v1/escrow/withdraw/complete`, {});
}

export async function requestChat(options: ChatOptions): Promise<ChatResponse> {
  try { return await requestChatOnce(options); }
  catch (error) { throw friendlyChatError(error, options.model); }
}

async function requestChatOnce(options: ChatOptions): Promise<ChatResponse> {
  const messages = chatMessages(options);

  try { await checkGatewaySettlement(options.url, 'buyer'); }
  catch (error) { throw friendlyChatError(error, options.model, true); }
  const response = await postJson<ChatResponse>(
    `${normalizeUrl(options.url)}/v1/chat/completions`,
    buildChatBody(options.model, messages, false, options.maxTokens),
    {
      timeoutMs: CHAT_TIMEOUT_MS,
      headers: {
        'X-Claw-Client-Version': CLI_VERSION,
      },
    },
  );

  if (response.error?.message) {
    throw new HttpResponseError(response.error.message, 502, response.error);
  }

  return response;
}

export async function requestChatStream(
  options: ChatOptions,
  handlers: ChatStreamHandlers = {},
): Promise<ChatResponse> {
  try { return await requestChatStreamOnce(options, handlers); }
  catch (error) { throw friendlyChatError(error, options.model); }
}

async function requestChatStreamOnce(options: ChatOptions, handlers: ChatStreamHandlers): Promise<ChatResponse> {
  const messages = chatMessages(options);

  try { await checkGatewaySettlement(options.url, 'buyer'); }
  catch (error) { throw friendlyChatError(error, options.model, true); }
  const url = `${normalizeUrl(options.url)}/v1/chat/completions`;
  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        'X-Claw-Client-Version': CLI_VERSION,
      },
      body: JSON.stringify(buildChatBody(options.model, messages, true, options.maxTokens)),
      signal: options.signal,
    },
    CHAT_TIMEOUT_MS,
  );

  if (!response.ok) {
    await parseResponse(response);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Streaming response body is unavailable.');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let completed = false;
  let finalResponse: ChatResponse = {
    id: '',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: options.model,
    choices: [{ index: 0, finish_reason: null, message: { role: 'assistant', content: '' } }],
  };
  const apply = (event: string) => {
    if (event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n') === '[DONE]') completed = true;
    applyStreamEvent(event, finalResponse, handlers, delta => { content += delta; });
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      apply(rawEvent);
      boundary = buffer.indexOf('\n\n');
    }
    if (done) {
      break;
    }
  }

  if (buffer.trim().length > 0) {
    apply(buffer);
  }

  if (finalResponse.error?.message) {
    throw new HttpResponseError(finalResponse.error.message, 502, finalResponse.error);
  }
  if (!completed) throw new Error('回答连接在完成前中断，请核对结果和余额后再决定是否重新发送。');

  finalResponse = {
    ...finalResponse,
    choices: [{
      index: 0,
      finish_reason: finalResponse.choices?.[0]?.finish_reason ?? 'stop',
      message: {
        role: 'assistant',
        content,
      },
    }],
  };

  return finalResponse;
}

function chatMessages(options: ChatOptions) {
  const messages = options.messages ?? [{ role: 'user' as const, content: options.promptText?.trim() ?? '' }];
  if (!messages.length || messages.some(message => !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || !message.content.trim()) || messages.at(-1)?.role !== 'user') throw new Error('Prompt cannot be empty; a conversation must end with a user message.');
  return messages;
}
function buildChatBody(model: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>, stream: boolean, maxTokens?: number) {
  return {
    model,
    stream,
    messages,
    ...(maxTokens == null ? {} : { max_tokens: maxTokens }),
  };
}

function applyStreamEvent(
  rawEvent: string,
  response: ChatResponse,
  handlers: ChatStreamHandlers,
  onDelta: (delta: string) => void,
): void {
  const data = rawEvent
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim();

  if (!data || data === '[DONE]') {
    return;
  }

  const payload = safeJsonParse(data);
  if (!payload || typeof payload !== 'object') {
    return;
  }

  const record = payload as Record<string, unknown>;
  if (record.error && typeof record.error === 'object') {
    const message = extractErrorMessage(payload) ?? 'Unknown streaming error';
    response.error = {
      message,
      type: typeof (record.error as Record<string, unknown>).type === 'string'
        ? (record.error as Record<string, unknown>).type as string
        : 'upstream_error',
      code: typeof (record.error as Record<string, unknown>).code === 'string' ? (record.error as { code: string }).code : undefined,
    };
    return;
  }

  if (typeof record.id === 'string') {
    response.id = record.id;
  }
  if (typeof record.object === 'string') {
    response.object = record.object;
  }
  if (typeof record.created === 'number') {
    response.created = record.created;
  }
  if (typeof record.model === 'string') {
    response.model = record.model;
  }
  if ('usage' in record && record.usage && typeof record.usage === 'object') {
    response.usage = record.usage as ChatResponse['usage'];
  }
  if ('upstreamProof' in record) {
    response.upstreamProof = record.upstreamProof;
  }

  const choices = Array.isArray(record.choices) ? record.choices : [];
  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== 'object') {
    return;
  }
  const choiceRecord = firstChoice as Record<string, unknown>;
  const deltaRecord = choiceRecord.delta && typeof choiceRecord.delta === 'object'
    ? choiceRecord.delta as Record<string, unknown>
    : null;
  const messageRecord = choiceRecord.message && typeof choiceRecord.message === 'object'
    ? choiceRecord.message as Record<string, unknown>
    : null;
  const deltaText = extractTextContent(deltaRecord?.content)
    ?? extractTextContent(deltaRecord?.text)
    ?? extractTextContent(messageRecord?.content)
    ?? extractTextContent(record.output_text);
  if (deltaText) {
    onDelta(deltaText);
    handlers.onDelta?.(deltaText);
  }
  if ('finish_reason' in choiceRecord) {
    const finishReason = choiceRecord.finish_reason;
    response.choices = [{
      index: typeof choiceRecord.index === 'number' ? choiceRecord.index : 0,
      finish_reason: typeof finishReason === 'string' || finishReason === null ? finishReason : null,
      message: {
        role: 'assistant',
        content: null,
      },
    }];
  }
}

function extractTextContent(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.length > 0 ? value : null;
  }
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => extractTextContent(item))
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
      .join('');
    return joined.length > 0 ? joined : null;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  return extractTextContent(record.text)
    ?? extractTextContent(record.content)
    ?? extractTextContent(record.value)
    ?? extractTextContent(record.output_text);
}

import type { ChatCompletionRequest, ModelPricing, SignedInferenceIntent, TokenUsage } from './types/index.js';
import { PAYMENT_TOKEN, parsePaymentAmount, paymentPriceUnits, type PaymentToken } from './payment-token.js';

const MILLION = 1_000_000n;
export const MAX_REQUEST_BYTES = 1_048_576;
export const MAX_OUTPUT_TOKENS = 32_768;
// Account proxies add system instructions and protocol envelopes beyond caller messages.
export const DEFAULT_INPUT_OVERHEAD_TOKENS = 512;

export function validateChatRequest(body: ChatCompletionRequest): void {
  if (!body || typeof body.model !== 'string' || !body.model.trim() || body.model.length > 200 ||
      !Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 256 ||
      body.messages.some(m => !m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) {
    throw new Error('Invalid model or messages');
  }
  if (body.max_tokens != null && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > MAX_OUTPUT_TOKENS)) {
    throw new Error(`max_tokens must be between 1 and ${MAX_OUTPUT_TOKENS}`);
  }
}

/** Conservative budget; settlement still uses reported actual token counts. */
export function inputTokenBudget(body: ChatCompletionRequest, overheadTokens = DEFAULT_INPUT_OVERHEAD_TOKENS): number {
  if (!Number.isSafeInteger(overheadTokens) || overheadTokens < 0 || overheadTokens > 8192) throw new Error('inputOverheadTokens must be an integer between 0 and 8192');
  return new TextEncoder().encode(JSON.stringify(body.messages)).length + 32 * body.messages.length + overheadTokens;
}

export function priceToMicro(price: number, token: PaymentToken = PAYMENT_TOKEN): bigint {
  if (!Number.isFinite(price) || price < 0 || price > 1_000_000) throw new Error('Invalid token price');
  return paymentPriceUnits(price, token);
}

export function lockedPrices(pricing: ModelPricing, quotePrice?: number, token: PaymentToken = PAYMENT_TOKEN): { inputPrice: bigint; outputPrice: bigint } {
  const inputPrice = priceToMicro(pricing.inputPer1m, token), outputPrice = priceToMicro(pricing.outputPer1m, token);
  const target = quotePrice ?? pricing.p0;
  if (target == null) return { inputPrice, outputPrice };
  const base = inputPrice + outputPrice, quoted = priceToMicro(target, token) * 2n;
  if (base === 0n) { if (quoted === 0n) return { inputPrice, outputPrice }; throw new Error('Cannot scale a zero base price'); }
  // A dynamic scalar scales both advertised rates; never collapse their input/output ratio.
  const scale = (price: bigint) => (price * quoted + base - 1n) / base;
  return { inputPrice: scale(inputPrice), outputPrice: scale(outputPrice) };
}

export function tokenCost(inputTokens: number, outputTokens: number, inputPrice: bigint, outputPrice: bigint, token: PaymentToken = PAYMENT_TOKEN): bigint {
  if (![inputTokens, outputTokens].every(n => Number.isSafeInteger(n) && n >= 0) || inputPrice < 0n || outputPrice < 0n) throw new Error('Invalid usage or pricing');
  const cost = (BigInt(inputTokens) * inputPrice + BigInt(outputTokens) * outputPrice + MILLION - 1n) / MILLION;
  const minimum = parsePaymentAmount(token.minimumAmount, token);
  return cost < minimum ? minimum : cost;
}

export function settlementAmount(intent: SignedInferenceIntent, usage?: TokenUsage, token: PaymentToken = PAYMENT_TOKEN): bigint {
  if (!usage || !Number.isSafeInteger(usage.total_tokens) || usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens ||
      usage.prompt_tokens > intent.maxInputTokens || usage.completion_tokens > intent.maxOutputTokens) throw new Error('Missing or out-of-budget usage');
  const amount = tokenCost(usage.prompt_tokens, usage.completion_tokens, intent.inputPrice, intent.outputPrice, token);
  if (amount > intent.amount) throw new Error('Settlement exceeds signed budget');
  return amount;
}

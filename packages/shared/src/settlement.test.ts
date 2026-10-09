import { describe, expect, it } from 'vitest';
import { settlementAmount, tokenCost, validateChatRequest, inputTokenBudget } from './settlement.js';
import type { SignedInferenceIntent } from './types/index.js';

describe('bounded usage settlement', () => {
  const intent = { amount: 500_000n, inputPrice: 100_000_000n, outputPrice: 200_000_000n, maxInputTokens: 500, maxOutputTokens: 1000 } as SignedInferenceIntent;
  it('rounds upward using integer arithmetic and preserves the disclosed minimum fee', () => {
    expect(tokenCost(1, 1, 1n, 1n)).toBe(10_000n);
    expect(tokenCost(123, 7, 123_456_789n, 1n)).toBe(15_186n);
  });
  it('charges actual usage rather than the maximum authorized budget', () => {
    expect(settlementAmount(intent, { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 })).toBe(20_000n);
  });
  it.each([undefined, { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 }, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 99 },
    { prompt_tokens: 501, completion_tokens: 0, total_tokens: 501 }, { prompt_tokens: 0, completion_tokens: 1001, total_tokens: 1001 }])('rejects invalid or excessive usage: %j', usage => {
    expect(() => settlementAmount(intent, usage)).toThrow();
  });
  it('rejects unbounded output requests', () => {
    expect(() => validateChatRequest({ model: 'x', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1e9 })).toThrow('max_tokens');
  });
  it('budgets proxy overhead but charges only the reported input, and keeps the chosen bound strict', () => {
    const request = { model: 'proxy', messages: [{ role: 'user' as const, content: 'hi' }], max_tokens: 16 };
    const maximumInput = inputTokenBudget(request);
    const bounded = { inputPrice: 1_000_000_000n, outputPrice: 1_000_000_000n, maxInputTokens: maximumInput, maxOutputTokens: 16, amount: tokenCost(maximumInput, 16, 1_000_000_000n, 1_000_000_000n) } as SignedInferenceIntent;
    const usage = { prompt_tokens: 315, completion_tokens: 9, total_tokens: 324 };
    expect(settlementAmount(bounded, usage)).toBe(324_000n);
    expect(settlementAmount(bounded, usage)).toBeLessThan(bounded.amount);
    expect(() => settlementAmount({ ...bounded, maxInputTokens: inputTokenBudget(request, 0) }, usage)).toThrow('out-of-budget');
    expect(() => settlementAmount(bounded, { prompt_tokens: maximumInput + 1, completion_tokens: 0, total_tokens: maximumInput + 1 })).toThrow('out-of-budget');
  });
  it.each([-1, 1.5, 8193, Number.NaN])('rejects unsafe overhead settings: %s', value => {
    expect(() => inputTokenBudget({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }, value)).toThrow('inputOverheadTokens');
  });
});

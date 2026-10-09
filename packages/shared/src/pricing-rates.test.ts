import { expect, it } from 'vitest';
import { lockedPrices, settlementAmount, tokenCost } from './settlement.js';
import { BSC_TESTNET_USDC_PAYMENT_TOKEN as token } from './payment-token.js';
import type { SignedInferenceIntent } from './types/index.js';

it('charges p0=5 correctly with a fresh quote or the no-quote path despite stale 60/60 advertisement fields', () => {
  const pricing = { model: 'sol', inputPer1m: 60, outputPer1m: 60, p0: 5, alpha: 1 };
  for (const quote of [5, undefined]) {
    const rates = lockedPrices(pricing, quote, token);
    expect(rates).toEqual({ inputPrice: 5_000_000n, outputPrice: 5_000_000n });
    expect(tokenCost(100, 100, rates.inputPrice, rates.outputPrice, token)).toBe(1000n);
  }
  expect(lockedPrices(pricing, 10, token)).toEqual({ inputPrice: 10_000_000n, outputPrice: 10_000_000n });
});

it('preserves the published input/output ratio as load changes', () => {
  expect(lockedPrices({ model: 'luna', inputPer1m: 0.02, outputPer1m: 0.1, p0: 0.06 }, 0.12, token)).toEqual({ inputPrice: 40_000n, outputPrice: 200_000n });
});

it('does not reprice an already signed intent when seller settings change', () => {
  const intent = { amount: 100_000n, inputPrice: 60_000_000n, outputPrice: 60_000_000n, maxInputTokens: 100, maxOutputTokens: 100 } as SignedInferenceIntent;
  expect(settlementAmount(intent, { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 }, token)).toBe(12_000n);
});

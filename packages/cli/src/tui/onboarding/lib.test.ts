import { describe, expect, it } from 'vitest';

import { buildOnboardingStepIds, shouldRunOnboarding } from './lib.js';

describe('onboarding step builder', () => {
  it('builds buyer-only steps with the role selector', () => {
    expect(buildOnboardingStepIds('buyer', true)).toEqual([
      'role',
      'buyer_wallet',
      'buyer_start',
      'buyer_fund',
      'buyer_model',
      'buyer_purchase',
      'complete',
    ]);
  });

  it('builds seller-only steps without the role selector when forced', () => {
    expect(buildOnboardingStepIds('seller', false)).toEqual([
      'seller_wallet',
      'seller_upstream',
      'seller_login_method',
      'seller_login',
      'seller_models',
      'seller_input_price',
      'seller_output_price',
      'seller_max_concurrent',
      'seller_gas_check',
      'seller_start',
      'complete',
    ]);
  });

  it('requires onboarding when completedAt is missing', () => {
    expect(
      shouldRunOnboarding({
        onboarding: { completedAt: null, role: null },
      } as any),
    ).toBe(true);
    expect(
      shouldRunOnboarding({
        onboarding: { completedAt: '2026-04-21T00:00:00.000Z', role: 'buyer' },
      } as any),
    ).toBe(false);
  });
});

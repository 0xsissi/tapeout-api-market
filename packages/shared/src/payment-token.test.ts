import { afterEach, describe, expect, it, vi } from 'vitest';
import { BEM_PAYMENT_TOKEN as bem, USDC_PAYMENT_TOKEN as usdc, formatPaymentAmount, parsePaymentAmount, paymentPriceUnits, resolvePaymentToken, paymentExplorerUrl, paymentFundingLinks } from './payment-token.js';
import { lockedPrices, settlementAmount, tokenCost } from './settlement.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('BEM-denominated settlement', () => {
  it('preserves all 8 decimals and never rounds deposit input', () => {
    expect(parsePaymentAmount('12.34567891', bem)).toBe(1234567891n);
    expect(parsePaymentAmount(0.00000001, bem)).toBe(1n);
    expect(formatPaymentAmount(1234567891n, bem)).toBe('12.34567891');
    expect(() => parsePaymentAmount('0.000000001', bem)).toThrow('decimal places');
    expect(() => parsePaymentAmount(0.000000001, bem)).toThrow('decimal places');
  });
  it('rounds fractional base-unit quotes up without floating-point overcharges', () => {
    expect(paymentPriceUnits(1.1, bem)).toBe(110000000n);
    expect(paymentPriceUnits(0.000000011, bem)).toBe(2n);
    expect(paymentPriceUnits(1.00000001, bem)).toBe(100000001n);
  });
  it('keeps the 1M usage denominator independent of 8-decimal currency', () => {
    const prices = lockedPrices({ model: 'test', inputPer1m: 1000, outputPer1m: 2000 }, undefined, bem);
    const maximum = tokenCost(1000, 2000, prices.inputPrice, prices.outputPrice, bem);
    expect(maximum).toBe(500000000n); // 5 BEM
    const intent = { amount: maximum, maxInputTokens: 1000, maxOutputTokens: 2000, ...prices } as any;
    expect(settlementAmount(intent, { prompt_tokens: 500, completion_tokens: 1000, total_tokens: 1500 }, bem)).toBe(250000000n);
    expect(() => settlementAmount(intent, { prompt_tokens: 500, completion_tokens: 2001, total_tokens: 2501 }, bem)).toThrow('out-of-budget');
  });
  it('retains the existing USDC precision and uses a token-denominated minimum', () => {
    expect(tokenCost(0, 0, 0n, 0n, bem)).toBe(1000000n); // 0.01 BEM, not USD
    expect(tokenCost(0, 0, 0n, 0n, usdc)).toBe(10000n);
    expect(() => resolvePaymentToken('DOGE')).toThrow('must be');
  });
  it('requires BEM limits and rejects announcements from another currency or pool', async () => {
    vi.stubEnv('CLAWMARKET_PAYMENT_TOKEN', 'BEM');
    vi.stubEnv('ESCROW_POOL_ADDRESS', '0x1111111111111111111111111111111111111111');
    vi.resetModules();
    const module = await import('./payment-token.js');
    expect(() => module.requirePaymentLimit(undefined, 0.1, 'maximum')).toThrow('BEM units');
    expect(module.matchesPaymentNetwork({})).toBe(false);
    expect(module.matchesPaymentNetwork({ paymentToken: usdc })).toBe(false);
    expect(module.matchesPaymentNetwork({ paymentToken: bem, settlementPool: '0x2222222222222222222222222222222222222222' })).toBe(false);
    expect(module.matchesPaymentNetwork({ paymentToken: bem, settlementPool: process.env.ESCROW_POOL_ADDRESS })).toBe(true);
  });
  it('rejects another explicit USDC pool, including legacy announcements without currency metadata', async () => {
    vi.stubEnv('CLAWMARKET_PAYMENT_TOKEN', 'USDC');
    vi.stubEnv('ESCROW_POOL_ADDRESS', '0x1111111111111111111111111111111111111111'); vi.resetModules();
    const module = await import('./payment-token.js');
    expect(module.matchesPaymentNetwork({ paymentToken: usdc, settlementPool: '0x2222222222222222222222222222222222222222' })).toBe(false);
    expect(module.matchesPaymentNetwork({ paymentToken: usdc, settlementPool: 123 as any })).toBe(false);
    expect(module.matchesPaymentNetwork({ settlementPool: '0x2222222222222222222222222222222222222222' })).toBe(false);
    expect(module.matchesPaymentNetwork({})).toBe(true);
    expect(module.matchesPaymentNetwork({ paymentToken: usdc, settlementPool: process.env.ESCROW_POOL_ADDRESS })).toBe(true);
  });
});

describe('explicit BSC testnet settlement', () => {
  it('selects explorers and funding guidance by chain and rejects unknown chains', () => {
    expect(paymentExplorerUrl(97)).toBe('https://testnet.bscscan.com');
    expect(paymentExplorerUrl(56)).toBe('https://bscscan.com');
    expect(paymentExplorerUrl(84532)).toBe('https://sepolia.basescan.org');
    expect(paymentFundingLinks(97)).toEqual(['https://shenjige.xyz/#faucet', 'https://www.bnbchain.org/en/testnet-faucet']);
    expect(paymentFundingLinks(56)).toEqual([]);
    expect(() => paymentExplorerUrl(1)).toThrow('chain 1');
    expect(() => paymentFundingLinks(1)).toThrow('chain 1');
  });
  it('preserves the original networks unless the owner selects bsc-testnet', () => {
    expect(resolvePaymentToken('USDC').chainId).toBe(84532);
    expect(resolvePaymentToken('BEM').chainId).toBe(56);
    const testUsdc = resolvePaymentToken('USDC', 'bsc-testnet'), testBem = resolvePaymentToken('BEM', 'bsc-testnet');
    expect(testUsdc.chainId).toBe(97); expect(testBem.chainId).toBe(97);
    expect(testUsdc.address).not.toBe(usdc.address); expect(testBem.address).not.toBe(bem.address);
    expect(parsePaymentAmount('0.000001', testUsdc)).toBe(1n);
    expect(() => parsePaymentAmount('0.0000001', testUsdc)).toThrow('decimal places');
    expect(parsePaymentAmount('0.00000001', testBem)).toBe(1n);
    expect(() => resolvePaymentToken('USDC', 'mainnet' as any)).toThrow('must be');
  });
  it.each(['USDC', 'BEM'])('isolates %s test announcements by token, chain and pool', async symbol => {
    vi.stubEnv('CLAWMARKET_PAYMENT_NETWORK', 'bsc-testnet'); vi.stubEnv('CLAWMARKET_PAYMENT_TOKEN', symbol); vi.stubEnv('ESCROW_POOL_ADDRESS', ''); vi.resetModules();
    const m = await import('./payment-token.js');
    const good = { paymentToken: m.PAYMENT_TOKEN, settlementPool: m.PAYMENT_POOL_ADDRESS };
    expect(m.matchesPaymentNetwork(good)).toBe(true);
    expect(m.matchesPaymentNetwork({})).toBe(false);
    expect(m.matchesPaymentNetwork({ ...good, paymentToken: resolvePaymentToken(symbol) })).toBe(false);
    expect(m.matchesPaymentNetwork({ ...good, settlementPool: '0x1111111111111111111111111111111111111111' })).toBe(false);
    expect(m.matchesPaymentNetwork({ paymentToken: m.PAYMENT_TOKEN })).toBe(false);
    expect(m.paymentNetworkScope()).toContain(':97:'); expect(m.PAYMENT_NATIVE_SYMBOL).toBe('tBNB');
  });
  it('rejects an unknown network before any runtime imports can choose a currency', async () => {
    vi.stubEnv('CLAWMARKET_PAYMENT_NETWORK', 'bsc-mainnet'); vi.resetModules();
    await expect(import('./payment-token.js')).rejects.toThrow('must be default or bsc-testnet');
  });
  it('charges discounted Luna usage at micro-USDC precision instead of a one-cent request floor', () => {
    const token = resolvePaymentToken('USDC', 'bsc-testnet');
    const pricing = { model: 'gpt-6-luna', inputPer1m: 0.02, outputPer1m: 0.1, p0: 0.06, alpha: 0 };
    const prices = lockedPrices(pricing, 0.06, token);
    expect(prices).toEqual({ inputPrice: 20_000n, outputPrice: 100_000n });
    expect(tokenCost(315, 13, prices.inputPrice, prices.outputPrice, token)).toBe(8n);
    expect(tokenCost(0, 0, 0n, 0n, token)).toBe(1n);
    expect(lockedPrices(pricing, 0.12, token)).toEqual({ inputPrice: 40_000n, outputPrice: 200_000n });
    expect(lockedPrices({ model: 'same', inputPer1m: 1, outputPer1m: 1, p0: 1 }, 2, token)).toEqual({ inputPrice: 2_000_000n, outputPrice: 2_000_000n });
  });
  it('rejects an old BSC peer with an incompatible minimum fee', async () => {
    vi.stubEnv('CLAWMARKET_PAYMENT_NETWORK', 'bsc-testnet'); vi.stubEnv('CLAWMARKET_PAYMENT_TOKEN', 'USDC'); vi.stubEnv('ESCROW_POOL_ADDRESS', ''); vi.resetModules();
    const m = await import('./payment-token.js');
    expect(m.matchesPaymentNetwork({ paymentToken: { ...m.PAYMENT_TOKEN, minimumAmount: '0.01' }, settlementPool: m.PAYMENT_POOL_ADDRESS })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';

import {
  buildQuoteTopic,
  createQuoteSignerDelegation,
  isQuoteExpired,
  isQuoteTooFarInFuture,
  signQuote,
  verifyQuote,
  verifyQuoteSignerDelegation,
} from './quote.js';

describe('quote signing', () => {
  const privateKey = Wallet.createRandom().privateKey as `0x${string}`;
  const signingPrivateKey = Wallet.createRandom().privateKey as `0x${string}`;
  const makerAddress = new Wallet(privateKey).address as `0x${string}`;
  const signerAddress = new Wallet(signingPrivateKey).address as `0x${string}`;
  const unsignedQuote = {
    makerId: 'maker-1',
    makerAddress,
    nonce: '0000000000000001',
    model: 'claude-sonnet-4',
    p0: 2,
    alpha: 1,
    utilization: 0.4,
    maxConcurrent: 5,
    currentPrice: 3.33,
    recentLatencyMs: 120,
    successRate: 0.98,
    timestamp: 1_700_000_000_000,
    ttlMs: 10_000,
    schemaVersion: 1 as const,
  };

  it('signs and verifies a quote', () => {
    const quote = signQuote(unsignedQuote, privateKey);

    expect(verifyQuote(quote, makerAddress)).toBe(true);
    expect(quote.nonce).toBe('0000000000000001');
  });

  it('fails verification after tampering', () => {
    const quote = signQuote(unsignedQuote, privateKey);

    expect(verifyQuote({ ...quote, currentPrice: 9.99 }, makerAddress)).toBe(false);
  });

  it('supports delegated quote signing with a wallet-signed delegation', () => {
    const delegation = createQuoteSignerDelegation(signerAddress, privateKey, {
      issuedAt: unsignedQuote.timestamp - 1_000,
      expiresAt: unsignedQuote.timestamp + 60_000,
    });
    const quote = signQuote(unsignedQuote, signingPrivateKey, {
      signingDelegation: delegation,
    });

    expect(quote.signerAddress).toBe(signerAddress);
    expect(verifyQuoteSignerDelegation(delegation, makerAddress)).toBe(true);
    expect(verifyQuote(quote, makerAddress)).toBe(true);
  });

  it('rejects delegated quotes when the delegation has been tampered with', () => {
    const delegation = createQuoteSignerDelegation(signerAddress, privateKey, {
      issuedAt: unsignedQuote.timestamp - 1_000,
      expiresAt: unsignedQuote.timestamp + 60_000,
    });
    const quote = signQuote(unsignedQuote, signingPrivateKey, {
      signingDelegation: delegation,
    });

    expect(verifyQuote({
      ...quote,
      signingDelegation: {
        ...delegation,
        signerAddress: makerAddress,
      },
    }, makerAddress)).toBe(false);
  });

  it('checks quote expiration', () => {
    expect(isQuoteExpired({ timestamp: 1_000, ttlMs: 100 }, 3_099)).toBe(false);
    expect(isQuoteExpired({ timestamp: 1_000, ttlMs: 100 }, 3_101)).toBe(true);
  });

  it('accepts small future skew but rejects far-future timestamps', () => {
    expect(isQuoteTooFarInFuture({ timestamp: 3_000 }, 1_500)).toBe(false);
    expect(isQuoteTooFarInFuture({ timestamp: 3_501 }, 1_500)).toBe(true);
  });

  it('clock skew within grace window does not reject quotes', () => {
    expect(isQuoteExpired({ timestamp: 1_000, ttlMs: 10_000 }, 13_000)).toBe(false);
    expect(isQuoteTooFarInFuture({ timestamp: 12_000 }, 10_000)).toBe(false);
  });

  it('builds quote topics with an optional network prefix', () => {
    expect(buildQuoteTopic('claude-sonnet-4')).toBe('aimm/quotes/claude-sonnet-4');
    expect(buildQuoteTopic('claude-sonnet-4', 'testnet')).toBe('aimm/testnet/quotes/claude-sonnet-4');
  });
});

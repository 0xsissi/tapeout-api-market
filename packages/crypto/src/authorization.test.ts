import { describe, expect, it } from 'vitest';

import {
  AuthorizationSigner,
  getDefaultAuthorizationDomain,
  poolIdFromAddress,
  verifyAuthorizationSignature,
} from './authorization.js';

describe('authorization', () => {
  it('signs and verifies an escrow-pool authorization', async () => {
    const privateKey =
      '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
    const escrowPool = '0x0000000000000000000000000000000000000abc' as const;
    const seller = '0x0000000000000000000000000000000000000def' as const;
    const signer = new AuthorizationSigner(privateKey, escrowPool, 'http://127.0.0.1:8545');

    const authorization = await signer.createAuthorization(
      seller,
      1.25,
      7n,
      1_776_420_000,
      poolIdFromAddress(escrowPool),
    );

    expect(authorization.buyer).toBe(signer.address);
    expect(authorization.nonceMode).toBe('bitmap');
    expect(await verifyAuthorizationSignature(
      authorization,
      signer.address,
      getDefaultAuthorizationDomain(escrowPool),
    )).toBe(true);
  });

  it('verifies legacy sequential authorizations without nonceMode', async () => {
    const privateKey =
      '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
    const escrowPool = '0x0000000000000000000000000000000000000abc' as const;
    const seller = '0x0000000000000000000000000000000000000def' as const;
    const signer = new AuthorizationSigner(privateKey, escrowPool, 'http://127.0.0.1:8545');

    const authorization = await signer.signAuthorization({
      buyer: signer.address,
      seller,
      amount: 1_250_000n,
      nonce: 3n,
      expiresAt: 1_776_420_000,
      poolId: poolIdFromAddress(escrowPool),
    });

    expect(authorization.nonceMode).toBeUndefined();
    expect(await verifyAuthorizationSignature(
      authorization,
      signer.address,
      getDefaultAuthorizationDomain(escrowPool),
    )).toBe(true);
  });
});

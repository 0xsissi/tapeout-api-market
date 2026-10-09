import { paymentNetworkScope } from './payment-token.js';
import { Wallet, verifyMessage } from 'ethers';

import type { QuoteMessage, QuoteSignerDelegation } from './types/index.js';

export type UnsignedQuoteMessage = Omit<QuoteMessage, 'signature'>;
export const QUOTE_CLOCK_GRACE_MS = 2_000;
const DEFAULT_SIGNING_DELEGATION_TTL_MS = 8 * 24 * 60 * 60 * 1000;

export function buildQuoteTopic(model: string, networkId?: string): string {
  const normalizedNetwork = [paymentNetworkScope(), networkId?.trim()].filter(Boolean).join('/');
  if (normalizedNetwork) {
    return `aimm/${normalizedNetwork}/quotes/${model}`;
  }
  return `aimm/quotes/${model}`;
}

export function signQuote(
  quote: UnsignedQuoteMessage,
  privateKey: `0x${string}`,
  options?: {
    signingDelegation?: QuoteSignerDelegation;
  },
): QuoteMessage {
  const signerAddress = new Wallet(privateKey).address as `0x${string}`;
  const signingDelegation = options?.signingDelegation ?? quote.signingDelegation;

  if (signerAddress.toLowerCase() !== quote.makerAddress.toLowerCase()) {
    if (!signingDelegation) {
      throw new Error('Delegated quote signing requires a wallet-backed signing delegation');
    }
    if (signingDelegation.walletAddress.toLowerCase() !== quote.makerAddress.toLowerCase()) {
      throw new Error('Quote signing delegation wallet does not match makerAddress');
    }
    if (signingDelegation.signerAddress.toLowerCase() !== signerAddress.toLowerCase()) {
      throw new Error('Quote signing delegation signer does not match signing private key');
    }
  }

  const payload = {
    ...quote,
    signerAddress: signerAddress.toLowerCase() === quote.makerAddress.toLowerCase()
      ? undefined
      : signerAddress,
    signingDelegation,
  };
  const signature = new Wallet(privateKey).signMessageSync(canonicalJson(payload)) as `0x${string}`;
  return { ...payload, signature };
}

export function verifyQuote(
  quote: QuoteMessage,
  expectedAddress: `0x${string}` = quote.makerAddress,
): boolean {
  try {
    const signerAddress = quote.signerAddress ?? quote.makerAddress;
    if (signerAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
      if (!quote.signingDelegation) {
        return false;
      }
      if (quote.signingDelegation.walletAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
        return false;
      }
      if (quote.signingDelegation.signerAddress.toLowerCase() !== signerAddress.toLowerCase()) {
        return false;
      }
      if (quote.timestamp > quote.signingDelegation.expiresAt + QUOTE_CLOCK_GRACE_MS) {
        return false;
      }
      if (!verifyQuoteSignerDelegation(quote.signingDelegation, expectedAddress)) {
        return false;
      }
    }

    const { signature, ...rest } = quote;
    const recovered = verifyMessage(canonicalJson(rest), signature);
    return recovered.toLowerCase() === signerAddress.toLowerCase();
  } catch {
    return false;
  }
}

export function createQuoteSignerDelegation(
  signerAddress: `0x${string}`,
  walletPrivateKey: `0x${string}`,
  options?: {
    issuedAt?: number;
    expiresAt?: number;
  },
): QuoteSignerDelegation {
  const walletAddress = new Wallet(walletPrivateKey).address as `0x${string}`;
  const issuedAt = options?.issuedAt ?? Date.now();
  const expiresAt = options?.expiresAt ?? issuedAt + DEFAULT_SIGNING_DELEGATION_TTL_MS;
  const unsignedDelegation = {
    walletAddress,
    signerAddress,
    issuedAt,
    expiresAt,
  };
  const signature = new Wallet(walletPrivateKey).signMessageSync(
    canonicalJson({
      type: 'aimm-quote-delegation',
      ...unsignedDelegation,
    }),
  ) as `0x${string}`;

  return {
    ...unsignedDelegation,
    signature,
  };
}

export function verifyQuoteSignerDelegation(
  delegation: QuoteSignerDelegation,
  expectedWalletAddress: `0x${string}` = delegation.walletAddress,
): boolean {
  try {
    const { signature, ...rest } = delegation;
    const recovered = verifyMessage(
      canonicalJson({
        type: 'aimm-quote-delegation',
        ...rest,
      }),
      signature,
    );
    return recovered.toLowerCase() === expectedWalletAddress.toLowerCase();
  } catch {
    return false;
  }
}

export function isQuoteExpired(
  quote: Pick<QuoteMessage, 'timestamp' | 'ttlMs'>,
  now = Date.now(),
  graceMs = QUOTE_CLOCK_GRACE_MS,
): boolean {
  return now > quote.timestamp + quote.ttlMs + graceMs;
}

export function isQuoteTooFarInFuture(
  quote: Pick<QuoteMessage, 'timestamp'>,
  now = Date.now(),
  graceMs = QUOTE_CLOCK_GRACE_MS,
): boolean {
  return quote.timestamp - now > graceMs;
}

function canonicalJson(value: unknown): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));

  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

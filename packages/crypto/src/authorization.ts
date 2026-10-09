import { PAYMENT_NATIVE_SYMBOL, parsePaymentAmount } from '@clawmarket/shared';
/**
 * EIP-712 Authorization signing & verification for EscrowPool claims.
 */

import {
  createWalletClient,
  http,
  padHex,
  verifyTypedData,
  keccak256,
  stringToHex,
  type Account,
  type Chain,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

import {
  type Authorization,
  type AuthorizationNonceMode,
  type SignedAuthorization,
  type SignedInferenceIntent,
} from '@clawmarket/shared';

const BITMAP_NONCE_MODE = 'bitmap' as const;
const SEQUENTIAL_NONCE_MODE = 'sequential' as const;

function normalizeAuthorizationNonceMode(
  nonceMode?: AuthorizationNonceMode,
): AuthorizationNonceMode {
  return nonceMode === BITMAP_NONCE_MODE ? BITMAP_NONCE_MODE : SEQUENTIAL_NONCE_MODE;
}

function authorizationNonceModeValue(nonceMode?: AuthorizationNonceMode): 0 | 1 {
  return normalizeAuthorizationNonceMode(nonceMode) === BITMAP_NONCE_MODE ? 1 : 0;
}

export interface AuthorizationDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: `0x${string}`;
}

export function getDefaultAuthorizationDomain(
  escrowPoolAddress: `0x${string}`,
  chainId: number = 84532,
): AuthorizationDomain {
  return {
    name: 'ClawEscrowPool',
    version: '1',
    chainId,
    verifyingContract: escrowPoolAddress,
  };
}

export function poolIdFromAddress(address: `0x${string}`): `0x${string}` {
  return padHex(address, { size: 32 });
}

export const LEGACY_AUTHORIZATION_TYPES = {
  Authorization: [
    { name: 'buyer', type: 'address' },
    { name: 'seller', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
    { name: 'poolId', type: 'bytes32' },
  ],
} as const;

export const BITMAP_AUTHORIZATION_TYPES = {
  Authorization: [
    { name: 'buyer', type: 'address' },
    { name: 'seller', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
    { name: 'poolId', type: 'bytes32' },
    { name: 'nonceMode', type: 'uint8' },
  ],
} as const;

export const INFERENCE_INTENT_TYPES = {
  InferenceIntent: [
    ...BITMAP_AUTHORIZATION_TYPES.Authorization,
    { name: 'requestId', type: 'string' },
    { name: 'payloadHash', type: 'bytes32' },
    { name: 'inputPrice', type: 'uint256' },
    { name: 'outputPrice', type: 'uint256' },
    { name: 'maxInputTokens', type: 'uint256' },
    { name: 'maxOutputTokens', type: 'uint256' },
  ],
} as const;

export function getInferenceIntentDomain(pool: `0x${string}`, chainId = 84532): AuthorizationDomain {
  return { ...getDefaultAuthorizationDomain(pool, chainId), name: 'ClawInferenceIntent' };
}

export function hashInferencePayload(payload: string): `0x${string}` {
  return keccak256(stringToHex(payload));
}

export function inferenceIntentMessage(intent: Omit<SignedInferenceIntent, 'signature'>) {
  return { ...intent, expiresAt: BigInt(intent.expiresAt), nonceMode: authorizationNonceModeValue(intent.nonceMode),
    maxInputTokens: BigInt(intent.maxInputTokens), maxOutputTokens: BigInt(intent.maxOutputTokens) };
}

export async function verifyInferenceIntent(intent: SignedInferenceIntent, pool: `0x${string}`, chainId: number): Promise<boolean> {
  try {
    return await verifyTypedData({ address: intent.buyer, domain: getInferenceIntentDomain(pool, chainId),
      types: INFERENCE_INTENT_TYPES, primaryType: 'InferenceIntent', message: inferenceIntentMessage(intent), signature: intent.signature });
  } catch { return false; }
}

function getAuthorizationTypes(nonceMode?: AuthorizationNonceMode) {
  return normalizeAuthorizationNonceMode(nonceMode) === BITMAP_NONCE_MODE
    ? BITMAP_AUTHORIZATION_TYPES
    : LEGACY_AUTHORIZATION_TYPES;
}

function getAuthorizationMessage(authorization: Authorization) {
  const nonceMode = normalizeAuthorizationNonceMode(authorization.nonceMode);
  const baseMessage = {
    buyer: authorization.buyer,
    seller: authorization.seller,
    amount: authorization.amount,
    nonce: authorization.nonce,
    expiresAt: BigInt(authorization.expiresAt),
    poolId: authorization.poolId,
  };

  if (nonceMode === BITMAP_NONCE_MODE) {
    return {
      ...baseMessage,
      nonceMode: authorizationNonceModeValue(nonceMode),
    };
  }

  return baseMessage;
}

export class AuthorizationSigner {
  private walletClient: WalletClient;
  private account: Account;
  private domain: AuthorizationDomain;

  constructor(
    privateKey: `0x${string}`,
    escrowPoolAddress: `0x${string}`,
    rpcUrl: string,
    chainId: number = 84532,
  ) {
    this.account = privateKeyToAccount(privateKey);

    const chain: Chain = chainId === 84532 ? baseSepolia : {
      id: chainId,
      name: 'Custom',
      nativeCurrency: { name: PAYMENT_NATIVE_SYMBOL, symbol: PAYMENT_NATIVE_SYMBOL, decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    };

    this.walletClient = createWalletClient({
      account: this.account,
      chain,
      transport: http(rpcUrl),
    });

    this.domain = getDefaultAuthorizationDomain(escrowPoolAddress, chainId);
  }

  get address(): `0x${string}` {
    return this.account.address;
  }

  async signAuthorization(authorization: Authorization): Promise<SignedAuthorization> {
    const nonceMode = normalizeAuthorizationNonceMode(authorization.nonceMode);
    const signature = await this.walletClient.signTypedData({
      account: this.account,
      domain: this.domain,
      types: getAuthorizationTypes(nonceMode),
      primaryType: 'Authorization',
      message: getAuthorizationMessage(authorization),
    });

    if (nonceMode === BITMAP_NONCE_MODE) {
      return { ...authorization, nonceMode, signature };
    }

    return authorization.nonceMode == null
      ? { ...authorization, signature }
      : { ...authorization, nonceMode, signature };
  }

  async signInferenceIntent(intent: Omit<SignedInferenceIntent, 'signature'>): Promise<SignedInferenceIntent> {
    if (intent.nonceMode !== BITMAP_NONCE_MODE) throw new Error('Delivery-confirmed inference requires bitmap nonces');
    const signature = await this.walletClient.signTypedData({ account: this.account,
      domain: getInferenceIntentDomain(this.domain.verifyingContract, this.domain.chainId),
      types: INFERENCE_INTENT_TYPES, primaryType: 'InferenceIntent', message: inferenceIntentMessage(intent) });
    return { ...intent, signature };
  }

  async createAuthorization(
    seller: `0x${string}`,
    amountUsd: number,
    nonce: bigint,
    expiresAt: number,
    poolId: `0x${string}` = poolIdFromAddress(this.domain.verifyingContract),
    nonceMode: AuthorizationNonceMode = BITMAP_NONCE_MODE,
  ): Promise<SignedAuthorization> {
    const amount = parsePaymentAmount(amountUsd);
    return this.signAuthorization({
      buyer: this.account.address,
      seller,
      amount,
      nonce,
      expiresAt,
      poolId,
      nonceMode,
    });
  }
}

export async function verifyAuthorizationSignature(
  authorization: SignedAuthorization,
  expectedSigner: `0x${string}`,
  domain: AuthorizationDomain,
): Promise<boolean> {
  try {
    const nonceMode = normalizeAuthorizationNonceMode(authorization.nonceMode);
    return await verifyTypedData({
      address: expectedSigner,
      domain,
      types: getAuthorizationTypes(nonceMode),
      primaryType: 'Authorization',
      message: getAuthorizationMessage(authorization),
      signature: authorization.signature,
    });
  } catch {
    return false;
  }
}

export function calculateAuthorizationAmount(
  inputTokens: number,
  outputTokens: number,
  pricing: { inputPer1m: number; outputPer1m: number },
): number {
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1m;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1m;
  return inputCost + outputCost;
}

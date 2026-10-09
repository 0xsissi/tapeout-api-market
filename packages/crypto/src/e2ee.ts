/**
 * End-to-End Encryption module
 * Migrated from claw-market/gateway-plugin/src/crypto/e2ee.ts
 * Uses secp256k1 ECDH + AES-256-GCM
 */

import * as secp256k1 from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256.js';
import { randomBytes } from 'crypto';

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  secretKey: Uint8Array; // alias for privateKey
}

/**
 * Generate a new secp256k1 key pair
 */
export function generateKeyPair(): KeyPair {
  const privateKey = secp256k1.utils.randomPrivateKey();
  const publicKey = secp256k1.getPublicKey(privateKey, false); // uncompressed
  return { privateKey, publicKey, secretKey: privateKey };
}

/**
 * Derive public key from private key
 */
export function getPublicKey(privateKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privateKey, false);
}

/**
 * Compute shared secret using ECDH
 */
export function computeSharedSecret(
  privateKey: Uint8Array,
  publicKey: Uint8Array
): Uint8Array {
  const shared = secp256k1.getSharedSecret(privateKey, publicKey);
  return sha256(shared);
}

/**
 * Encrypt data using AES-256-GCM with ECDH shared secret
 */
export async function encrypt(
  plaintext: string,
  senderPrivateKey: Uint8Array,
  recipientPublicKey: Uint8Array
): Promise<string> {
  const sharedSecret = computeSharedSecret(senderPrivateKey, recipientPublicKey);
  const iv = randomBytes(12);

  const key = await crypto.subtle.importKey(
    'raw',
    sharedSecret,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return Buffer.from(combined).toString('base64');
}

/**
 * Decrypt data using AES-256-GCM with ECDH shared secret
 */
export async function decrypt(
  encryptedBase64: string,
  recipientPrivateKey: Uint8Array,
  senderPublicKey: Uint8Array
): Promise<string> {
  const sharedSecret = computeSharedSecret(recipientPrivateKey, senderPublicKey);
  const combined = Buffer.from(encryptedBase64, 'base64');

  const iv = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12);

  const key = await crypto.subtle.importKey(
    'raw',
    sharedSecret,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  const decoder = new TextDecoder();
  return decoder.decode(plaintext);
}

export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  return new Uint8Array(Buffer.from(cleanHex, 'hex'));
}

export function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex');
}

export function serializePublicKey(publicKey: Uint8Array): string {
  return bytesToHex(publicKey);
}

export function deserializePublicKey(serialized: string): Uint8Array {
  return hexToBytes(serialized);
}

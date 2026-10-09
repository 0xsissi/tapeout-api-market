/**
 * PeerId management for Tapeout API Market nodes.
 *
 * Supports generating new PeerIds, loading from disk, and deriving
 * from Ethereum private keys (secp256k1).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPair, privateKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId, PrivateKey } from '@libp2p/interface';

/** Default path for persisted peer identity */
const DEFAULT_IDENTITY_PATH = path.join(os.homedir(), '.clawmarket', 'peer-id.json');

interface StoredIdentity {
  privateKey: string; // hex-encoded raw private key bytes
  peerId: string;
}

/**
 * Generate a new Ed25519 PeerId.
 * @returns The private key and derived PeerId
 */
export async function generateIdentity(): Promise<{ privateKey: PrivateKey; peerId: PeerId }> {
  const privateKey = await generateKeyPair('Ed25519');
  const peerId = peerIdFromPrivateKey(privateKey);
  return { privateKey, peerId };
}

/**
 * Load a PeerId from a local file, or generate and save a new one.
 * @param filePath - Path to the identity JSON file (default: ~/.clawmarket/peer-id.json)
 * @returns The private key and derived PeerId
 */
export async function loadOrCreateIdentity(
  filePath: string = DEFAULT_IDENTITY_PATH
): Promise<{ privateKey: PrivateKey; peerId: PeerId }> {
  if (existsSync(filePath)) {
    return loadIdentity(filePath);
  }
  const { privateKey, peerId } = await generateIdentity();
  await saveIdentity(privateKey, peerId, filePath);
  return { privateKey, peerId };
}

/**
 * Load a PeerId from a JSON file on disk.
 * @param filePath - Path to the identity JSON file
 */
export async function loadIdentity(
  filePath: string = DEFAULT_IDENTITY_PATH
): Promise<{ privateKey: PrivateKey; peerId: PeerId }> {
  const raw = await readFile(filePath, 'utf-8');
  const stored: StoredIdentity = JSON.parse(raw);
  const keyBytes = hexToBytes(stored.privateKey);
  const privateKey = await generateKeyPair('Ed25519'); // placeholder to get type
  // Re-create from raw bytes
  const restoredKey = privateKeyFromRaw(keyBytes);
  const peerId = peerIdFromPrivateKey(restoredKey);
  return { privateKey: restoredKey, peerId };
}

/**
 * Save a PeerId identity to a JSON file.
 * @param privateKey - The private key to persist
 * @param peerId - The PeerId derived from the private key
 * @param filePath - Destination file path
 */
export async function saveIdentity(
  privateKey: PrivateKey,
  peerId: PeerId,
  filePath: string = DEFAULT_IDENTITY_PATH
): Promise<void> {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const stored: StoredIdentity = {
    privateKey: bytesToHex(privateKey.raw),
    peerId: peerId.toString(),
  };
  await writeFile(filePath, JSON.stringify(stored, null, 2), 'utf-8');
}

/**
 * Derive a PeerId from an Ethereum private key (secp256k1).
 * This allows the same key to be used for both Ethereum transactions and P2P identity.
 * @param ethPrivateKey - Hex-encoded Ethereum private key (with or without 0x prefix)
 */
export async function peerIdFromEthKey(
  ethPrivateKey: `0x${string}` | string
): Promise<{ privateKey: PrivateKey; peerId: PeerId }> {
  const hex = ethPrivateKey.startsWith('0x') ? ethPrivateKey.slice(2) : ethPrivateKey;
  const keyBytes = hexToBytes(hex);
  const privateKey = privateKeyFromRaw(new Uint8Array([...new Uint8Array([0x08, 0x02]), ...keyBytes]));
  // Note: secp256k1 key type code is 0x02 in libp2p protobuf key format
  // For secp256k1, we construct appropriately
  const secp256k1Key = privateKeyFromRaw(keyBytes);
  const peerId = peerIdFromPrivateKey(secp256k1Key);
  return { privateKey: secp256k1Key, peerId };
}

// ---- Utility helpers ----

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

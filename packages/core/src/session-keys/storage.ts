/**
 * Session Key Secure Storage
 *
 * Provides AES-256-GCM encryption for session key private keys
 * using a password-derived key (PBKDF2) for storage.
 *
 * Supports:
 * - LocalStorageAdapter (from core/storage.ts)
 * - MemoryStorageAdapter (for testing / SSR)
 * - IndexedDB-backed storage (browser-native, non-blocking)
 *
 * Private keys are NEVER stored in plaintext — always encrypted
 * before persisting, and decrypted only in memory during signing.
 *
 * @see docs/features/session-keys.md §6
 */

import { pbkdf2 } from "@noble/hashes/pbkdf2";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils";
import { gcm } from "@noble/ciphers/aes.js";
import { secp256k1 } from "@noble/curves/secp256k1";

import type { StorageAdapter } from "../storage";
import { MemoryStorageAdapter } from "../storage";
import { createSessionKeyError } from "./errors";
import type { EncryptedKeyPair, StoredSessionKey } from "./types";

// ─── Constants ─────────────────────────────────────────────────────────

const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // GCM recommended nonce length
const SALT_LENGTH = 16;
const DEFAULT_PBKDF2_ITERATIONS = 600_000;
const STORAGE_KEY = "session_keys";
const ENCRYPTION_KEY_STORAGE_KEY = "session_key_encryption_salt";

function deriveEncryptionKey(
  password: string,
  salt: Uint8Array,
  iterations?: number,
): Uint8Array {
  return pbkdf2(sha256, password, salt, {
    c: iterations ?? DEFAULT_PBKDF2_ITERATIONS,
    dkLen: KEY_LENGTH,
  });
}

// ─── API ───────────────────────────────────────────────────────────────

/**
 * Encrypt a private key hex string for secure storage.
 *
 * @param privateKeyHex - The raw private key as a 0x-prefixed hex string
 * @param password - Derivation password (e.g. wallet seed hash or user-provided)
 * @param salt - Optional salt override (provided for decryption consistency)
 * @returns EncryptedKeyPair with ciphertext, IV, and salt
 */
export function encryptPrivateKey(
  privateKeyHex: `0x${string}`,
  password: string,
  salt?: Uint8Array,
  iterations?: number,
  publicKeyHex?: `0x${string}`,
): EncryptedKeyPair {
  const pkBytes = hexToBytes(privateKeyHex.slice(2));
  const actualSalt = salt ?? randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveEncryptionKey(password, actualSalt, iterations);

  // Standard AES-256-GCM (AEAD) — noble appends the 16-byte tag to the ciphertext.
  const ciphertext = gcm(key, iv).encrypt(pkBytes);

  // Derive the public key from the private key; never fall back to the
  // private-key bytes as a "publicKey" (that leaked the secret material).
  const resultPublicKey =
    publicKeyHex ??
    (pkBytes.length === 32
      ? (`0x${bytesToHex(secp256k1.getPublicKey(pkBytes, true))}` as `0x${string}`)
      : ("0x" as `0x${string}`));

  return {
    publicKey: resultPublicKey,
    encryptedPrivateKey: bytesToHex(ciphertext),
    iv: bytesToHex(iv),
    salt: bytesToHex(actualSalt),
  };
}

/**
 * Decrypt an encrypted private key for in-memory signing.
 *
 * @param encrypted - EncryptedKeyPair from storage
 * @param password - The same password used during encryption
 * @param iterations - Must match the value used during encryption
 * @returns The raw private key as a 0x-prefixed hex string
 */
export function decryptPrivateKey(
  encrypted: EncryptedKeyPair,
  password: string,
  iterations?: number,
): `0x${string}` {
  const ciphertext = hexToBytes(encrypted.encryptedPrivateKey);
  const iv = hexToBytes(encrypted.iv);
  const salt = hexToBytes(encrypted.salt);
  const key = deriveEncryptionKey(password, salt, iterations);

  let plaintext: Uint8Array;
  try {
    plaintext = gcm(key, iv).decrypt(ciphertext);
  } catch {
    throw createSessionKeyError(
      "session_key_encryption_failed",
      "Tag verification failed (wrong password or corrupted data)",
    );
  }

  return `0x${bytesToHex(plaintext)}`;
}

// ─── Storage Persistence ───────────────────────────────────────────────

/**
 * BigInt-aware JSON serialization: converts BigInt to "__bigint__" strings.
 */
function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return { __bigint__: value.toString() };
  }
  return value;
}

/**
 * BigInt-aware JSON deserialization: restores "__bigint__" strings to BigInt.
 */
function bigintReviver(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    "__bigint__" in (value as Record<string, unknown>)
  ) {
    return BigInt((value as Record<string, string>)["__bigint__"]);
  }
  return value;
}

/**
 * Manages persistence of StoredSessionKey records to a StorageAdapter.
 * All private keys are already encrypted before reaching this layer.
 */
export class SessionKeyStorage {
  private adapter: StorageAdapter;

  constructor(adapter?: StorageAdapter) {
    this.adapter = adapter ?? new MemoryStorageAdapter();
  }

  /**
   * Check if the storage backend is available.
   */
  isAvailable(): boolean {
    return this.adapter.isAvailable();
  }

  /**
   * Load all stored session keys with BigInt revival.
   */
  async loadAll(): Promise<StoredSessionKey[]> {
    try {
      const raw = await this.adapter.get<string>(STORAGE_KEY);
      if (!raw) return [];
      if (typeof raw === "string") {
        return JSON.parse(raw, bigintReviver) as StoredSessionKey[];
      }
      // Fallback: if already deserialized (e.g. MemoryStorageAdapter), re-parse
      return JSON.parse(
        JSON.stringify(raw),
        bigintReviver,
      ) as StoredSessionKey[];
    } catch {
      return [];
    }
  }

  /**
   * Persist an array of session keys with BigInt serialization.
   */
  private async persistAll(keys: StoredSessionKey[]): Promise<void> {
    const serialized = JSON.stringify(keys, bigintReplacer);
    // Store as raw string to avoid adapter-level JSON.stringify double-encoding
    await this.adapter.set(
      STORAGE_KEY,
      serialized as unknown as StoredSessionKey[],
    );
  }

  /**
   * Save a single session key (adds or updates).
   */
  async save(key: StoredSessionKey): Promise<void> {
    const keys = await this.loadAll();
    const index = keys.findIndex((k) => k.id === key.id);
    if (index >= 0) {
      keys[index] = key;
    } else {
      keys.push(key);
    }
    await this.persistAll(keys);
  }

  /**
   * Retrieve a single session key by ID.
   */
  async get(id: string): Promise<StoredSessionKey | null> {
    const keys = await this.loadAll();
    return keys.find((k) => k.id === id) ?? null;
  }

  /**
   * Remove a single session key by ID.
   */
  async remove(id: string): Promise<void> {
    const keys = await this.loadAll();
    const filtered = keys.filter((k) => k.id !== id);
    await this.persistAll(filtered);
  }

  /**
   * Update the status of a session key (active → revoked / expired).
   */
  async updateStatus(
    id: string,
    status: StoredSessionKey["status"],
  ): Promise<void> {
    const keys = await this.loadAll();
    const key = keys.find((k) => k.id === id);
    if (!key) {
      throw createSessionKeyError("session_key_not_found", id);
    }
    key.status = status;
    await this.persistAll(keys);
  }

  /**
   * Increment the usage counter for a session key.
   */
  async incrementUsage(id: string): Promise<void> {
    const keys = await this.loadAll();
    const key = keys.find((k) => k.id === id);
    if (!key) {
      throw createSessionKeyError("session_key_not_found", id);
    }
    key.useCount += 1;
    key.lastUsedAt = Date.now();
    await this.persistAll(keys);
  }

  /**
   * Remove all session keys.
   */
  async clear(): Promise<void> {
    await this.adapter.remove(STORAGE_KEY);
  }
}

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

import { gcm } from "@noble/ciphers/aes.js";
import { hmac } from "@noble/hashes/hmac.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";

import type { StorageAdapter } from "../storage";
import { MemoryStorageAdapter } from "../storage";
import { createSessionKeyError } from "./errors";
import type { EncryptedKeyPair, StoredSessionKey } from "./types";

// ─── Constants ─────────────────────────────────────────────────────────

const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // GCM recommended nonce length
const SALT_LENGTH = 16;
const DEFAULT_PBKDF2_ITERATIONS = 600_000;
/**
 * Floor for caller-supplied PBKDF2 work factors, matching the OWASP guidance
 * for PBKDF2-HMAC-SHA256. Enforced when writing new material only: existing
 * records encrypted under a weaker factor must stay readable so they can be
 * migrated, and refusing to decrypt them would not make them any stronger.
 */
const MIN_PBKDF2_ITERATIONS = 600_000;

function assertIterationFloor(
  iterations: number | undefined,
  allowWeak = false,
): void {
  if (allowWeak) return;
  if (iterations === undefined) return;
  // NaN slips past a bare `< MIN` comparison because every NaN comparison is
  // false. @noble/hashes rejects it downstream, but the floor should not
  // depend on that, and "positive integer expected" does not tell the caller
  // which parameter was wrong.
  if (!Number.isInteger(iterations) || iterations < MIN_PBKDF2_ITERATIONS) {
    throw new Error(
      `PBKDF2 iterations must be an integer of at least ` +
        `${MIN_PBKDF2_ITERATIONS}; received ${iterations}.`,
    );
  }
}
const STORAGE_KEY = "session_keys";
const ENCRYPTION_KEY_STORAGE_KEY = "session_key_encryption_salt";

type AsyncOperation<T> = () => Promise<T>;

/**
 * A process-local fallback for runtimes without the Web Locks API. Browser
 * tabs use navigator.locks below, while this map keeps multiple managers in
 * the same process serialized (including tests and SSR).
 */
const processLocks = new WeakMap<StorageAdapter, Map<string, Promise<void>>>();

// ─── Key derivation and legacy compatibility ──────────────────────────

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

/** Decrypt records written by the pre-0.2 implementation. */
function legacyCtrHmacDecrypt(
  ciphertext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  tag: Uint8Array,
): Uint8Array {
  // Verify authentication tag (binds IV to auth)
  const authData = new Uint8Array(iv.length + ciphertext.length);
  authData.set(iv);
  authData.set(ciphertext, iv.length);
  const expectedTag = hmac(sha256, key, authData).slice(0, 16);
  let tagValid = tag.length === expectedTag.length;
  if (tagValid) {
    for (let i = 0; i < tag.length; i++) {
      if (tag[i] !== expectedTag[i]) {
        tagValid = false;
        break;
      }
    }
  }

  if (!tagValid) {
    throw createSessionKeyError(
      "session_key_encryption_failed",
      "Tag verification failed",
    );
  }

  // Same CTR decryption (XOR is symmetric)
  const blockSize = 16;
  const numBlocks = Math.ceil(ciphertext.length / blockSize);
  const keystream = new Uint8Array(numBlocks * 32);

  let ctrValue = 0n;
  for (let i = 0; i < iv.length; i++) {
    ctrValue = (ctrValue << 8n) | BigInt(iv[i]);
  }

  for (let b = 0; b < numBlocks; b++) {
    const counterBytes = new Uint8Array(8);
    let blockCtr = ctrValue + BigInt(b);
    for (let i = 7; i >= 0; i--) {
      counterBytes[i] = Number(blockCtr & 0xffn);
      blockCtr >>= 8n;
    }

    const input = new Uint8Array(iv.length + 8);
    input.set(iv.slice(0, 4), 0);
    input.set(counterBytes, 4);

    const blockKey = hmac(sha256, key, input);
    keystream.set(blockKey, b * 32);
  }

  const plaintext = new Uint8Array(ciphertext.length);
  for (let i = 0; i < ciphertext.length; i++) {
    plaintext[i] = ciphertext[i] ^ keystream[i];
  }

  return plaintext;
}

// ─── API ───────────────────────────────────────────────────────────────

/**
 * Encrypt a private key hex string for secure storage.
 *
 * @param privateKeyHex - The raw private key as a 0x-prefixed hex string
 * @param password - Derivation password (e.g. wallet seed hash or user-provided)
 * @param salt - Optional salt override (provided for decryption consistency)
 * @param iterations - PBKDF2 work factor; must be >= MIN_PBKDF2_ITERATIONS
 * @returns EncryptedKeyPair with ciphertext, IV, and salt
 */
export function encryptPrivateKey(
  privateKeyHex: `0x${string}`,
  password: string,
  salt?: Uint8Array,
  iterations?: number,
  publicKeyHex?: `0x${string}`,
  options?: { unsafeAllowWeakKdf?: boolean },
): EncryptedKeyPair {
  assertIterationFloor(iterations, options?.unsafeAllowWeakKdf);
  const pkBytes = hexToBytes(privateKeyHex.slice(2));
  const actualSalt = salt ?? randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveEncryptionKey(password, actualSalt, iterations);

  const resultPublicKey =
    publicKeyHex ?? (`0x${bytesToHex(pkBytes)}` as `0x${string}`);
  const aad = hexToBytes(resultPublicKey.slice(2));
  const combined = gcm(key, iv, aad).encrypt(pkBytes);

  return {
    publicKey: resultPublicKey,
    encryptedPrivateKey: bytesToHex(combined),
    iv: bytesToHex(iv),
    salt: bytesToHex(actualSalt),
    algorithm: "aes-256-gcm",
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
  const combined = hexToBytes(encrypted.encryptedPrivateKey);
  const iv = hexToBytes(encrypted.iv);
  const salt = hexToBytes(encrypted.salt);
  const key = deriveEncryptionKey(password, salt, iterations);

  const plaintext = encrypted.algorithm === "aes-256-gcm"
    ? gcm(key, iv, hexToBytes(encrypted.publicKey.slice(2))).decrypt(combined)
    : legacyCtrHmacDecrypt(
        combined.slice(16),
        key,
        iv,
        combined.slice(0, 16),
      );

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
      return await this.loadAllStrict();
    } catch {
      return [];
    }
  }

  /** Load records without hiding parse or backend errors from mutations. */
  private async loadAllStrict(): Promise<StoredSessionKey[]> {
    const raw = await this.adapter.get<string>(STORAGE_KEY);
    if (!raw) return [];
    if (typeof raw === "string") {
      return JSON.parse(raw, bigintReviver) as StoredSessionKey[];
    }
    // Fallback: if already deserialized (e.g. MemoryStorageAdapter), re-parse
    return JSON.parse(JSON.stringify(raw), bigintReviver) as StoredSessionKey[];
  }

  /**
   * Serialize all operations for one key across managers and browser tabs.
   * navigator.locks is supported by modern browsers and provides the
   * cross-tab part; the WeakMap covers runtimes where it is unavailable.
   */
  async withKeyLock<T>(id: string, operation: AsyncOperation<T>): Promise<T> {
    return this.withLock(
      `key:${id}`,
      `naculus-session-key:${STORAGE_KEY}:${id}`,
      operation,
    );
  }

  /** Serialize array read-modify-write operations across all session keys. */
  async withStorageLock<T>(operation: AsyncOperation<T>): Promise<T> {
    return this.withLock(
      "all",
      `naculus-session-storage:${STORAGE_KEY}`,
      operation,
    );
  }

  private async withLock<T>(
    processKey: string,
    webLockName: string,
    operation: AsyncOperation<T>,
  ): Promise<T> {
    const runInProcess = async (): Promise<T> => {
      let locks = processLocks.get(this.adapter);
      if (!locks) {
        locks = new Map();
        processLocks.set(this.adapter, locks);
      }

      const previous = locks.get(processKey) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      locks.set(processKey, gate);
      await previous.catch(() => undefined);
      try {
        return await operation();
      } finally {
        release();
        if (locks.get(processKey) === gate) locks.delete(processKey);
      }
    };

    const locks = (
      globalThis as typeof globalThis & {
        navigator?: {
          locks?: {
            request<T>(name: string, callback: () => Promise<T>): Promise<T>;
          };
        };
      }
    ).navigator?.locks;
    if (locks) {
      return locks.request(webLockName, runInProcess);
    }
    return runInProcess();
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
    await this.withStorageLock(async () => {
      const keys = await this.loadAllStrict();
      const index = keys.findIndex((k) => k.id === key.id);
      if (index >= 0) {
        keys[index] = key;
      } else {
        keys.push(key);
      }
      await this.persistAll(keys);
    });
  }

  /**
   * Retrieve a single session key by ID.
   */
  async get(id: string): Promise<StoredSessionKey | null> {
    const keys = await this.loadAllStrict();
    return keys.find((k) => k.id === id) ?? null;
  }

  /**
   * Remove a single session key by ID.
   */
  async remove(id: string): Promise<void> {
    await this.withStorageLock(async () => {
      const keys = await this.loadAllStrict();
      const filtered = keys.filter((k) => k.id !== id);
      await this.persistAll(filtered);
    });
  }

  /**
   * Update the status of a session key (active → revoked / expired).
   */
  async updateStatus(
    id: string,
    status: StoredSessionKey["status"],
  ): Promise<void> {
    await this.withStorageLock(async () => {
      const keys = await this.loadAllStrict();
      const key = keys.find((k) => k.id === id);
      if (!key) {
        throw createSessionKeyError("session_key_not_found", id);
      }
      key.status = status;
      await this.persistAll(keys);
    });
  }

  /**
   * Increment the usage counter for a session key.
   */
  async incrementUsage(
    id: string,
    tx?: { value?: string; gas?: string },
  ): Promise<void> {
    await this.withKeyLock(id, () => this.incrementUsageUnlocked(id, tx));
  }

  /** @internal Call only while holding withKeyLock for the same ID. */
  async incrementUsageUnlocked(
    id: string,
    tx?: { value?: string; gas?: string },
  ): Promise<void> {
    await this.withStorageLock(async () => {
      const keys = await this.loadAllStrict();
      const key = keys.find((k) => k.id === id);
      if (!key) {
        throw createSessionKeyError("session_key_not_found", id);
      }
      key.useCount += 1;
      key.lastUsedAt = Date.now();
      if (tx?.value) {
        key.accumulatedValue = (key.accumulatedValue ?? 0n) + BigInt(tx.value);
      }
      if (tx?.gas) {
        key.accumulatedGas = (key.accumulatedGas ?? 0n) + BigInt(tx.gas);
      }
      await this.persistAll(keys);
    });
  }

  /**
   * Remove all session keys.
   */
  async clear(): Promise<void> {
    await this.withStorageLock(() => this.adapter.remove(STORAGE_KEY));
  }
}

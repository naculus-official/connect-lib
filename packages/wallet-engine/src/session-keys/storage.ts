import { WalletError } from "../errors";
import type { TransactionRequest } from "../signers/types";
import { LocalStorageAdapter } from "../storage/local-storage";
import type { StorageAdapter } from "../storage/types";
import type {
  SessionKeyInfo,
  SessionKeyStatus,
  StoredSessionKey,
} from "./types";

/**
 * Session key storage manager.
 *
 * Stores encrypted session keys (AES-256-GCM via crypto.ts).
 * Default backend: localStorage. Override via constructor to use IndexedDB.
 *
 * ⚠️ localStorage is XSS-readable. However, session keys stored here are
 *     AES-256-GCM encrypted (see crypto.ts) with key derived from BIP39 seed.
 *     For production, pass an IndexedDbStorageAdapter to use origin-isolated storage.
 */

const DEFAULT_STORAGE_KEY = "naculus_session_keys";

/** Extract wallet seed from WalletData type (used to encrypt/decrypt session key) */
// wallet seed is obtained from PocketWallet's data.mnemonic

export class SessionKeyStorage {
  private _storage: StorageAdapter;
  private _storageKey: string;

  constructor(storage?: StorageAdapter, storageKey?: string) {
    this._storage =
      storage ?? new LocalStorageAdapter(storageKey ?? DEFAULT_STORAGE_KEY);
    // Override the storage key to use our own
    this._storageKey = storageKey ?? DEFAULT_STORAGE_KEY;
  }

  /** Check if localStorage is available */
  isAvailable(): boolean {
    return this._storage.isAvailable();
  }

  /** BigInt JSON reviver: converts "__bigint__" markers back to BigInt */
  private static _reviveBigInts(key: string, value: unknown): unknown {
    if (
      typeof value === "object" &&
      value !== null &&
      (value as any).__bigint__ === true
    ) {
      return BigInt((value as any).value as string);
    }
    return value;
  }

  /** BigInt JSON replacer: serializes BigInts as a marker object */
  private static _replaceBigInts(key: string, value: unknown): unknown {
    if (typeof value === "bigint") {
      return { __bigint__: true, value: value.toString() };
    }
    return value;
  }

  /** Load all stored session keys */
  async loadAll(): Promise<StoredSessionKey[]> {
    if (!this.isAvailable()) return [];

    try {
      // Use localStorage directly for our own key (StorageAdapter uses its own key)
      const raw = localStorage.getItem(this._storageKey);
      if (!raw) return [];

      const parsed = JSON.parse(raw, SessionKeyStorage._reviveBigInts);
      if (!Array.isArray(parsed)) return [];

      return parsed as StoredSessionKey[];
    } catch {
      return [];
    }
  }

  /** Save all session keys */
  private async saveAll(keys: StoredSessionKey[]): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      localStorage.setItem(
        this._storageKey,
        JSON.stringify(keys, SessionKeyStorage._replaceBigInts),
      );
    } catch (err) {
      throw new WalletError(
        "storage_quota",
        "Failed to save session keys to localStorage",
        err,
      );
    }
  }

  /** Read a single session key */
  async load(id: string): Promise<StoredSessionKey | null> {
    const keys = await this.loadAll();
    return keys.find((k) => k.id === id) ?? null;
  }

  /** Save a single session key (create or update) */
  async save(session: StoredSessionKey): Promise<void> {
    const keys = await this.loadAll();
    const idx = keys.findIndex((k) => k.id === session.id);
    if (idx >= 0) {
      keys[idx] = session;
    } else {
      keys.push(session);
    }
    await this.saveAll(keys);
  }

  /** Delete a specific session key */
  async delete(id: string): Promise<void> {
    const keys = await this.loadAll();
    const filtered = keys.filter((k) => k.id !== id);
    await this.saveAll(filtered);
  }

  /** Clear all session keys */
  async clear(): Promise<void> {
    if (!this.isAvailable()) return;
    localStorage.removeItem(this._storageKey);
  }

  /**
   * Get all active session keys (auto-cleanup expired ones).
   * Returns public info (no private keys).
   */
  async listActive(): Promise<SessionKeyInfo[]> {
    const keys = await this.loadAll();
    const now = Math.floor(Date.now() / 1000);

    // Mark and clean up expired
    let changed = false;
    for (const key of keys) {
      if (key.status === "active" && key.scope.expiry <= now) {
        key.status = "expired";
        changed = true;
      }
    }
    if (changed) {
      await this.saveAll(keys);
    }

    return keys
      .filter((k) => k.status === "active")
      .map((k) => ({
        id: k.id,
        publicKey: k.keyPair.publicKey,
        scope: k.scope,
        status: k.status as SessionKeyStatus,
        createdAt: k.createdAt,
        expiresAt: k.scope.expiry,
        useCount: k.useCount,
        signerAddress: k.authorization.signerAddress,
      }));
  }

  /**
   * Update session key usage count, timestamp, and accumulated value/gas tracking.
   *
   * @param id - Session key ID
   * @param tx - Executed transaction (for accumulating value and gas)
   */
  async recordUsage(id: string, tx?: TransactionRequest): Promise<void> {
    const keys = await this.loadAll();
    const key = keys.find((k) => k.id === id);
    if (!key) return;

    key.lastUsedAt = Date.now();
    key.useCount++;

    // Track accumulated value (only when value param exists)
    if (tx?.value) {
      const txValue = BigInt(tx.value);
      key.accumulatedValue = (key.accumulatedValue ?? 0n) + txValue;
    }

    // Track accumulated gas (only when gas param exists)
    if (tx?.gas) {
      const txGas = BigInt(tx.gas);
      key.accumulatedGas = (key.accumulatedGas ?? 0n) + txGas;
    }

    await this.saveAll(keys);
  }

  /** Mark session key as revoked */
  async markRevoked(id: string): Promise<void> {
    const keys = await this.loadAll();
    const key = keys.find((k) => k.id === id);
    if (!key) return;

    key.status = "revoked";
    await this.saveAll(keys);
  }

  /** Auto-cleanup expired session keys (physically remove records) */
  async autoCleanup(): Promise<number> {
    const keys = await this.loadAll();
    const now = Math.floor(Date.now() / 1000);

    const remaining = keys.filter((k) => {
      // Keep active and not expired
      if (k.status === "active" && k.scope.expiry > now) return true;
      // Keep revoked but still within validity (preserve revocation record)
      if (k.status === "revoked" && k.scope.expiry > now) return true;
      return false;
    });

    const cleanedCount = keys.length - remaining.length;
    if (cleanedCount > 0) {
      await this.saveAll(remaining);
    }

    return cleanedCount;
  }
}

import { WalletError } from "../errors";
import type { WalletData } from "../wallet";
import type { StorageAdapter } from "./types";

/**
 * Browser localStorage adapter for Pocket Wallet.
 *
 * ⚠️  SECURITY: Data is base64-encoded JSON (NOT encrypted).
 *     Mnemonic phrases are stored in plaintext reachable by XSS.
 *     For production use, wrap with EncryptedStorageAdapter (AES-256-GCM)
 *     or use IndexedDbStorageAdapter which has better origin isolation.
 *
 *     This adapter is the FALLBACK — only used when IndexedDB is unavailable.
 *     See storage/encrypted.ts for encrypted storage.
 */
export class LocalStorageAdapter implements StorageAdapter {
  readonly type = "localStorage" as const;
  private readonly key: string;

  constructor(key: string = "naculus_pocket") {
    this.key = key;
  }

  isAvailable(): boolean {
    try {
      const test = "__pocket_test__";
      localStorage.setItem(test, test);
      localStorage.removeItem(test);
      return true;
    } catch {
      return false;
    }
  }

  async load(): Promise<WalletData | null> {
    if (!this.isAvailable()) return null;
    const raw = localStorage.getItem(this.key);
    if (!raw) return null;
    try {
      return JSON.parse(atob(raw)) as WalletData;
    } catch {
      return null;
    }
  }

  async save(data: WalletData): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      localStorage.setItem(this.key, btoa(JSON.stringify(data)));
    } catch (err) {
      throw new WalletError(
        "storage_quota",
        "Failed to save wallet to localStorage",
        err,
      );
    }
  }

  async clear(): Promise<void> {
    if (!this.isAvailable()) return;
    localStorage.removeItem(this.key);
  }
}

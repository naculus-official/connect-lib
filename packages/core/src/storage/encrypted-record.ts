import { getEncryptedStorageAdapter } from "./encrypted-storage";
import type { StorageAdapter } from "../storage";

type EncryptedRecord = {
  version: 1;
  ciphertext: string;
};

/**
 * Encrypts JSON records while preserving the StorageAdapter contract.
 * Invalid or plaintext records are rejected when encryption is enabled so a
 * tampered value cannot silently downgrade the caller to plaintext storage.
 */
export class EncryptedRecordStorageAdapter implements StorageAdapter {
  private readonly cipher = getEncryptedStorageAdapter();
  private readonly key: Uint8Array;

  constructor(private readonly inner: StorageAdapter, encryptionKey: string) {
    this.key = new TextEncoder().encode(encryptionKey);
    if (this.key.length === 0) {
      throw new Error("Storage encryption key must not be empty");
    }
  }

  isAvailable(): boolean {
    return this.inner.isAvailable() && this.cipher.isAvailable();
  }

  async get<T>(key: string): Promise<T | null> {
    const record = await this.inner.get<EncryptedRecord>(key);
    if (record === null) return null;
    if (
      !record ||
      typeof record !== "object" ||
      record.version !== 1 ||
      typeof record.ciphertext !== "string"
    ) {
      throw new Error("Encrypted storage record is missing or corrupted");
    }

    const plaintext = await this.cipher.decrypt(record.ciphertext, this.key);
    return JSON.parse(plaintext) as T;
  }

  async set<T>(key: string, value: T): Promise<void> {
    const ciphertext = await this.cipher.encrypt(
      JSON.stringify(value),
      this.key,
    );
    await this.inner.set<EncryptedRecord>(key, {
      version: 1,
      ciphertext,
    });
  }

  remove(key: string): Promise<void> {
    return this.inner.remove(key);
  }

  clear(): Promise<void> {
    return this.inner.clear();
  }

  has(key: string): Promise<boolean> {
    return this.inner.has(key);
  }
}

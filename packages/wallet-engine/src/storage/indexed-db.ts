import { WalletError } from "../errors";
import type { WalletData } from "../wallet";
import type { StorageAdapter } from "./types";

const DB_NAME = "naculus_wallet";
const STORE_NAME = "wallets";
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(new WalletError("storage_unavailable", "IndexedDB open failed"));
  });
}

export class IndexedDbStorageAdapter implements StorageAdapter {
  readonly type = "indexedDb" as const;
  private readonly key: string;

  constructor(key: string = "naculus_pocket") {
    this.key = key;
  }

  isAvailable(): boolean {
    return typeof indexedDB !== "undefined";
  }

  async load(): Promise<WalletData | null> {
    if (!this.isAvailable()) return null;
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(this.key);
      req.onsuccess = () => resolve(req.result?.data ?? null);
      req.onerror = () =>
        reject(
          new WalletError(
            "storage_read_failed",
            "Failed to read from IndexedDB",
          ),
        );
    });
  }

  async save(data: WalletData): Promise<void> {
    if (!this.isAvailable()) return;
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.put({ id: this.key, data });
      req.onsuccess = () => resolve();
      req.onerror = () =>
        reject(
          new WalletError(
            "storage_write_failed",
            "Failed to write to IndexedDB",
          ),
        );
    });
  }

  async clear(): Promise<void> {
    if (!this.isAvailable()) return;
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(this.key);
      req.onsuccess = () => resolve();
      req.onerror = () =>
        reject(
          new WalletError(
            "storage_clear_failed",
            "Failed to clear from IndexedDB",
          ),
        );
    });
  }
}

import type { WalletData } from "../wallet";

export type StorageType =
  | "indexedDb"
  | "localStorage"
  | "encrypted"
  | "memory"
  | "custom";

/**
 * Storage security tier — single value for UI decision.
 *
 *   1 = IndexedDB + AES-GCM  (🔒 highest)
 *   2 = IndexedDB             (✅ default)
 *   3 = localStorage + AES-GCM(⚠️  encrypted but backend weak)
 *   4 = localStorage          (🚫 XSS-vulnerable, switch browser)
 */
export type StorageSecurityLevel = 1 | 2 | 3 | 4;

export interface StorageAdapter {
  /** Load wallet data from persistent storage */
  load(): Promise<WalletData | null>;
  /** Save wallet data to persistent storage */
  save(data: WalletData): Promise<void>;
  /** Remove wallet data from persistent storage */
  clear(): Promise<void>;
  /** Check if storage is available in current environment */
  isAvailable(): boolean;
  /** Human-readable storage type for UI display and security warnings */
  readonly type: StorageType;
}

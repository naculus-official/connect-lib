/**
 * TxHistoryStore — persistent storage for transaction history.
 *
 * Uses a StorageAdapter (same pattern as wallet.ts) with key format:
 *   naculus_tx_history:{chainId}:{hash} → JSON.stringify(TxStatusEntry)
 *
 * Maintains in-memory indices for fast querying by address, chainId, and status.
 * Supports TTL-based automatic cleanup.
 */

import type { TxHistoryQuery, TxStatus, TxStatusEntry } from "./types";

const HISTORY_KEY_PREFIX = "naculus_tx_history";
const MIN_CLEANUP_ENTRIES = 100;

/**
 * Minimal storage interface — compatible with wallet.ts StorageAdapter shape
 * but any object with getItem / setItem / removeItem works.
 */
export interface HistoryStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/** A simple in-memory storage fallback */
export class MemoryHistoryStorage implements HistoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

export class TxHistoryStore {
  private storage: HistoryStorage;

  /** In-memory indices for fast querying */
  private byAddress = new Map<string, Set<string>>();
  private byChain = new Map<number, Set<string>>();
  private byStatus = new Map<TxStatus, Set<string>>();
  private allKeys = new Set<string>();
  private indexed = false;

  constructor(storage?: HistoryStorage) {
    this.storage = storage ?? new MemoryHistoryStorage();
  }

  // ── Key helpers ─────────────────────────────────────────────────

  private makeKey(chainId: number, hash: string): string {
    return `${HISTORY_KEY_PREFIX}:${chainId}:${hash}`;
  }

  private parseKey(key: string): { chainId: number; hash: string } | null {
    const parts = key.split(":");
    if (parts.length < 3) return null;
    // parts[0] = "naculus_tx_history", parts[1] = chainId, parts[2] = hash
    const chainId = Number(parts[1]);
    if (isNaN(chainId)) return null;
    const hash = parts.slice(2).join(":"); // hash may contain colons? unlikely but safe
    return { chainId, hash };
  }

  // ── Index helpers ───────────────────────────────────────────────

  private ensureIndex(): void {
    if (this.indexed) return;
    this.indexed = true;
    // rebuild indices from all stored keys — will index lazily on first query
  }

  private addToIndexes(entry: TxStatusEntry): void {
    const key = this.makeKey(entry.chainId, entry.hash);
    this.allKeys.add(key);

    // by address
    if (entry.from) {
      const addrSet = this.byAddress.get(entry.from.toLowerCase()) ?? new Set();
      addrSet.add(key);
      this.byAddress.set(entry.from.toLowerCase(), addrSet);
    }
    if (entry.to && entry.to !== entry.from) {
      const addrSet = this.byAddress.get(entry.to.toLowerCase()) ?? new Set();
      addrSet.add(key);
      this.byAddress.set(entry.to.toLowerCase(), addrSet);
    }

    // by chain
    const chainSet = this.byChain.get(entry.chainId) ?? new Set();
    chainSet.add(key);
    this.byChain.set(entry.chainId, chainSet);

    // by status
    const statusSet = this.byStatus.get(entry.status) ?? new Set();
    statusSet.add(key);
    this.byStatus.set(entry.status, statusSet);
  }

  private removeFromIndexes(entry: TxStatusEntry): void {
    const key = this.makeKey(entry.chainId, entry.hash);
    this.allKeys.delete(key);

    const addrLower = entry.from.toLowerCase();
    const addrSet = this.byAddress.get(addrLower);
    if (addrSet) {
      addrSet.delete(key);
      if (addrSet.size === 0) this.byAddress.delete(addrLower);
    }

    const toLower = entry.to.toLowerCase();
    if (toLower !== addrLower) {
      const toSet = this.byAddress.get(toLower);
      if (toSet) {
        toSet.delete(key);
        if (toSet.size === 0) this.byAddress.delete(toLower);
      }
    }

    const chainSet = this.byChain.get(entry.chainId);
    if (chainSet) {
      chainSet.delete(key);
      if (chainSet.size === 0) this.byChain.delete(entry.chainId);
    }

    const statusSet = this.byStatus.get(entry.status);
    if (statusSet) {
      statusSet.delete(key);
      if (statusSet.size === 0) this.byStatus.delete(entry.status);
    }
  }

  // ── Public API ──────────────────────────────────────────────────

  async upsert(entry: TxStatusEntry): Promise<void> {
    const key = this.makeKey(entry.chainId, entry.hash);
    await this.storage.setItem(key, JSON.stringify(entry));
    this.addToIndexes(entry);
  }

  async get(hash: string, chainId?: number): Promise<TxStatusEntry | null> {
    // If chainId known, direct lookup
    if (chainId !== undefined) {
      const key = this.makeKey(chainId, hash);
      const raw = await this.storage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw) as TxStatusEntry;
    }

    // Otherwise scan — iterate all keys in our index matching this hash
    for (const key of this.allKeys) {
      const parsed = this.parseKey(key);
      if (parsed && parsed.hash === hash) {
        const raw = await this.storage.getItem(key);
        if (raw) return JSON.parse(raw) as TxStatusEntry;
      }
    }
    return null;
  }

  async query(filters?: TxHistoryQuery): Promise<TxStatusEntry[]> {
    this.ensureIndex();

    let candidateKeys = new Set(this.allKeys);

    // Apply index-based filtering
    if (filters?.address) {
      const addrLower = filters.address.toLowerCase();
      const fromKeys = this.byAddress.get(addrLower);
      const matched = new Set<string>();
      if (fromKeys) for (const k of fromKeys) matched.add(k);
      candidateKeys = matched;
    }

    if (filters?.chainId !== undefined) {
      const chainKeys = this.byChain.get(filters.chainId);
      const matched = new Set<string>();
      if (chainKeys)
        for (const k of chainKeys) {
          if (candidateKeys.has(k)) matched.add(k);
        }
      candidateKeys = matched;
    }

    if (filters?.status) {
      const statusKeys = this.byStatus.get(filters.status);
      const matched = new Set<string>();
      if (statusKeys)
        for (const k of statusKeys) {
          if (candidateKeys.has(k)) matched.add(k);
        }
      candidateKeys = matched;
    }

    // Load all candidate entries
    const entries: TxStatusEntry[] = [];
    for (const key of candidateKeys) {
      const raw = await this.storage.getItem(key);
      if (raw) {
        try {
          entries.push(JSON.parse(raw) as TxStatusEntry);
        } catch {
          // skip corrupt entries
        }
      }
    }

    // Apply date filters (post-filter, can't index date ranges easily)
    let filtered = entries;
    if (filters?.fromDate !== undefined) {
      filtered = filtered.filter((e) => e.createdAt >= filters.fromDate!);
    }
    if (filters?.toDate !== undefined) {
      filtered = filtered.filter((e) => e.createdAt <= filters.toDate!);
    }

    // Sort by createdAt desc
    filtered.sort((a, b) => b.createdAt - a.createdAt);

    // Apply pagination
    const offset = filters?.offset ?? 0;
    const limit = filters?.limit ?? filtered.length;

    return filtered.slice(offset, offset + limit);
  }

  async delete(hash: string, chainId?: number): Promise<void> {
    if (chainId !== undefined) {
      const key = this.makeKey(chainId, hash);
      const raw = await this.storage.getItem(key);
      if (raw) {
        const entry = JSON.parse(raw) as TxStatusEntry;
        this.removeFromIndexes(entry);
        await this.storage.removeItem(key);
      }
    } else {
      // Scan all keys
      for (const key of this.allKeys) {
        const parsed = this.parseKey(key);
        if (parsed && parsed.hash === hash) {
          const raw = await this.storage.getItem(key);
          if (raw) {
            const entry = JSON.parse(raw) as TxStatusEntry;
            this.removeFromIndexes(entry);
            await this.storage.removeItem(key);
          }
        }
      }
    }
  }

  async cleanup(retentionDays: number): Promise<number> {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const keysToDelete: string[] = [];

    for (const key of this.allKeys) {
      const raw = await this.storage.getItem(key);
      if (raw) {
        try {
          const entry = JSON.parse(raw) as TxStatusEntry;
          if (entry.createdAt < cutoff) {
            keysToDelete.push(key);
          }
        } catch {
          // corrupt entry — also delete
          keysToDelete.push(key);
        }
      }
    }

    // Skip cleanup if under 100 entries total
    if (
      this.allKeys.size < MIN_CLEANUP_ENTRIES &&
      keysToDelete.length < this.allKeys.size
    ) {
      return 0;
    }

    for (const key of keysToDelete) {
      const raw = await this.storage.getItem(key);
      if (raw) {
        try {
          const entry = JSON.parse(raw) as TxStatusEntry;
          this.removeFromIndexes(entry);
        } catch {
          // can't parse, just remove from allKeys
          this.allKeys.delete(key);
        }
      }
      await this.storage.removeItem(key);
    }

    return keysToDelete.length;
  }

  async getAllHashes(
    chainId?: number,
  ): Promise<Array<{ hash: string; chainId: number }>> {
    const results: Array<{ hash: string; chainId: number }> = [];
    for (const key of this.allKeys) {
      const parsed = this.parseKey(key);
      if (parsed) {
        if (chainId !== undefined && parsed.chainId !== chainId) continue;
        results.push(parsed);
      }
    }
    return results;
  }

  async count(): Promise<number> {
    return this.allKeys.size;
  }
}

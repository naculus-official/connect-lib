/**
 * TxMonitor — transaction lifecycle monitor.
 *
 * Manages the full lifecycle of EVM transactions:
 *   unknown → pending → mined → confirmed → (optional: pending on reorg)
 *                      → failed
 *
 * Uses TxPoller for polling and TxHistoryStore for persistence.
 * Emits events on state transitions.
 */

import { TxPoller } from "./poller";
import { TxHistoryStore } from "./TxHistoryStore";
import type {
  ProviderLike,
  TxHistoryQuery,
  TxStatus,
  TxStatusEntry,
  WatchEntry,
  WatchTxOptions,
} from "./types";

const DEFAULT_REQUIRED_CONFIRMATIONS = 1;
const DEFAULT_RETENTION_DAYS = 30;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

type EventMap = {
  statusChange: [entry: TxStatusEntry];
  confirmed: [entry: TxStatusEntry];
  failed: [entry: TxStatusEntry, reason: string];
  reorg: [hash: string, oldBlock: number | null, newBlock: number | null];
  replaced: [oldHash: string, newHash: string, nonce: number];
};

type Listener<T extends any[]> = (...args: T) => void;

export interface TxMonitorOptions {
  /** Get JSON-RPC provider for a chain */
  getProvider: (chainId: number) => ProviderLike;
  /** Default required confirmations (default: 1) */
  defaultRequiredConfirmations?: number;
  /** Default polling interval ms (default: 15000) */
  defaultPollInterval?: number;
  /** Auto-cleanup expired entries (default: true) */
  autoCleanup?: boolean;
  /** Entry retention days (default: 30) */
  retentionDays?: number;
  /** Custom history store */
  historyStore?: TxHistoryStore;
}

export class TxMonitor {
  private options: Required<TxMonitorOptions>;
  private poller: TxPoller;
  private store: TxHistoryStore;
  private watchers = new Map<string, WatchEntry>();
  private statuses = new Map<string, TxStatusEntry>();

  // Event listeners
  private listeners = new Map<string, Set<Listener<any[]>>>();

  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  constructor(options: TxMonitorOptions) {
    this.options = {
      getProvider: options.getProvider,
      defaultRequiredConfirmations:
        options.defaultRequiredConfirmations ?? DEFAULT_REQUIRED_CONFIRMATIONS,
      defaultPollInterval: options.defaultPollInterval ?? 15_000,
      autoCleanup: options.autoCleanup ?? true,
      retentionDays: options.retentionDays ?? DEFAULT_RETENTION_DAYS,
      historyStore: options.historyStore ?? new TxHistoryStore(),
    };

    this.store = this.options.historyStore;

    this.poller = new TxPoller(
      this.options.getProvider,
      this.options.defaultPollInterval,
    );
  }

  // ── Event Emitter ───────────────────────────────────────────────

  on<E extends keyof EventMap>(
    event: E,
    listener: Listener<EventMap[E]>,
  ): this {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  off<E extends keyof EventMap>(
    event: E,
    listener: Listener<EventMap[E]>,
  ): this {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(event);
    }
    return this;
  }

  private emit<E extends keyof EventMap>(event: E, ...args: EventMap[E]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const listener of set) {
        try {
          (listener as Function)(...args);
        } catch {
          // Silently ignore listener errors
        }
      }
    }
  }

  // ── Core API ────────────────────────────────────────────────────

  async watchTx(
    hash: string,
    chainId: number,
    watchOptions?: WatchTxOptions,
  ): Promise<TxStatusEntry> {
    const key = `${chainId}:${hash}`;
    if (this.watchers.has(key)) {
      // Already watching, return current status
      const existing = this.statuses.get(key);
      if (existing) return existing;
    }

    // Merge options with defaults
    const options: Required<WatchTxOptions> = {
      requiredConfirmations:
        watchOptions?.requiredConfirmations ??
        this.options.defaultRequiredConfirmations,
      pollInterval:
        watchOptions?.pollInterval ?? this.options.defaultPollInterval,
      label: watchOptions?.label ?? "",
      memo: watchOptions?.memo ?? "",
      initialEntry: watchOptions?.initialEntry ?? {},
    };

    // Try to load from history store first
    const stored = await this.store.get(hash, chainId);

    let entry: TxStatusEntry;
    if (stored) {
      entry = { ...stored };
      // If stored was terminal confirmed/failed, don't re-watch
      if (entry.status === "confirmed" || entry.status === "failed") {
        this.statuses.set(key, entry);
        return entry;
      }
      // Reset to pending for re-watch
      if (entry.status === "mined") {
        // Keep mined, continue watching for confirmations
      } else {
        entry.status = "unknown";
      }
      entry.updatedAt = Date.now();
    } else {
      // Create new entry
      const now = Date.now();
      entry = {
        hash,
        chainId,
        from: options.initialEntry?.from ?? "",
        to: options.initialEntry?.to ?? "",
        value: options.initialEntry?.value ?? "0x0",
        data: options.initialEntry?.data,
        nonce: options.initialEntry?.nonce,
        status: "unknown",
        createdAt: now,
        updatedAt: now,
        replacementCount: 0,
      };
    }

    // Save initial entry and register watcher
    this.statuses.set(key, entry);
    await this.store.upsert(entry);

    const watchEntry: WatchEntry = {
      hash,
      chainId,
      options,
      backoffCount: 0,
      lastPollAt: 0,
      consecutiveStable: 0,
    };
    this.watchers.set(key, watchEntry);

    // Start polling
    this.poller.startPolling(
      hash,
      chainId,
      (update) => this.handleStatusUpdate(key, update),
      (error) => this.handlePollError(key, error),
      options.pollInterval,
    );

    return entry;
  }

  stopWatching(hash: string, chainId?: number): void {
    if (chainId !== undefined) {
      const key = `${chainId}:${hash}`;
      this.poller.stopPolling(hash, chainId);
      this.watchers.delete(key);
    } else {
      // Scan all watchers
      for (const [key, w] of this.watchers) {
        if (w.hash === hash) {
          this.poller.stopPolling(hash, w.chainId);
          this.watchers.delete(key);
        }
      }
    }
  }

  stopWatchingByChain(chainId: number): void {
    const keysToRemove: string[] = [];
    for (const [key, w] of this.watchers) {
      if (w.chainId === chainId) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      const w = this.watchers.get(key);
      if (w) {
        this.poller.stopPolling(w.hash, chainId);
        this.watchers.delete(key);
      }
    }
  }

  getTxStatus(hash: string, chainId?: number): TxStatusEntry | null {
    if (chainId !== undefined) {
      return this.statuses.get(`${chainId}:${hash}`) ?? null;
    }
    // Scan all
    for (const [, entry] of this.statuses) {
      if (entry.hash === hash) return entry;
    }
    return null;
  }

  async getTxHistory(
    address?: string,
    chainId?: number,
  ): Promise<TxStatusEntry[]> {
    const query: TxHistoryQuery = {};
    if (address) query.address = address;
    if (chainId !== undefined) query.chainId = chainId;
    return this.store.query(query);
  }

  async refreshTx(hash: string, chainId?: number): Promise<void> {
    // Determine chainId
    let effectiveChainId = chainId;
    if (effectiveChainId === undefined) {
      for (const [, w] of this.watchers) {
        if (w.hash === hash) {
          effectiveChainId = w.chainId;
          break;
        }
      }
    }
    if (effectiveChainId === undefined) {
      // Try history store
      const entry = await this.store.get(hash);
      if (entry) {
        effectiveChainId = entry.chainId;
      }
    }
    if (effectiveChainId !== undefined) {
      await this.poller.pollNow(hash, effectiveChainId);
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  start(): void {
    if (this._running) return;
    this._running = true;

    // Schedule cleanup
    if (this.options.autoCleanup) {
      // Run cleanup immediately
      this.runCleanup().catch(() => {});
      // Then schedule
      this.cleanupTimer = setInterval(() => {
        this.runCleanup().catch(() => {});
      }, CLEANUP_INTERVAL_MS);
    }
  }

  stop(): void {
    this._running = false;
    this.poller.stopAll();

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.watchers.clear();
  }

  async clearHistory(): Promise<void> {
    const hashes = await this.store.getAllHashes();
    for (const { hash, chainId } of hashes) {
      await this.store.delete(hash, chainId);
    }
  }

  // ── Internal status handling ────────────────────────────────────

  private async handleStatusUpdate(
    key: string,
    update: Partial<TxStatusEntry>,
  ): Promise<void> {
    const current = this.statuses.get(key);
    if (!current) return;

    const prevStatus = current.status;
    const newStatus = update.status ?? prevStatus;
    const isReorg = prevStatus !== "pending" && newStatus === "pending";

    // Merge update into current
    Object.assign(current, update, { updatedAt: Date.now() });

    // Handle reorg
    if (isReorg) {
      this.emit(
        "reorg",
        current.hash,
        current.blockNumber ?? null,
        update.blockNumber ?? null,
      );
      current.blockNumber = undefined;
      current.blockHash = undefined;
    }

    // Handle state transition
    if (prevStatus !== newStatus) {
      // Emit status change
      this.emit("statusChange", { ...current });

      if (newStatus === "confirmed") {
        current.confirmedAt = Date.now();
        this.emit("confirmed", { ...current });
      } else if (newStatus === "failed") {
        this.emit("failed", { ...current }, update.error ?? "Unknown error");
      }

      // Stop watching on terminal states
      if (newStatus === "confirmed" || newStatus === "failed") {
        const w = this.watchers.get(key);
        if (w) {
          this.poller.stopPolling(w.hash, w.chainId);
          this.watchers.delete(key);
        }
      }
    }

    // Persist
    await this.store.upsert({ ...current });
  }

  private handlePollError(key: string, error: Error): void {
    const current = this.statuses.get(key);
    if (!current) return;
    current.error = error.message;
    current.updatedAt = Date.now();

    // Emit status change with error
    this.emit("statusChange", { ...current });
    this.store.upsert({ ...current }).catch(() => {});
  }

  private async runCleanup(): Promise<void> {
    const deleted = await this.store.cleanup(this.options.retentionDays);
    if (deleted > 0) {
      // Cleanup in-memory statuses too
      const allHashes = await this.store.getAllHashes();
      const validKeys = new Set(allHashes.map((h) => `${h.chainId}:${h.hash}`));

      for (const [key] of this.statuses) {
        if (!validKeys.has(key)) {
          this.statuses.delete(key);
        }
      }
    }
  }

  // ── Testing helpers ─────────────────────────────────────────────

  /** For testing: get the underlying store */
  _getStore(): TxHistoryStore {
    return this.store;
  }

  /** For testing: get the poller */
  _getPoller(): TxPoller {
    return this.poller;
  }

  /** For testing: get active watcher count */
  _watcherCount(): number {
    return this.watchers.size;
  }
}

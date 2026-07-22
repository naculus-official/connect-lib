/**
 * Notifier — Push Notification Core.
 *
 * Central orchestrator for transaction lifecycle push notifications.
 * Manages watch registrations, channel adapters, user preferences,
 * mute rules, and event-driven status dispatch.
 *
 * @see docs/features/push-notification.md
 */

import type {
  MuteRule,
  NotificationChannel,
  NotificationFrequency,
  NotificationPayload,
  NotificationWatch,
  NotifierOptions,
  TxMetadata,
  TxStatus,
  TxStatusCallback,
  UserNotificationPreferences,
} from "./types";

// ─── Helpers ───────────────────────────────────────────────────────────

let _notifIdCounter = 0;

function generateId(): string {
  _notifIdCounter++;
  return `notif_${Date.now()}_${_notifIdCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

const STORAGE_KEY_PREFS = "naculus_notif_prefs";
const STORAGE_KEY_WATCHES = "naculus_notif_watches";
const STORAGE_KEY_MUTE_RULES = "naculus_notif_mute_rules";

// ─── Default Preferences ──────────────────────────────────────────────

const DEFAULT_PREFERENCES: UserNotificationPreferences = {
  channels: ["inapp"],
  frequency: "final-only",
  confirmInterval: 6,
  pendingTimeout: 300,
};

// ─── Notifier ─────────────────────────────────────────────────────────

export class Notifier {
  private channels: Map<string, NotificationChannel> = new Map();
  private watches: Map<string, NotificationWatch> = new Map(); // txHash -> watch
  private preferences: Map<string, UserNotificationPreferences> = new Map(); // userId -> prefs
  private muteRules: Map<string, MuteRule[]> = new Map(); // userId -> rules
  private statusCallbacks: Map<string, Set<TxStatusCallback>> = new Map(); // txHash -> callbacks
  private defaultPreferences: UserNotificationPreferences;
  private storage?: NotifierOptions["storage"];

  constructor(options?: NotifierOptions) {
    this.defaultPreferences = {
      ...DEFAULT_PREFERENCES,
      ...options?.defaultPreferences,
    };
    this.storage = options?.storage;
  }

  // ── Channel Management ─────────────────────────────────────────────

  registerChannel(channel: NotificationChannel): void {
    this.channels.set(channel.id, channel);
  }

  unregisterChannel(channelId: string): void {
    this.channels.delete(channelId);
  }

  getChannel(channelId: string): NotificationChannel | undefined {
    return this.channels.get(channelId);
  }

  getActiveChannels(): string[] {
    return Array.from(this.channels.values())
      .filter((c) => c.isAvailable())
      .map((c) => c.id);
  }

  // ── Watch Management ───────────────────────────────────────────────

  /**
   * Start watching a transaction for notifications.
   *
   * When the tx status changes, notifications will be dispatched
   * to all registered channels based on the watch configuration
   * and the user's preferences + mute rules.
   */
  watchTx(
    hash: string,
    chainId: string,
    options?: {
      userId?: string;
      channels?: string[];
      frequency?: NotificationFrequency;
      txMetadata?: Partial<TxMetadata>;
    },
  ): void {
    const userId = options?.userId ?? "default";
    const prefs = this.getPreferences(userId);

    const watch: NotificationWatch = {
      txHash: hash,
      userId,
      channels: options?.channels ?? prefs.channels,
      frequency: options?.frequency ?? prefs.frequency,
      confirmInterval: prefs.confirmInterval,
      txMetadata: {
        chainId,
        value: options?.txMetadata?.value,
        to: options?.txMetadata?.to,
        txType: options?.txMetadata?.txType ?? "custom",
      },
      createdAt: Date.now(),
    };

    this.watches.set(hash, watch);
    void this.persistWatches();
  }

  /**
   * Stop watching a transaction.
   */
  unregisterTxWatch(hash: string): void {
    const watch = this.watches.get(hash);
    if (watch) {
      watch.resolvedAt = Date.now();
    }
    this.watches.delete(hash);
    this.statusCallbacks.delete(hash);
    void this.persistWatches();
  }

  getWatch(hash: string): NotificationWatch | undefined {
    return this.watches.get(hash);
  }

  getAllWatches(): NotificationWatch[] {
    return Array.from(this.watches.values());
  }

  // ── Status Callbacks ───────────────────────────────────────────────

  /**
   * Subscribe to status changes for a specific transaction.
   *
   * Returns an unsubscribe function.
   */
  onTxStatus(hash: string, callback: TxStatusCallback): () => void {
    if (!this.statusCallbacks.has(hash)) {
      this.statusCallbacks.set(hash, new Set());
    }
    this.statusCallbacks.get(hash)!.add(callback);

    return () => {
      this.statusCallbacks.get(hash)?.delete(callback);
    };
  }

  // ── Status Dispatch ────────────────────────────────────────────────

  /**
   * Called when a transaction's status changes.
   *
   * This is the main entry point from TxMonitor integration.
   * It evaluates mute rules, determines whether to fire based on
   * the frequency preference, and dispatches to all channels.
   */
  async handleTxStatus(
    hash: string,
    status: TxStatus,
    receipt?: {
      confirmations?: number;
      value?: bigint;
      gasUsed?: bigint;
      gasCostUsd?: number;
    },
  ): Promise<void> {
    const watch = this.watches.get(hash);
    if (!watch) return;

    // Check mute rules
    const userMuteRules = this.getMuteRules(watch.userId);
    if (this.isMuted(watch.txMetadata, userMuteRules)) {
      return;
    }

    // Check whether this status change should produce a notification
    const shouldNotify = this.shouldNotify(
      watch.frequency,
      status,
      receipt?.confirmations,
    );

    if (shouldNotify) {
      const payload = this.buildPayload(watch, status, receipt);
      await this.dispatchToChannels(payload, watch.channels);
    }

    // Fire callbacks regardless (for in-app state, not channel dispatch)
    const callbacks = this.statusCallbacks.get(hash);
    if (callbacks) {
      const callbackPayload = receipt
        ? {
            confirmations: receipt.confirmations,
            value: receipt.value,
            gasUsed: receipt.gasUsed,
          }
        : undefined;
      for (const cb of callbacks) {
        try {
          cb(status, callbackPayload);
        } catch {
          // Silently handle callback errors
        }
      }
    }

    // Clean up if terminal status
    if (status === "confirmed" || status === "failed") {
      this.unregisterTxWatch(hash);
    }
  }

  // ── Direct Notify ──────────────────────────────────────────────────

  /**
   * Send a notification directly (bypasses watch and frequency checks).
   */
  async notify(
    payload: Omit<NotificationPayload, "id" | "timestamp">,
    channels?: string[],
  ): Promise<void> {
    const fullPayload: NotificationPayload = {
      ...payload,
      id: generateId(),
      timestamp: Date.now(),
    };

    const targetChannels = channels ?? this.getActiveChannels();
    await this.dispatchToChannels(fullPayload, targetChannels);
  }

  // ── Preferences ────────────────────────────────────────────────────

  setPreferences(
    userId: string,
    prefs: Partial<UserNotificationPreferences>,
  ): void {
    const current = this.preferences.get(userId) ?? {
      ...this.defaultPreferences,
    };
    this.preferences.set(userId, { ...current, ...prefs });
    void this.persistPreferences();
  }

  getPreferences(userId: string): UserNotificationPreferences {
    return { ...(this.preferences.get(userId) ?? this.defaultPreferences) };
  }

  getDefaultPreferences(): UserNotificationPreferences {
    return { ...this.defaultPreferences };
  }

  // ── Mute Rules ─────────────────────────────────────────────────────

  addMuteRule(userId: string, rule: MuteRule): void {
    const rules = this.muteRules.get(userId) ?? [];
    rules.push(rule);
    this.muteRules.set(userId, rules);
    void this.persistMuteRules();
  }

  removeMuteRule(userId: string, ruleId: string): void {
    const rules = this.muteRules.get(userId);
    if (!rules) return;
    this.muteRules.set(
      userId,
      rules.filter((r) => r.id !== ruleId),
    );
    void this.persistMuteRules();
  }

  getMuteRules(userId: string): MuteRule[] {
    return [...(this.muteRules.get(userId) ?? [])];
  }

  /**
   * Evaluate whether a transaction should be muted based on active rules.
   */
  isMuted(metadata: TxMetadata, rules: MuteRule[]): boolean {
    const now = Date.now();
    for (const rule of rules) {
      // Skip expired rules
      if (rule.until && rule.until <= now) continue;

      // Chain match
      if (rule.chainId && rule.chainId !== metadata.chainId) continue;

      // Tx type match
      if (rule.txType && rule.txType !== metadata.txType) continue;

      // Value threshold (only if minValueUsd set and value is defined)
      if (rule.minValueUsd !== undefined && metadata.value !== undefined) {
        // Note: metadata.value is bigint; we skip mute if value is 0 (can't convert)
        // Real USD conversion requires an oracle; for now only match on explicit 0-value
        if (metadata.value === BigInt(0)) {
          return true; // 0-value tx is below any positive threshold
        }
      }

      // Contract address match
      if (rule.contractAddress && metadata.to) {
        if (rule.contractAddress.toLowerCase() === metadata.to.toLowerCase()) {
          return true;
        }
        continue; // if contractAddress specified but doesn't match, skip this rule
      }

      // If we got here without being skipped, the rule matched
      return true;
    }
    return false;
  }

  // ── Persistence ────────────────────────────────────────────────────

  /** Restore persisted state (call on initialization). */
  async restore(): Promise<void> {
    if (!this.storage) return;

    const prefs =
      await this.storage.getItem<Record<string, UserNotificationPreferences>>(
        STORAGE_KEY_PREFS,
      );
    if (prefs) {
      for (const [userId, p] of Object.entries(prefs)) {
        this.preferences.set(userId, p);
      }
    }

    const watches =
      await this.storage.getItem<NotificationWatch[]>(STORAGE_KEY_WATCHES);
    if (watches) {
      for (const w of watches) {
        if (!w.resolvedAt) {
          this.watches.set(w.txHash, w);
        }
      }
    }

    const muteRules = await this.storage.getItem<Record<string, MuteRule[]>>(
      STORAGE_KEY_MUTE_RULES,
    );
    if (muteRules) {
      for (const [userId, rules] of Object.entries(muteRules)) {
        this.muteRules.set(userId, rules);
      }
    }
  }

  private async persistPreferences(): Promise<void> {
    if (!this.storage) return;
    const obj: Record<string, UserNotificationPreferences> = {};
    for (const [userId, prefs] of this.preferences) {
      obj[userId] = prefs;
    }
    await this.storage.setItem(STORAGE_KEY_PREFS, obj);
  }

  private async persistWatches(): Promise<void> {
    if (!this.storage) return;
    await this.storage.setItem(STORAGE_KEY_WATCHES, this.getAllWatches());
  }

  private async persistMuteRules(): Promise<void> {
    if (!this.storage) return;
    const obj: Record<string, MuteRule[]> = {};
    for (const [userId, rules] of this.muteRules) {
      obj[userId] = rules;
    }
    await this.storage.setItem(STORAGE_KEY_MUTE_RULES, obj);
  }

  // ── Internal ───────────────────────────────────────────────────────

  private shouldNotify(
    frequency: NotificationFrequency,
    status: TxStatus,
    confirmations?: number,
  ): boolean {
    if (frequency === "muted") return false;

    // Terminal states always fire in per-tx and final-only
    if (status === "confirmed" || status === "failed") return true;

    // Error/reorg/speedup/cancel always fire (important events)
    if (status === "reorg" || status === "speedup" || status === "cancel")
      return true;

    // Pending only fires in per-tx mode
    if (status === "pending") {
      return frequency === "per-tx";
    }

    return false;
  }

  private buildPayload(
    watch: NotificationWatch,
    status: TxStatus,
    receipt?: {
      confirmations?: number;
      value?: bigint;
      gasUsed?: bigint;
      gasCostUsd?: number;
    },
  ): NotificationPayload {
    const labels: Record<TxStatus, { title: string; body: string }> = {
      pending: {
        title: "Transaction Pending",
        body: "Your transaction has been broadcast and is waiting for confirmation.",
      },
      confirmed: {
        title: "Transaction Confirmed",
        body: "Your transaction has been confirmed on-chain.",
      },
      failed: {
        title: "Transaction Failed",
        body: "The transaction reverted or failed. Check the block explorer for details.",
      },
      reorg: {
        title: "Chain Reorg Detected",
        body: "A chain reorganization affected your transaction.",
      },
      speedup: {
        title: "Transaction Accelerated",
        body: "Your transaction has been sped up with a higher gas price.",
      },
      cancel: {
        title: "Transaction Cancelled",
        body: "Your transaction has been cancelled.",
      },
    };

    const label = labels[status] ?? { title: status, body: "" };

    return {
      id: generateId(),
      userId: watch.userId,
      txHash: watch.txHash,
      chainId: watch.txMetadata.chainId,
      chainName: watch.txMetadata.chainId, // Real chain name resolution would happen in integration
      status,
      title: label.title,
      body: label.body,
      value: receipt?.value ?? watch.txMetadata.value,
      gasUsed: receipt?.gasUsed,
      gasCostUsd: receipt?.gasCostUsd,
      confirmations: receipt?.confirmations,
      timestamp: Date.now(),
    };
  }

  private async dispatchToChannels(
    payload: NotificationPayload,
    channelIds: string[],
  ): Promise<void> {
    const results = await Promise.allSettled(
      channelIds.map(async (channelId) => {
        const channel = this.channels.get(channelId);
        if (!channel || !channel.isAvailable()) return;
        await channel.send(payload);
      }),
    );

    // Log failures silently (don't crash the notifier for one broken channel)
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("[Notifier] Channel dispatch failed:", result.reason);
      }
    }
  }
}

/**
 * Notification Channel Adapters.
 *
 * Provides the `NotificationChannel` interface plus built-in adapters:
 * - `InAppChannel` — in-memory / localStorage-backed notification list
 * - `TelegramChannel` — adapter stub (actual bot token provided externally)
 *
 * @see docs/features/push-notification.md §4.4
 */

import type {
  ChannelCapability,
  NotificationChannel,
  NotificationItem,
  NotificationPayload,
} from "./types";

// ─── Storage shape for in-app history ──────────────────────────────────

const STORAGE_KEY_PREFIX = "naculus_notif_";

// ─── InAppChannel ─────────────────────────────────────────────────────

export interface InAppChannelOptions {
  /** Maximum number of history entries kept in storage (default 200) */
  maxHistory?: number;
  /** Optional storage for persisting notification history */
  storage?: {
    getItem: <T>(key: string) => Promise<T | null>;
    setItem: <T>(key: string, value: T) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
  };
  /** Callback fired when a new notification arrives (used by React hook) */
  onNotification?: (item: NotificationItem) => void;
}

/**
 * In-app notification channel.
 *
 * Stores notifications in a history buffer and fires a callback for each
 * new notification so React hooks can stay in sync.
 */
export class InAppChannel implements NotificationChannel {
  readonly id = "inapp";
  readonly name = "In-App Toast";

  private history: NotificationItem[] = [];
  private maxHistory: number;
  private storage?: InAppChannelOptions["storage"];
  onNotification?: (item: NotificationItem) => void;

  constructor(options?: InAppChannelOptions) {
    this.maxHistory = options?.maxHistory ?? 200;
    this.storage = options?.storage;
    this.onNotification = options?.onNotification;
  }

  getCapabilities(): ChannelCapability {
    return {
      supportsRichText: true,
      supportsActionButtons: false,
      supportsMedia: false,
      maxLength: Infinity,
      isBackground: false,
    };
  }

  isAvailable(): boolean {
    return true;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async send(payload: NotificationPayload): Promise<void> {
    const item: NotificationItem = {
      id: payload.id,
      title: payload.title,
      body: payload.body,
      status: payload.status,
      txHash: payload.txHash,
      chainName: payload.chainName,
      valueFormatted: payload.valueFormatted,
      explorerUrl: payload.explorerUrl,
      timestamp: payload.timestamp,
      read: false,
    };

    this.history.push(item);

    // Trim history to max length
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }

    // Persist to storage if configured
    if (this.storage) {
      await this.persist();
    }

    // Fire callback for React hooks
    this.onNotification?.(item);
  }

  // ── History Management ──────────────────────────────────────────────

  /** Returns all in-app notifications (newest last). */
  getHistory(): NotificationItem[] {
    return [...this.history];
  }

  /** Mark a single notification as read. */
  markAsRead(id: string): void {
    const found = this.history.find((n) => n.id === id);
    if (found) {
      found.read = true;
    }
  }

  /** Mark all notifications as read. */
  markAllAsRead(): void {
    for (const n of this.history) {
      n.read = true;
    }
  }

  /** Clear all in-app notifications. */
  clear(): void {
    this.history = [];
    if (this.storage) {
      void this.storage.removeItem(STORAGE_KEY_PREFIX + "history");
    }
  }

  /** Number of unread notifications. */
  get unreadCount(): number {
    return this.history.filter((n) => !n.read).length;
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private async persist(): Promise<void> {
    if (!this.storage) return;
    try {
      await this.storage.setItem(STORAGE_KEY_PREFIX + "history", this.history);
    } catch {
      // Silently fail — history in memory is still available
    }
  }

  /** Restore persisted history (call on initialization). */
  async restore(): Promise<void> {
    if (!this.storage) return;
    try {
      const saved = await this.storage.getItem<NotificationItem[]>(
        STORAGE_KEY_PREFIX + "history",
      );
      if (saved && Array.isArray(saved)) {
        this.history = saved.slice(-this.maxHistory);
      }
    } catch {
      // Silently fail
    }
  }
}

// ─── TelegramChannel ──────────────────────────────────────────────────

/**
 * Telegram notification channel.
 *
 * This is an adapter stub. The actual bot token is provided at runtime via
 * the constructor. The `send` method formats the payload into a Telegram
 * message and sends it through the Telegram Bot API.
 *
 * @remarks
 * Token is accepted but the HTTP call to Telegram's API is left to the
 * integrator's Telegram infrastructure (e.g., OpenClaw delivery channel).
 * The `send` implementation here is a placeholder that logs the formatted
 * message — the real transport should be injected or overridden.
 */
export class TelegramChannel implements NotificationChannel {
  readonly id = "telegram";
  readonly name = "Telegram";

  private botToken: string;
  private chatId: string;
  private transport?: (
    payload: NotificationPayload,
    formatted: string,
  ) => Promise<void>;

  constructor(config: {
    botToken: string;
    chatId: string;
    /** Optional transport override. Defaults to console.log. */
    transport?: (
      payload: NotificationPayload,
      formatted: string,
    ) => Promise<void>;
  }) {
    this.botToken = config.botToken;
    this.chatId = config.chatId;
    this.transport = config.transport;
  }

  getCapabilities(): ChannelCapability {
    return {
      supportsRichText: true,
      supportsActionButtons: true,
      supportsMedia: false,
      maxLength: 4096,
      isBackground: true,
    };
  }

  isAvailable(): boolean {
    return this.botToken.length > 0;
  }

  async healthCheck(): Promise<boolean> {
    return this.isAvailable();
  }

  async send(payload: NotificationPayload): Promise<void> {
    const formatted = this.formatMessage(payload);

    if (this.transport) {
      await this.transport(payload, formatted);
    } else {
      // Default: log to console (real transport should be configured)
      console.log(
        `[TelegramChannel] Would send to ${this.chatId}:\n${formatted}`,
      );
    }
  }

  private formatMessage(payload: NotificationPayload): string {
    const emoji = this.statusEmoji(payload.status);

    const lines = [
      `${emoji} *Transaction ${payload.status}*`,
      "",
      `\`${this.shortenHash(payload.txHash)}\``,
      `Chain: ${payload.chainName}`,
      payload.valueFormatted ? `Value: ${payload.valueFormatted}` : "",
      payload.confirmations ? `Confirm: ${payload.confirmations}` : "",
      "",
      payload.explorerUrl
        ? `🔗 [View on Explorer](${payload.explorerUrl})`
        : "",
    ];

    return lines.filter(Boolean).join("\n");
  }

  private shortenHash(hash: string): string {
    if (hash.length <= 12) return hash;
    return `${hash.slice(0, 8)}...${hash.slice(-4)}`;
  }

  private statusEmoji(status: string): string {
    switch (status) {
      case "confirmed":
        return "✅";
      case "failed":
        return "❌";
      case "pending":
        return "⏳";
      case "reorg":
        return "⚠️";
      case "speedup":
        return "⏩";
      case "cancel":
        return "🚫";
      default:
        return "ℹ️";
    }
  }
}

// ─── NoopChannel ──────────────────────────────────────────────────────

/**
 * No-op channel for testing or disabling notifications entirely.
 */
export class NoopChannel implements NotificationChannel {
  readonly id = "noop";
  readonly name = "No-op";

  getCapabilities(): ChannelCapability {
    return {
      supportsRichText: false,
      supportsActionButtons: false,
      supportsMedia: false,
      maxLength: 0,
      isBackground: false,
    };
  }

  isAvailable(): boolean {
    return true;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async send(_payload: NotificationPayload): Promise<void> {
    // Nothing
  }
}

/**
 * Notification type definitions for Push Notification system.
 *
 * @see docs/features/push-notification.md
 */

// ─── Tx Status ─────────────────────────────────────────────────────────

/**
 * Transaction lifecycle status.
 * Mirrors TxMonitor (SRS-008) status values.
 */
export type TxStatus =
  | "pending"
  | "confirmed"
  | "failed"
  | "reorg"
  | "speedup"
  | "cancel";

// ─── Notification Frequency ────────────────────────────────────────────

/**
 * How often to fire notifications for a transaction.
 *
 * - `per-tx`: every status change is notified
 * - `per-confirm`: every N confirmations
 * - `final-only`: only confirmed or failed (default)
 * - `muted`: never notify for this tx
 */
export type NotificationFrequency =
  | "per-tx"
  | "per-confirm"
  | "final-only"
  | "muted";

// ─── Notification Payload ──────────────────────────────────────────────

/**
 * The payload delivered to every channel when a notification fires.
 */
export interface NotificationPayload {
  /** Unique notification id (uuid) */
  id: string;
  /** Target user identifier */
  userId: string;
  /** Related transaction hash */
  txHash: string;
  /** Chain ID (CAIP-2, e.g. "eip155:1") */
  chainId: string;
  /** Human-readable chain name (e.g. "Ethereum Mainnet") */
  chainName: string;
  /** Current transaction status */
  status: TxStatus;
  /** Short notification title */
  title: string;
  /** Notification body text */
  body: string;
  /** Transaction value as raw bigint */
  value?: bigint;
  /** Formatted value string (e.g. "100 USDC") */
  valueFormatted?: string;
  /** USD-equivalent value */
  valueUsd?: number;
  /** Actual gas used */
  gasUsed?: bigint;
  /** Gas cost in USD */
  gasCostUsd?: number;
  /** Block explorer link */
  explorerUrl?: string;
  /** Final confirmation count */
  confirmations?: number;
  /** Notification creation timestamp (unix ms) */
  timestamp: number;
  /** Recipient type (for SenderPay) */
  recipientType?: "sender" | "merchant";
}

// ─── Notification Watch ────────────────────────────────────────────────

/**
 * Registration for a single transaction's notification lifecycle.
 * Remains active until the tx reaches a terminal state (confirmed/failed).
 */
export interface NotificationWatch {
  /** Transaction hash being watched */
  txHash: string;
  /** Target user */
  userId: string;
  /** Channel ids that should receive this notification */
  channels: string[];
  /** Notification frequency for this watch */
  frequency: NotificationFrequency;
  /** Per-confirm interval (only meaningful when frequency is "per-confirm") */
  confirmInterval?: number;
  /** Transaction metadata for filtering / mute evaluation */
  txMetadata: TxMetadata;
  /** When this watch was created (unix ms) */
  createdAt: number;
  /** When the transaction resolved (unix ms, set when terminal status reached) */
  resolvedAt?: number;
}

export interface TxMetadata {
  chainId: string;
  value?: bigint;
  to?: string;
  /** Detected tx type (transfer, swap, approve, custom) */
  txType: "transfer" | "swap" | "approve" | "custom";
}

// ─── Channel Capability ────────────────────────────────────────────────

export interface ChannelCapability {
  supportsRichText: boolean;
  supportsActionButtons: boolean;
  supportsMedia: boolean;
  maxLength: number;
  isBackground: boolean;
}

// ─── Notification Channel Interface ────────────────────────────────────

export interface NotificationChannel {
  readonly id: string;
  readonly name: string;
  send(payload: NotificationPayload): Promise<void>;
  isAvailable(): boolean;
  getCapabilities(): ChannelCapability;
  healthCheck(): Promise<boolean>;
}

// ─── User Preferences ──────────────────────────────────────────────────

export interface UserNotificationPreferences {
  /** Active channel ids */
  channels: string[];
  /** Default notification frequency */
  frequency: NotificationFrequency;
  /** Per-confirm interval (default 6) */
  confirmInterval?: number;
  /** Pending alert timeout in seconds (default 300 = 5 min) */
  pendingTimeout?: number;
  /** Quiet hours configuration */
  quietHours?: {
    start: string; // "22:00"
    end: string; // "08:00"
    timezone: string; // "Asia/Taipei"
  };
}

// ─── Mute Rules ────────────────────────────────────────────────────────

export interface MuteRule {
  id: string;
  /** Mute all transactions on this chain */
  chainId?: string;
  /** Mute specific tx type */
  txType?: "transfer" | "swap" | "approve" | "custom";
  /** Suppress notifications below this USD value */
  minValueUsd?: number;
  /** Mute a specific contract address */
  contractAddress?: string;
  /** Optional expiry timestamp (unix ms). Omit = permanent */
  until?: number;
  /** When this rule was created (unix ms) */
  createdAt: number;
}

// ─── In-App Notification Item ──────────────────────────────────────────

/**
 * A notification item displayed in the in-app notification center (React).
 */
export interface NotificationItem {
  id: string;
  title: string;
  body: string;
  status: TxStatus;
  txHash: string;
  chainName: string;
  valueFormatted?: string;
  explorerUrl?: string;
  timestamp: number;
  read: boolean;
}

// ─── React Settings Shape ──────────────────────────────────────────────

export interface NotificationSettings {
  telegram: boolean;
  webpush: boolean;
  inapp: boolean;
  frequency: NotificationFrequency;
  mutedChains: string[];
  mutedTypes: string[];
}

// ─── Notifier Options ──────────────────────────────────────────────────

export interface NotifierOptions {
  /** Default user notification preferences (applied when a userId has no explicit prefs) */
  defaultPreferences?: Partial<UserNotificationPreferences>;
  /** Storage adapter for persisting notification history and prefs */
  storage?: {
    getItem: <T>(key: string) => Promise<T | null>;
    setItem: <T>(key: string, value: T) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
  };
  /** Maximum number of in-app history entries to retain (default 200) */
  maxHistory?: number;
}

// ─── Tx Status Handler ─────────────────────────────────────────────────

export type TxStatusCallback = (
  status: TxStatus,
  payload?: Partial<NotificationPayload>,
) => void;

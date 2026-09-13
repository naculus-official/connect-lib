import { logger } from "./logger";
import type { StorageAdapter } from "./storage";
import { LocalStorageAdapter } from "./storage";
import { EncryptedRecordStorageAdapter } from "./storage/encrypted-record";

export type Namespace = "eip155" | "solana" | string;

export interface NamespaceCapabilities {
  atomicBatch?: { supported: boolean; maxBatchSize?: number };
  paymasterService?: { supported: boolean };
  permissions?: boolean;
  serverSigning?: boolean;
  [key: string]: unknown;
}

export interface SessionNamespace {
  chains: string[];
  accounts: string[];
  methods: string[];
  events: string[];
  capabilities?: NamespaceCapabilities;
}

export interface UniversalWalletSession {
  id: string;
  topic?: string;
  walletId: string;
  walletType: "walletconnect" | "eip6963" | "xrpl" | string;
  namespaces: Record<Namespace, SessionNamespace>;
  platform: "desktop-web" | "mobile-web" | "in-app-browser";
  auth?: {
    method: "siwe" | "siws" | "none";
    issuedAt?: string;
    expiresAt?: string;
  };
  createdAt: string;
  updatedAt: string;
  /** Connector-specific identifier, set during session creation */
  connectorId?: string;
  /** Expiry datetime set by session-key manager */
  expiry?: string | number;
}

export interface SessionStorage {
  load(): Promise<UniversalWalletSession | null>;
  save(session: UniversalWalletSession): Promise<void>;
  clear(): Promise<void>;
}

export interface CreateEmptySessionInput {
  id: string;
  walletId: string;
  walletType: UniversalWalletSession["walletType"];
  namespaces: Record<Namespace, SessionNamespace>;
  platform: UniversalWalletSession["platform"];
  topic?: string;
  auth?: UniversalWalletSession["auth"];
  createdAt?: string;
  updatedAt?: string;
}

export function createEmptySession(
  input: CreateEmptySessionInput,
): UniversalWalletSession {
  const now = new Date().toISOString();

  return {
    id: input.id,
    topic: input.topic,
    walletId: input.walletId,
    walletType: input.walletType,
    namespaces: input.namespaces,
    platform: input.platform,
    auth: input.auth,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

export function updateSession(
  session: UniversalWalletSession,
  patch: Partial<UniversalWalletSession>,
): UniversalWalletSession {
  return {
    ...session,
    ...patch,
    updatedAt: patch.updatedAt ?? new Date().toISOString(),
  };
}

export function isSessionExpired(
  session: UniversalWalletSession,
  now: Date,
): boolean {
  if (!session.auth?.expiresAt) {
    return false;
  }

  return new Date(session.auth.expiresAt).getTime() <= now.getTime();
}

/**
 * Session storage backed by localStorage via the unified StorageAdapter.
 *
 * Resolves the "dual storage system" tech debt: instead of directly
 * calling localStorage.getItem/setItem, this delegates to
 * LocalStorageAdapter which provides prefix support, availability
 * detection, quota error handling, and typed parse-error reporting.
 */
export class LocalStorageSessionStorage implements SessionStorage {
  private readonly adapter: StorageAdapter;
  private readonly innerKey: string;

  /**
   * @param key - localStorage key used to store the session blob.
   *             Defaults to "naculus_web3_session".
   * @param encryptionKey - Optional AES-GCM key for at-rest session metadata.
   *             Never use a signing key or PaaS root credential; browser code
   *             cannot keep frontend configuration secret.
   */
  constructor(key = "naculus_web3_session", encryptionKey?: string) {
    this.innerKey = "session";
    // The supplied key becomes the adapter prefix so multiple
    // storage instances don't collide.
    const base = new LocalStorageAdapter(key + ":");
    this.adapter = encryptionKey
      ? new EncryptedRecordStorageAdapter(base, encryptionKey)
      : base;
  }

  /**
   * Return whether localStorage is available in the current environment.
   * Useful for consumers that want to check before calling load/save.
   */
  isAvailable(): boolean {
    return this.adapter.isAvailable();
  }

  async load(): Promise<UniversalWalletSession | null> {
    if (!this.adapter.isAvailable()) return null;

    try {
      return await this.adapter.get<UniversalWalletSession>(this.innerKey);
    } catch {
      // Treat malformed, plaintext, or undecryptable records as missing and
      // remove them so a later configuration change cannot revive stale data.
      try {
        await this.adapter.remove(this.innerKey);
      } catch {
        // Best-effort cleanup; the session remains unavailable either way.
      }
      return null;
    }
  }

  async save(session: UniversalWalletSession): Promise<void> {
    if (!this.adapter.isAvailable()) return;

    try {
      await this.adapter.set(this.innerKey, session);
    } catch (error) {
      logger.warn("core/session", "Failed to save session:", error);
    }
  }

  async clear(): Promise<void> {
    if (!this.adapter.isAvailable()) return;

    await this.adapter.remove(this.innerKey);
  }
}

/**
 * Session Persistence
 *
 * Extends LocalStorageSessionStorage to persist ChainSession data
 * alongside the wallet session, enabling multi-chain state recovery
 * across page reloads.
 *
 * @see SRS-009 §9
 */

import { logger } from "../logger";
import type { UniversalWalletSession } from "../session";
import { isSessionExpired } from "../session";
import type { StorageAdapter } from "../storage";
import { LocalStorageAdapter, MemoryStorageAdapter } from "../storage";
import type {
  ActiveSessionBundle,
  ChainSession,
  PersistedSessionData,
} from "./types";

const DEFAULT_KEY = "naculus_web3_session_manager";

export class SessionPersistence {
  private adapter: StorageAdapter;
  private key: string;

  /**
   * @param key - Storage key for the persisted data.
   * @param adapter - Optional custom storage adapter. Defaults to LocalStorageAdapter.
   */
  constructor(key?: string, adapter?: StorageAdapter) {
    this.key = key ?? DEFAULT_KEY;
    this.adapter = adapter ?? new LocalStorageAdapter("naculus_sm:");
  }

  /**
   * Return whether the backing storage is available.
   */
  isAvailable(): boolean {
    return this.adapter.isAvailable();
  }

  /**
   * Load the persisted session data.
   * Returns null if no data is found or parsing fails.
   */
  async load(): Promise<PersistedSessionData | null> {
    if (!this.adapter.isAvailable()) return null;

    try {
      return await this.adapter.get<PersistedSessionData>(this.key);
    } catch (error) {
      logger.warn(
        "session/persistence",
        "Failed to load persisted session:",
        error,
      );
      await this.adapter.remove(this.key);
      return null;
    }
  }

  /**
   * Save session data to persistent storage.
   */
  async save(data: PersistedSessionData): Promise<void> {
    if (!this.adapter.isAvailable()) return;

    try {
      await this.adapter.set(this.key, data);
    } catch (error) {
      logger.warn("session/persistence", "Failed to save session:", error);
    }
  }

  /**
   * Clear persisted session data.
   */
  async clear(): Promise<void> {
    if (!this.adapter.isAvailable()) return;

    await this.adapter.remove(this.key);
  }

  /**
   * Serialize an ActiveSessionBundle to PersistedSessionData.
   * Converts the Map to a Record for JSON compatibility.
   */
  serializeBundle(bundle: ActiveSessionBundle): PersistedSessionData {
    const chainSessions: Record<string, ChainSession> = {};
    bundle.chainSessions.forEach((session, chainId) => {
      chainSessions[chainId] = session;
    });

    return {
      walletSession: bundle.walletSession,
      lastActiveChainId: bundle.activeChainId,
      chainSessions,
      lastConnectedAt: bundle.lastActiveAt,
    };
  }

  /**
   * Deserialize PersistedSessionData back to a bundle structure.
   * Returns null if the wallet session has expired.
   */
  deserializeToBundle(data: PersistedSessionData): ActiveSessionBundle | null {
    if (isSessionExpired(data.walletSession, new Date())) {
      logger.warn(
        "session/persistence",
        "Persisted session is expired, ignoring",
      );
      return null;
    }

    const chainSessions = new Map<string, ChainSession>();
    for (const [chainId, session] of Object.entries(data.chainSessions)) {
      chainSessions.set(chainId, session);
    }

    return {
      walletSession: data.walletSession,
      chainSessions,
      activeChainId: data.lastActiveChainId,
      lastActiveAt: data.lastConnectedAt,
    };
  }
}

/**
 * Create a SessionPersistence instance.
 */
export function createSessionPersistence(
  key?: string,
  adapter?: StorageAdapter,
): SessionPersistence {
  // If no localStorage available, use memory storage to avoid crashes
  if (!adapter) {
    const hasLocalStorage =
      typeof globalThis !== "undefined" &&
      typeof (globalThis as any).localStorage !== "undefined";

    if (!hasLocalStorage) {
      return new SessionPersistence(key, new MemoryStorageAdapter());
    }
  }
  return new SessionPersistence(key, adapter);
}

/**
 * SIWx Session Storage
 *
 * Provides storage adapters for SiwxSession persistence.
 * Supports localStorage and in-memory storage with auto-cleanup of expired sessions.
 */

import type { SiwxSession } from "./session";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Storage interface for SiwxSession persistence.
 * All operations are async for compatibility with diverse storage backends.
 */
export interface SiwxSessionStorage {
  /** Retrieve a stored session, or null if none exists / expired */
  get(): Promise<SiwxSession | null>;
  /** Persist a session */
  set(session: SiwxSession): Promise<void>;
  /** Remove the stored session */
  remove(): Promise<void>;
  /** Check whether a session exists in storage */
  has(): Promise<boolean>;
  /** Clear all sessions managed by this adapter */
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Auto-cleanup helper
// ---------------------------------------------------------------------------

function isExpired(session: SiwxSession): boolean {
  if (!session.expiresAt) return false;
  return new Date(session.expiresAt).getTime() <= Date.now();
}

// ---------------------------------------------------------------------------
// localStorage-backed storage
// ---------------------------------------------------------------------------

/**
 * Creates a SiwxSessionStorage backed by window.localStorage.
 * On `get()`, if the stored session is expired it will be automatically removed.
 */
export function createLocalStorageSiwxSessionStorage(
  key: string,
): SiwxSessionStorage {
  return {
    async get(): Promise<SiwxSession | null> {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const session = JSON.parse(raw) as SiwxSession;
        if (isExpired(session)) {
          localStorage.removeItem(key);
          return null;
        }
        return session;
      } catch {
        // Corrupt data — clean up
        localStorage.removeItem(key);
        return null;
      }
    },

    async set(session: SiwxSession): Promise<void> {
      localStorage.setItem(key, JSON.stringify(session));
    },

    async remove(): Promise<void> {
      localStorage.removeItem(key);
    },

    async has(): Promise<boolean> {
      const raw = localStorage.getItem(key);
      if (!raw) return false;
      try {
        const session = JSON.parse(raw) as SiwxSession;
        if (isExpired(session)) {
          localStorage.removeItem(key);
          return false;
        }
        return true;
      } catch {
        localStorage.removeItem(key);
        return false;
      }
    },

    async clear(): Promise<void> {
      localStorage.removeItem(key);
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory storage
// ---------------------------------------------------------------------------

/**
 * Creates a SiwxSessionStorage backed by an in-memory Map.
 * Used primarily for testing and server-side environments.
 * On `get()`, expired sessions are automatically evicted.
 */
export function createMemorySiwxSessionStorage(
  key: string,
): SiwxSessionStorage {
  const store = new Map<string, string>();

  return {
    async get(): Promise<SiwxSession | null> {
      const raw = store.get(key);
      if (!raw) return null;
      try {
        const session = JSON.parse(raw) as SiwxSession;
        if (isExpired(session)) {
          store.delete(key);
          return null;
        }
        return session;
      } catch {
        store.delete(key);
        return null;
      }
    },

    async set(session: SiwxSession): Promise<void> {
      store.set(key, JSON.stringify(session));
    },

    async remove(): Promise<void> {
      store.delete(key);
    },

    async has(): Promise<boolean> {
      const raw = store.get(key);
      if (!raw) return false;
      try {
        const session = JSON.parse(raw) as SiwxSession;
        if (isExpired(session)) {
          store.delete(key);
          return false;
        }
        return true;
      } catch {
        store.delete(key);
        return false;
      }
    },

    async clear(): Promise<void> {
      store.clear();
    },
  };
}

/**
 * Auto-cleanup scoped to a specific session — checks the session's expiry
 * and returns null if expired. Used by consumers that hold a session reference
 * and want a lightweight check without re-reading storage.
 */
export function checkSessionExpired(session: SiwxSession | null): boolean {
  if (!session) return true;
  return isExpired(session);
}

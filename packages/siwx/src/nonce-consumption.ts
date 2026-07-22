/**
 * SIWx Nonce Consumption Tracker
 *
 * Prevents replay attacks by tracking which nonces have already been consumed
 * during signature verification. Once a nonce is marked as consumed, any
 * subsequent verify attempt with the same nonce will fail.
 *
 * The tracker is in-memory by default. A custom storage backend can be provided
 * for server-side multi-process persistence (e.g. Redis).
 *
 * IMPORTANT: In-memory storage is ephemeral — nonces are lost on restart.
 * Production deployments with server-side verification MUST provide a
 * persistent SiwxNonceStorage backend.
 */

// ---------------------------------------------------------------------------
// Storage interface
// ---------------------------------------------------------------------------

export interface SiwxNonceStorage {
  /** Check if a nonce exists (consumed or unused) */
  has(nonce: string): Promise<boolean>;
  /** Mark a nonce as consumed */
  consume(nonce: string): Promise<void>;
  /** Check if a nonce has already been consumed */
  isConsumed(nonce: string): Promise<boolean>;
  /** Remove a nonce from tracking (e.g. after expiry) */
  remove(nonce: string): Promise<void>;
  /** Track a nonce as issued (unused) */
  issue(nonce: string): Promise<void>;
  /** Ensure a nonce was previously issued — returns true if valid */
  isIssued(nonce: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// In-memory storage (default)
// ---------------------------------------------------------------------------

/**
 * Creates an in-memory SiwxNonceStorage.
 *
 * Suitable for single-server, ephemeral use.
 * For multi-server or production deployments, provide a custom storage backend.
 */
export function createMemoryNonceStorage(): SiwxNonceStorage {
  const issued = new Set<string>();
  const consumed = new Set<string>();

  return {
    async has(nonce: string): Promise<boolean> {
      return issued.has(nonce);
    },

    async consume(nonce: string): Promise<void> {
      consumed.add(nonce);
    },

    async isConsumed(nonce: string): Promise<boolean> {
      return consumed.has(nonce);
    },

    async remove(nonce: string): Promise<void> {
      issued.delete(nonce);
      consumed.delete(nonce);
    },

    async issue(nonce: string): Promise<void> {
      issued.add(nonce);
    },

    async isIssued(nonce: string): Promise<boolean> {
      return issued.has(nonce);
    },
  };
}

// ---------------------------------------------------------------------------
// Global default storage
// ---------------------------------------------------------------------------

/** Current active nonce storage (defaults to fresh in-memory instance) */
let activeStorage: SiwxNonceStorage = createMemoryNonceStorage();

/**
 * Override the default nonce storage with a custom backend.
 * Returns the previous storage instance.
 *
 * Example:
 * ```ts
 * import { setNonceStorage, createMemoryNonceStorage } from "@naculus/siwx";
 * setNonceStorage(createRedisNonceStorage(redisClient));
 * ```
 */
export function setNonceStorage(storage: SiwxNonceStorage): SiwxNonceStorage {
  const prev = activeStorage;
  activeStorage = storage;
  return prev;
}

/**
 * Reset nonce storage back to a fresh in-memory instance.
 * Returns the replaced storage instance.
 */
export function resetNonceStorage(): SiwxNonceStorage {
  const prev = activeStorage;
  activeStorage = createMemoryNonceStorage();
  return prev;
}

/**
 * Mark a nonce as issued (tracked but not yet consumed).
 * Called automatically when generating a nonce for a sign-in request.
 */
export async function issueNonce(nonce: string): Promise<void> {
  await activeStorage.issue(nonce);
}

/**
 * Mark a nonce as consumed (used in a successful sign-in).
 * Called automatically during verify when a nonce is accepted.
 */
export async function consumeNonce(nonce: string): Promise<void> {
  await activeStorage.consume(nonce);
}

/**
 * Check whether a nonce has already been consumed.
 * Called during verify to prevent replay attacks.
 */
export async function isNonceConsumed(nonce: string): Promise<boolean> {
  return activeStorage.isConsumed(nonce);
}

/**
 * Check whether a nonce was previously issued by the system.
 */
export async function isNonceIssued(nonce: string): Promise<boolean> {
  return activeStorage.isIssued(nonce);
}

/**
 * Full check: verify a nonce is valid (issued + not yet consumed).
 * This is the primary check used during verification.
 */
export async function isNonceValid(nonce: string): Promise<boolean> {
  const issued = await activeStorage.isIssued(nonce);
  if (!issued) return false;
  return !(await activeStorage.isConsumed(nonce));
}

/**
 * Remove a nonce from tracking entirely.
 */
export async function removeNonce(nonce: string): Promise<void> {
  await activeStorage.remove(nonce);
}

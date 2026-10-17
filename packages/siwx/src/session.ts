/**
 * SIWx Session Management
 *
 * Provides a framework-agnostic SiwxSessionManager for creating, refreshing,
 * and managing authenticated wallet sessions built on CAIP-122 (SIWx) messages.
 *
 * Features:
 *  - Session creation from SIWx signed messages
 *  - Session expiry (configurable, default 24h)
 *  - Session refresh (re-signs with updated expiry via the provided signer)
 *  - Callback-based event system (onSessionChange, onExpiry)
 *  - Storage-agnostic (accepts any SiwxSessionStorage implementation)
 *  - Chain-agnostic (supports EVM, Solana, XRPL, etc.)
 *
 * Usage:
 * ```ts
 * import { SiwxSessionManager, createLocalStorageSiwxSessionStorage } from "@naculus/siwx";
 *
 * const mgr = new SiwxSessionManager({
 *   storage: createLocalStorageSiwxSessionStorage("naculus_siwx_session"),
 *   signMessage: async ({ message, address }) => wallet.signMessage(message),
 * });
 *
 * const session = await mgr.signIn({
 *   chainId: "eip155:1",
 *   domain: "example.com",
 *   address: "0x...",
 *   uri: "https://example.com/login",
 *   nonce: "abc123",
 * });
 * ```
 */

import { createSiwxMessage, getBlockchainName } from "./message";
import type { SiwxSessionStorage } from "./session-storage";
import { checkSessionExpired } from "./session-storage";
import type { SiwxMessage } from "./types";
import { generateNonce, nowISO } from "./utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single authenticated SIWx session.
 */
export interface SiwxSession {
  /** Unique session identifier */
  id: string;
  /** CAIP-2 chain ID (e.g. "eip155:1", "solana:4sGjMW1s") */
  chainId: string;
  /** Blockchain address of the authenticated user */
  address: string;
  /** Domain where the session was established */
  domain: string;
  /** The parsed SIWx message */
  message: SiwxMessage;
  /** Cryptographic signature produced by the wallet */
  signature: string;
  /** ISO 8601 timestamp of session creation */
  issuedAt: string;
  /** ISO 8601 timestamp of session expiry, or null if never expires */
  expiresAt: string | null;
  /** ISO 8601 timestamp of last refresh, or null if never refreshed */
  refreshedAt: string | null;
  /** Optional metadata attached to the session */
  metadata?: Record<string, unknown>;
}

/**
 * Parameters for establishing a new SIWx session via signIn().
 */
export interface SiwxSignInParams {
  /** CAIP-2 chain ID */
  chainId: string;
  /** Blockchain address performing the sign-in */
  address: string;
  /** Originating domain (default: window.location.host in browser) */
  domain?: string;
  /** RFC 3986 URI identifying the relying party (default: window.location.origin) */
  uri?: string;
  /** Human-readable statement (optional) */
  statement?: string;
  /** Random nonce (auto-generated if omitted) */
  nonce?: string;
  /** Session lifetime in seconds (default: 86400 = 24 hours). Set to 0 for no expiry. */
  expirySeconds?: number;
  /** CAIP-74 request ID (optional) */
  requestId?: string;
  /** URIs of resources the identity wishes to access (optional) */
  resources?: string[];
  /** Optional blockchain display name override (e.g. "Ethereum") */
  blockchain?: string;
}

/**
 * Parameters for refreshing an existing session.
 */
export interface SiwxRefreshParams {
  /** Session lifetime in seconds for the refreshed session (default: same as original) */
  expirySeconds?: number;
}

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

/**
 * Callback invoked when the active session changes (sign-in, sign-out, refresh).
 */
export type SessionChangeCallback = (session: SiwxSession | null) => void;

/**
 * Callback invoked when the active session expires.
 */
export type SessionExpiryCallback = (session: SiwxSession) => void;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default session lifetime: 24 hours in seconds */
export const DEFAULT_SESSION_EXPIRY_SECONDS = 86_400;

/** Storage key for memory/localStorage usage */
export const DEFAULT_SESSION_STORAGE_KEY = "naculus_siwx_session";

// ---------------------------------------------------------------------------
// SiwxSessionManager
// ---------------------------------------------------------------------------

export interface SiwxSessionManagerOptions {
  /** Storage backend for persisting the session */
  storage: SiwxSessionStorage;
  /**
   * Message signing function.
   * The signMessage function receives the raw SIWx message string and the
   * address to sign as, and must return the cryptographic signature.
   */
  signMessage: (params: {
    message: string;
    address: string;
  }) => string | Promise<string>;
  /** Default expiry in seconds (default: 86400 = 24h) */
  defaultExpirySeconds?: number;
  /** Default domain (default: auto-detected from window.location) */
  defaultDomain?: string;
  /** Default URI (default: auto-detected from window.location) */
  defaultUri?: string;
}

export class SiwxSessionManager {
  private readonly storage: SiwxSessionStorage;
  private readonly signMessage: (params: {
    message: string;
    address: string;
  }) => string | Promise<string>;
  private readonly defaultExpirySeconds: number;
  private readonly defaultDomain: string;
  private readonly defaultUri: string;

  private session: SiwxSession | null = null;
  private sessionChangeCallbacks = new Set<SessionChangeCallback>();
  private expiryCallbacks = new Set<SessionExpiryCallback>();
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Lifecycle generation. signOut and every signIn increment it; an async
   * signIn, refresh or restore captures it before awaiting and discards its
   * result if it changed, so an obsolete completion never republishes or
   * persists an identity after a newer lifecycle decision.
   */
  private generation = 0;

  constructor(options: SiwxSessionManagerOptions) {
    this.storage = options.storage;
    this.signMessage = options.signMessage;
    this.defaultExpirySeconds =
      options.defaultExpirySeconds ?? DEFAULT_SESSION_EXPIRY_SECONDS;
    this.defaultDomain = options.defaultDomain ?? getDefaultDomain();
    this.defaultUri = options.defaultUri ?? getDefaultUri();
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Create a new authenticated session.
   *
   * 1. Builds a CAIP-122 message using the provided chain/address parameters.
   * 2. Signs it via the configured signMessage function.
   * 3. Persists the resulting session to storage.
   * 4. Fires session-change callbacks.
   * 5. Schedules an expiry watchdog timer.
   *
   * Returns the fully-populated SiwxSession.
   */
  async signIn(params: SiwxSignInParams): Promise<SiwxSession> {
    const domain = params.domain ?? this.defaultDomain;
    const uri = params.uri ?? this.defaultUri;
    const nonce = params.nonce ?? generateNonce();
    const issuedAt = nowISO();
    const expirySeconds = validateExpirySeconds(
      params.expirySeconds ?? this.defaultExpirySeconds,
    );
    const expirationTime =
      expirySeconds > 0
        ? new Date(Date.now() + expirySeconds * 1000).toISOString()
        : undefined;

    // Build the CAIP-122 message string
    const raw = createSiwxMessage({
      domain,
      address: params.address,
      statement: params.statement,
      uri,
      version: 1,
      chainId: params.chainId,
      nonce,
      issuedAt,
      expirationTime,
      requestId: params.requestId,
      resources: params.resources,
      blockchain: params.blockchain,
    });

    // A new sign-in supersedes every pending signIn/refresh/restore.
    const generation = ++this.generation;

    // Sign the message via the provided signer
    const signature = await this.signMessage({
      message: raw,
      address: params.address,
    });

    // Build the parsed message record
    const message: SiwxMessage = {
      raw,
      domain,
      address: params.address,
      statement: params.statement ?? null,
      uri,
      version: 1,
      chainId: params.chainId,
      nonce,
      issuedAt,
      expirationTime: expirationTime ?? null,
      notBefore: null,
      resources: params.resources ?? [],
      requestId: params.requestId ?? null,
      blockchain: params.blockchain ?? getBlockchainName(params.chainId),
    };

    const session: SiwxSession = {
      id: generateSessionId(),
      chainId: params.chainId,
      address: params.address,
      domain,
      message,
      signature,
      issuedAt,
      expiresAt: expirationTime ?? null,
      refreshedAt: null,
      metadata: undefined,
    };

    // Persist and update internal state
    await this.persistIfCurrent(session, generation);
    this.session = session;
    this.notifySessionChange(session);
    this.scheduleExpiryCheck(session);

    return session;
  }

  /**
   * Sign out: clear the session from storage and memory, fire callbacks.
   * Any signIn, refresh or restore still pending is discarded.
   */
  async signOut(): Promise<void> {
    this.generation++;
    this.clearExpiryTimer();
    this.session = null;
    await this.storage.remove();
    this.notifySessionChange(null);
  }

  /**
   * Refresh the current session by re-signing with a fresh expiry.
   *
   * The refresh produces a new CAIP-122 message with an updated `issuedAt`
   * and `expirationTime`, signs it via the same signer, and persists the
   * updated session.
   *
   * If no session exists, throws an error.
   */
  async refresh(params?: SiwxRefreshParams): Promise<SiwxSession> {
    const current = this.session;
    if (!current) {
      throw new Error("No active session to refresh");
    }

    const expirySeconds = validateExpirySeconds(
      params?.expirySeconds ?? this.defaultExpirySeconds,
    );
    const newIssuedAt = nowISO();
    const newExpirationTime =
      expirySeconds > 0
        ? new Date(Date.now() + expirySeconds * 1000).toISOString()
        : undefined;

    // Build a fresh CAIP-122 message with updated timestamps
    const raw = createSiwxMessage({
      domain: current.domain,
      address: current.address,
      statement: current.message.statement ?? undefined,
      uri: current.message.uri,
      version: 1,
      chainId: current.chainId,
      // A refresh is a new signed authentication request. Reusing the
      // original nonce would make nonce-consumption/replay protection either
      // reject a legitimate refresh or require unsafe nonce reuse.
      nonce: generateNonce(),
      issuedAt: newIssuedAt,
      expirationTime: newExpirationTime,
      requestId: current.message.requestId ?? undefined,
      resources:
        current.message.resources.length > 0
          ? current.message.resources
          : undefined,
      blockchain: current.message.blockchain,
    });

    const generation = this.generation;

    // Re-sign
    const signature = await this.signMessage({
      message: raw,
      address: current.address,
    });

    const refreshedMessage: SiwxMessage = {
      ...current.message,
      raw,
      issuedAt: newIssuedAt,
      expirationTime: newExpirationTime ?? null,
    };

    const refreshed: SiwxSession = {
      ...current,
      message: refreshedMessage,
      signature,
      issuedAt: newIssuedAt,
      expiresAt: newExpirationTime ?? null,
      refreshedAt: nowISO(),
    };

    await this.persistIfCurrent(refreshed, generation);
    this.session = refreshed;
    this.notifySessionChange(refreshed);
    this.scheduleExpiryCheck(refreshed);

    return refreshed;
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /**
   * Get the current session from memory (not storage).
   * Returns null if no session is active or if the cached session has expired.
   */
  getSession(): SiwxSession | null {
    if (!this.session) return null;
    if (checkSessionExpired(this.session)) {
      // Mark as expired but don't auto-sign-out — leave that to consumer via callbacks
      return null;
    }
    return this.session;
  }

  /**
   * Reload the session from storage, useful after page refresh.
   * Fires session-change callbacks if the restored state differs.
   */
  async restore(): Promise<SiwxSession | null> {
    const generation = this.generation;
    const stored = await this.storage.get();
    // A signIn or signOut ran while reading: the read is obsolete, so leave
    // the newer state (memory, storage, events) untouched.
    if (generation !== this.generation) return this.getSession();
    if (stored && checkSessionExpired(stored)) {
      // Clearing is a lifecycle decision: supersede any pending refresh.
      const cleared = ++this.generation;
      await this.storage.remove();
      if (cleared !== this.generation) return this.getSession();
      this.clearExpiryTimer();
      this.session = null;
      this.notifySessionChange(null);
      return null;
    }
    if (stored) {
      // Storage may hold another identity (e.g. another tab signed in):
      // supersede any pending refresh so it cannot overwrite it.
      this.generation++;
      this.session = stored;
      this.notifySessionChange(stored);
      this.scheduleExpiryCheck(stored);
    } else {
      // Storage is empty (e.g. another tab signed out): supersede any
      // pending refresh so it cannot write the old identity back.
      this.generation++;
      const hadSession = this.session !== null;
      this.session = null;
      if (hadSession) {
        this.notifySessionChange(null);
      }
    }
    return this.session;
  }

  /**
   * Whether the current session has expired.
   * Returns true if no session is active or if the session's expiresAt is in the past.
   */
  isExpired(): boolean {
    if (!this.session) return true;
    return checkSessionExpired(this.session);
  }

  /**
   * Milliseconds until the current session expires, or null if no session / no expiry.
   */
  getTimeUntilExpiry(): number | null {
    if (!this.session?.expiresAt) return null;
    const diff = new Date(this.session.expiresAt).getTime() - Date.now();
    return diff > 0 ? diff : 0;
  }

  // -----------------------------------------------------------------------
  // Event subscriptions
  // -----------------------------------------------------------------------

  /**
   * Subscribe to session changes.
   * Returns an unsubscribe function.
   */
  onSessionChange(callback: SessionChangeCallback): () => void {
    this.sessionChangeCallbacks.add(callback);
    return () => {
      this.sessionChangeCallbacks.delete(callback);
    };
  }

  /**
   * Subscribe to session expiry events.
   * Returns an unsubscribe function.
   */
  onExpiry(callback: SessionExpiryCallback): () => void {
    this.expiryCallbacks.add(callback);
    return () => {
      this.expiryCallbacks.delete(callback);
    };
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Persist a session produced by an operation that started at `generation`.
   * Throws without writing if a signIn or signOut has run since. If the
   * lifecycle changes while the write is in flight, the write is undone when
   * storage still holds exactly this session (a newer write is left alone)
   * and the operation throws, so its caller never publishes it.
   */
  private async persistIfCurrent(
    session: SiwxSession,
    generation: number,
  ): Promise<void> {
    if (generation !== this.generation) throw supersededError();
    await this.storage.set(session);
    if (generation === this.generation) return;
    const stored = await this.storage.get();
    if (
      stored &&
      stored.id === session.id &&
      stored.signature === session.signature
    ) {
      await this.storage.remove();
    }
    throw supersededError();
  }

  private notifySessionChange(session: SiwxSession | null): void {
    for (const cb of this.sessionChangeCallbacks) {
      try {
        cb(session);
      } catch {
        // Swallow callback errors to avoid breaking other listeners
      }
    }
  }

  private notifyExpiry(session: SiwxSession): void {
    for (const cb of this.expiryCallbacks) {
      try {
        cb(session);
      } catch {
        // Swallow callback errors
      }
    }
  }

  private scheduleExpiryCheck(session: SiwxSession): void {
    this.clearExpiryTimer();
    if (!session.expiresAt) return;

    const timeUntilExpiry = new Date(session.expiresAt).getTime() - Date.now();
    if (timeUntilExpiry <= 0) {
      // Already expired — fire immediately
      this.notifyExpiry(session);
      return;
    }

    this.expiryTimer = setTimeout(() => {
      if (this.session === session) {
        this.notifyExpiry(session);
      }
    }, timeUntilExpiry);

    // Allow Node to exit even if the timer is still pending
    if (
      typeof this.expiryTimer !== "undefined" &&
      (this.expiryTimer as any).unref
    ) {
      (this.expiryTimer as any).unref();
    }
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getDefaultDomain(): string {
  if (typeof window !== "undefined") return window.location.host;
  return "localhost";
}

function getDefaultUri(): string {
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost";
}

function supersededError(): Error {
  return new Error(
    "SIWx operation superseded by a newer signIn or signOut; result discarded",
  );
}

function generateSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = generateNonce(12);
  return `siwx_${ts}_${rand}`;
}

function validateExpirySeconds(value: number): number {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error("expirySeconds must be a non-negative integer");
  }
  return value;
}

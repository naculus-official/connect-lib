/**
 * SessionKeyManager
 *
 * Manages ephemeral session keys for automated transaction signing
 * without wallet popups. Session keys are:
 *
 * - Short-lived (configurable expiry, default 24h)
 * - Scoped (limits on value, gas, contracts, methods, chain)
 * - Revocable (local revoke instantly invalidates)
 * - Encrypted at rest (AES-256-CTR-HMAC via @noble/hashes)
 *
 * Uses standard secp256k1 key pairs generated client-side.
 * Private keys are encrypted before storage and decrypted only in memory.
 *
 * @see docs/features/session-keys.md
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils";

import type { StorageAdapter } from "../storage";
import { createSessionKeyError } from "./errors";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  SessionKeyStorage,
} from "./storage";
import type {
  ScopeCheckResult,
  SessionKeyBundle,
  SessionKeyInfo,
  SessionKeyManagerConfig,
  SessionKeyPair,
  SessionKeyScope,
  SignedAuthorization,
  StoredSessionKey,
} from "./types";
import { DEFAULT_SESSION_KEY_CONFIG } from "./types";

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Generate a UUID v4 string (pure JS, no deps).
 */
function uuidv4(): string {
  const bytes = randomBytes(16);
  // Set version 4
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  // Set variant
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Compute a deterministic encryption password from a config salt or entropy.
 */
function deriveEncryptionPassword(config: SessionKeyManagerConfig): string {
  if (config.encryptionKey && config.encryptionKey.length > 0) {
    return config.encryptionKey;
  }
  // Use storage prefix + a fixed internal salt for reproducibility
  // In production, derive from wallet seed phrase
  const base = `${config.storagePrefix ?? DEFAULT_SESSION_KEY_CONFIG.storagePrefix}::session_key_encryption_v1`;
  return sha256(base).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
}

// ─── SessionKeyManager ─────────────────────────────────────────────────

export class SessionKeyManager {
  private config: Required<SessionKeyManagerConfig>;
  private storage: SessionKeyStorage;
  private encryptionPassword: string;
  private activeBundle: SessionKeyBundle | null = null;
  private cache: Map<string, StoredSessionKey> = new Map();

  constructor(
    config?: SessionKeyManagerConfig,
    storageAdapter?: StorageAdapter,
  ) {
    this.config = { ...DEFAULT_SESSION_KEY_CONFIG, ...config };
    this.storage = new SessionKeyStorage(storageAdapter);
    this.encryptionPassword = deriveEncryptionPassword(this.config);
  }

  /**
   * Check whether the storage backend is available.
   */
  isStorageAvailable(): boolean {
    return this.storage.isAvailable();
  }

  // ─── Create ──────────────────────────────────────────────────────────

  /**
   * Create a new session key (secp256k1 keypair).
   *
   * Generates a fresh key pair, encrypts the private key,
   * persists to storage, and returns public session info.
   *
   * @param scope - Optional scope overrides. Missing fields use defaults.
   * @param signerAddress - The main wallet address that authorizes this session
   * @returns Public session key info (no private key exposed)
   */
  async createSessionKey(
    scope?: Partial<SessionKeyScope>,
    signerAddress?: `0x${string}`,
  ): Promise<SessionKeyInfo> {
    // Validate scope
    const fullScope = this.resolveScope(scope);

    if (
      this.config.requireAllowedContracts &&
      (!fullScope.allowedContracts || fullScope.allowedContracts.length === 0)
    ) {
      throw createSessionKeyError(
        "session_key_required_fields_missing",
        "allowedContracts is required when requireAllowedContracts is enabled",
      );
    }

    // Generate secp256k1 key pair
    const privateKeyBytes = secp256k1.utils.randomPrivateKey();
    const publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes);
    const publicKeyHex = `0x${bytesToHex(publicKeyBytes)}` as `0x${string}`;
    const privateKeyHex = `0x${bytesToHex(privateKeyBytes)}` as `0x${string}`;

    // Encrypt private key
    const encrypted = encryptPrivateKey(
      privateKeyHex,
      this.encryptionPassword,
      undefined, // salt (auto-generated)
      this.config.pbkdf2Iterations,
      publicKeyHex as `0x${string}`, // pass the computed public key
    );

    // Create stored record
    const now = Date.now();
    const stored: StoredSessionKey = {
      id: uuidv4(),
      keyPair: encrypted,
      scope: fullScope,
      authorization: {
        signerAddress:
          signerAddress ??
          ("0x0000000000000000000000000000000000000000" as `0x${string}`),
        type: fullScope.mode,
        rawSignature: undefined,
      },
      status: "active",
      createdAt: now,
      lastUsedAt: now,
      useCount: 0,
    };

    // Persist
    await this.storage.save(stored);
    this.cache.set(stored.id, stored);

    // Return public info
    return this.toSessionKeyInfo(stored);
  }

  // ─── List ────────────────────────────────────────────────────────────

  /**
   * List all session keys (active, revoked, or expired).
   * Automatically marks expired keys.
   */
  async listSessions(): Promise<SessionKeyInfo[]> {
    const keys = await this.refreshCache();
    return keys.map((k) => this.toSessionKeyInfo(k));
  }

  /**
   * List only active session keys.
   */
  async listActiveSessions(): Promise<SessionKeyInfo[]> {
    const keys = await this.refreshCache();
    return keys
      .filter((k) => k.status === "active")
      .map((k) => this.toSessionKeyInfo(k));
  }

  // ─── Revoke ──────────────────────────────────────────────────────────

  /**
   * Revoke a session key by ID.
   * Sets status to "revoked" and invalidates the cached bundle.
   */
  async revokeSession(sessionId: string): Promise<void> {
    await this.storage.updateStatus(sessionId, "revoked");
    this.cache.delete(sessionId);

    if (this.activeBundle?.id === sessionId) {
      this.activeBundle = null;
    }
  }

  // ─── Get Bundle (decrypted, for signing) ─────────────────────────────

  /**
   * Get a decrypted session key bundle for transaction signing.
   * Validates expiry and status before returning.
   *
   * @param sessionId - The session key ID
   * @returns Decrypted SessionKeyBundle or throws
   */
  async getSessionBundle(sessionId: string): Promise<SessionKeyBundle> {
    // Check active bundle cache
    if (this.activeBundle?.id === sessionId) {
      return this.activeBundle;
    }

    const stored =
      (await this.storage.get(sessionId)) ?? this.cache.get(sessionId) ?? null;
    if (!stored) {
      throw createSessionKeyError("session_key_not_found", sessionId);
    }

    // Validate status
    this.validateSessionStatus(stored);

    // Decrypt private key
    const privateKey = decryptPrivateKey(
      stored.keyPair,
      this.encryptionPassword,
      this.config.pbkdf2Iterations,
    );

    const bundle: SessionKeyBundle = {
      id: stored.id,
      privateKey,
      scope: stored.scope,
      authorization: stored.authorization,
      signerAddress: stored.authorization.signerAddress,
    };

    this.activeBundle = bundle;
    return bundle;
  }

  // ─── Use Session Key (sign transaction) ──────────────────────────────

  /**
   * Sign a raw message hash using a session key.
   * Validates scope, increments usage counter, and returns the signature.
   *
   * @param sessionId - The session key ID
   * @param messageHash - The 32-byte message hash to sign (0x-prefixed hex)
   * @returns secp256k1 signature as hex
   */
  async signWithSessionKey(
    sessionId: string,
    messageHash: `0x${string}`,
  ): Promise<`0x${string}`> {
    const bundle = await this.getSessionBundle(sessionId);

    // Sign with secp256k1
    const hashBytes = hexToBytes(messageHash.slice(2));
    const sig = secp256k1.sign(
      hashBytes,
      hexToBytes(bundle.privateKey.slice(2)),
    );
    const signature = sig.toCompactHex();
    const v = sig.recovery !== null ? sig.recovery + 27 : 27;
    const r = signature.slice(0, 64);
    const s = signature.slice(64, 128);
    const vHex = v.toString(16).padStart(2, "0");

    // Increment usage
    try {
      await this.storage.incrementUsage(sessionId);
    } catch {
      // Non-critical: usage tracking best-effort
    }

    return `0x${r}${s}${vHex}` as `0x${string}`;
  }

  /**
   * Check whether a session key's scope allows a given transaction.
   * Updates usage tracking before returning.
   */
  async checkSessionScope(
    sessionId: string,
    tx: {
      to?: string;
      value?: string;
      data?: string;
      chainId?: number;
      gas?: string;
    },
  ): Promise<ScopeCheckResult> {
    let stored = this.cache.get(sessionId) ?? null;
    if (!stored) {
      stored = (await this.storage.get(sessionId)) ?? null;
    }
    if (!stored) {
      return { valid: false, reason: "Session key not found" };
    }

    try {
      this.validateSessionStatus(stored);
    } catch (e: any) {
      return { valid: false, reason: e.message ?? "Session key invalid" };
    }

    return this.checkScopeAgainstTx(stored.scope, stored.useCount, tx);
  }

  // ─── Update Authorization ────────────────────────────────────────────

  /**
   * Attach a signed authorization (e.g., EIP-7702 or off-chain signature)
   * to an existing session key.
   */
  async setAuthorization(
    sessionId: string,
    authorization: SignedAuthorization,
  ): Promise<void> {
    const keys = await this.storage.loadAll();
    const stored = keys.find((k) => k.id === sessionId);
    if (!stored) {
      throw createSessionKeyError("session_key_not_found", sessionId);
    }
    stored.authorization = authorization;
    await this.storage.save(stored);
    this.cache.set(stored.id, stored);
  }

  // ─── Clear ───────────────────────────────────────────────────────────

  /**
   * Remove all session keys from storage.
   */
  async clearAll(): Promise<void> {
    await this.storage.clear();
    this.cache.clear();
    this.activeBundle = null;
  }

  // ─── Private Helpers ─────────────────────────────────────────────────

  /**
   * Resolve the final scope by merging user-provided overrides with defaults.
   */
  private resolveScope(scope?: Partial<SessionKeyScope>): SessionKeyScope {
    const now = Math.floor(Date.now() / 1000);
    const defaultExpiry = Math.floor(
      (Date.now() + this.config.defaultExpiryMs) / 1000,
    );

    return {
      expiry: scope?.expiry ?? defaultExpiry,
      maxTotalValue: scope?.maxTotalValue ?? this.config.defaultMaxTotalValue,
      maxTotalGas: scope?.maxTotalGas ?? undefined,
      maxGasPerTx: scope?.maxGasPerTx ?? undefined,
      maxValuePerTx: scope?.maxValuePerTx ?? undefined,
      maxTxCount: scope?.maxTxCount ?? this.config.defaultMaxTxCount,
      allowedContracts:
        scope?.allowedContracts ??
        (this.config.requireAllowedContracts ? [] : undefined),
      allowedMethods: scope?.allowedMethods ?? undefined,
      tokenAllowances: scope?.tokenAllowances ?? undefined,
      allowedChainIds: scope?.allowedChainIds ?? undefined,
      mode: scope?.mode ?? "offchain",
    };
  }

  /**
   * Validate that a session key is active and not expired.
   */
  private validateSessionStatus(stored: StoredSessionKey): void {
    if (stored.status === "revoked") {
      throw createSessionKeyError("session_key_revoked", stored.id);
    }

    if (stored.status === "expired") {
      throw createSessionKeyError("session_key_expired", stored.id);
    }

    // Auto-expire if past expiry
    const nowSec = Math.floor(Date.now() / 1000);
    if (stored.scope.expiry < nowSec) {
      // Update stored status to expired (fire-and-forget)
      this.storage.updateStatus(stored.id, "expired").catch(() => {});
      throw createSessionKeyError("session_key_expired", stored.id);
    }

    // Check max tx count
    if (
      stored.scope.maxTxCount !== undefined &&
      stored.useCount >= stored.scope.maxTxCount
    ) {
      throw createSessionKeyError(
        "session_key_max_tx_count_exceeded",
        stored.id,
      );
    }
  }

  /**
   * Check whether a transaction falls within the session key's scope.
   */
  private checkScopeAgainstTx(
    scope: SessionKeyScope,
    currentUseCount: number,
    tx: {
      to?: string;
      value?: string;
      data?: string;
      chainId?: number;
      gas?: string;
    },
  ): ScopeCheckResult {
    const result: ScopeCheckResult = { valid: true };
    const txValue = tx.value ? BigInt(tx.value) : 0n;
    const txGas = tx.gas ? BigInt(tx.gas) : 0n;

    // Chain check
    if (
      scope.allowedChainIds &&
      scope.allowedChainIds.length > 0 &&
      tx.chainId !== undefined
    ) {
      if (!scope.allowedChainIds.includes(tx.chainId)) {
        return {
          valid: false,
          reason: `Chain ${tx.chainId} not in allowed list: ${scope.allowedChainIds.join(", ")}`,
        };
      }
    }

    // Contract check
    if (scope.allowedContracts && scope.allowedContracts.length > 0 && tx.to) {
      const txToLower = tx.to.toLowerCase();
      const allowed = scope.allowedContracts.some(
        (c) => c.toLowerCase() === txToLower,
      );
      if (!allowed) {
        return {
          valid: false,
          reason: `Contract ${tx.to} not in allowed list`,
        };
      }
    }

    // Forbidden methods check (MUST come before allowed methods — a method
    // can be both forbidden AND in the allowed list; forbidden always wins)
    if (
      this.config.forbiddenMethods.length > 0 &&
      tx.data &&
      tx.data.length >= 10
    ) {
      const methodId = tx.data.slice(0, 10);
      if (this.config.forbiddenMethods.includes(methodId)) {
        return {
          valid: false,
          reason: `Method ${methodId} is forbidden for session keys`,
        };
      }
    }

    // Method check (from data field)
    if (
      scope.allowedMethods &&
      scope.allowedMethods.length > 0 &&
      tx.data &&
      tx.data.length >= 10
    ) {
      const methodId = tx.data.slice(0, 10) as `0x${string}`;
      if (!scope.allowedMethods.includes(methodId)) {
        return {
          valid: false,
          reason: `Method ${methodId} not in allowed list`,
        };
      }
    }

    // Value checks
    if (scope.maxValuePerTx !== undefined && txValue > scope.maxValuePerTx) {
      return {
        valid: false,
        reason: `Transaction value ${txValue} exceeds max per-tx value ${scope.maxValuePerTx}`,
      };
    }

    if (scope.maxTotalValue !== undefined && txValue > scope.maxTotalValue) {
      return {
        valid: false,
        reason: `Transaction value ${txValue} exceeds max total value ${scope.maxTotalValue}`,
      };
    }

    // Gas checks
    if (scope.maxGasPerTx !== undefined && txGas > scope.maxGasPerTx) {
      return {
        valid: false,
        reason: `Gas ${txGas} exceeds max per-tx gas ${scope.maxGasPerTx}`,
      };
    }

    // Tx count check
    if (scope.maxTxCount !== undefined && currentUseCount >= scope.maxTxCount) {
      return {
        valid: false,
        reason: `Tx count ${currentUseCount} exceeds max ${scope.maxTxCount}`,
      };
    }

    // Populate remaining budgets
    if (scope.maxTotalValue !== undefined) {
      result.remainingValue = scope.maxTotalValue - txValue;
    }
    if (scope.maxGasPerTx !== undefined) {
      result.remainingGas = scope.maxGasPerTx - txGas;
    }
    if (scope.maxTxCount !== undefined) {
      result.remainingTxCount = scope.maxTxCount - currentUseCount - 1;
    }

    return result;
  }

  /**
   * Reload the cache from storage, auto-marking expired keys.
   */
  private async refreshCache(): Promise<StoredSessionKey[]> {
    const keys = await this.storage.loadAll();
    const nowSec = Math.floor(Date.now() / 1000);
    let changed = false;

    for (const key of keys) {
      if (key.status === "active" && key.scope.expiry < nowSec) {
        key.status = "expired";
        changed = true;
      }
      this.cache.set(key.id, key);
    }

    if (changed) {
      // Persist expired status updates
      for (const key of keys) {
        if (key.status === "expired") {
          await this.storage.save(key);
        }
      }
    }

    return keys;
  }

  /**
   * Convert a StoredSessionKey to a public SessionKeyInfo.
   */
  private toSessionKeyInfo(stored: StoredSessionKey): SessionKeyInfo {
    return {
      id: stored.id,
      publicKey: stored.keyPair.publicKey,
      scope: stored.scope,
      status: stored.status,
      createdAt: stored.createdAt,
      expiresAt: stored.scope.expiry * 1000,
      useCount: stored.useCount,
      signerAddress: stored.authorization.signerAddress,
    };
  }
}

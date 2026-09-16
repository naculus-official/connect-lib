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

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { isValidAddress, isZeroAddress } from "../address-validation";
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
  SessionKeyTransaction,
  SignedAuthorization,
  StoredSessionKey,
} from "./types";
import { DEFAULT_SESSION_KEY_CONFIG } from "./types";

type OffchainAuthorizationVerifier = (input: {
  message: string;
  signature: `0x${string}`;
  signerAddress: `0x${string}`;
}) => boolean | Promise<boolean>;

type TokenSpend = {
  tokenAddress: `0x${string}`;
  amount: bigint;
  allowance: bigint;
};

type TokenSpendDecodeResult =
  | { spend: TokenSpend; reason?: never }
  | { spend?: never; reason: string }
  | { spend?: never; reason?: never };

const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";
const ERC20_TRANSFER_FROM_SELECTOR = "0x23b872dd";

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
  // `encryptionKey` should be supplied by the host wallet. The deterministic
  // fallback is retained for backwards compatibility with existing records,
  // but is intentionally documented as unsuitable for high-value storage.
  const prefix =
    config.storagePrefix ?? DEFAULT_SESSION_KEY_CONFIG.storagePrefix;
  // Preserve the pre-0.2 derivation when no salt is supplied so existing
  // encrypted records remain decryptable after upgrading.
  const base = config.encryptionSalt
    ? `${prefix}::${config.encryptionSalt}::session_key_encryption_v1`
    : `${prefix}::session_key_encryption_v1`;
  // @noble/hashes 2.x takes bytes only. 1.x accepted a string and UTF-8
  // encoded it internally, so encoding here explicitly produces the identical
  // digest — which it must: this salt derives the key that existing encrypted
  // session records were sealed with.
  return sha256(new TextEncoder().encode(base)).reduce(
    (s, b) => s + b.toString(16).padStart(2, "0"),
    "",
  );
}

function decodeScopedTokenSpend(
  scope: SessionKeyScope,
  tx: SessionKeyTransaction,
): TokenSpendDecodeResult {
  if (!tx.to || !scope.tokenAllowances) return {};

  const allowanceEntry = Object.entries(scope.tokenAllowances).find(
    ([tokenAddress]) => tokenAddress.toLowerCase() === tx.to?.toLowerCase(),
  );
  if (!allowanceEntry) return {};

  const [tokenAddress, allowance] = allowanceEntry as [`0x${string}`, bigint];
  const data = tx.data;
  if (!data || !/^0x[0-9a-fA-F]+$/.test(data)) {
    return {
      reason: `ERC-20 calldata is required for token allowance ${tokenAddress}`,
    };
  }

  const selector = data.slice(0, 10).toLowerCase();
  let amountStart: number;
  let expectedLength: number;
  if (selector === ERC20_TRANSFER_SELECTOR) {
    amountStart = 74;
    expectedLength = 138;
  } else if (selector === ERC20_TRANSFER_FROM_SELECTOR) {
    amountStart = 138;
    expectedLength = 202;
  } else {
    return {
      reason: `Method ${selector} is not permitted for token allowance ${tokenAddress}`,
    };
  }

  if (data.length !== expectedLength) {
    return {
      reason: `ERC-20 ${selector} calldata must use the exact ABI length`,
    };
  }

  return {
    spend: {
      tokenAddress,
      amount: BigInt(`0x${data.slice(amountStart, amountStart + 64)}`),
      allowance,
    },
  };
}

function accumulatedTokenSpend(
  spends: StoredSessionKey["accumulatedTokenSpends"],
  tokenAddress: string,
): bigint {
  if (!spends) return 0n;
  const entry = Object.entries(spends).find(
    ([address]) => address.toLowerCase() === tokenAddress.toLowerCase(),
  );
  return entry?.[1] ?? 0n;
}

// ─── SessionKeyManager ─────────────────────────────────────────────────

export class SessionKeyManager {
  private config: Required<SessionKeyManagerConfig>;
  private storage: SessionKeyStorage;
  private encryptionPassword: string;
  private activeBundle: SessionKeyBundle | null = null;
  private cache: Map<string, StoredSessionKey> = new Map();
  private sessionLocks: Map<string, Promise<void>> = new Map();

  constructor(
    config?: SessionKeyManagerConfig,
    storageAdapter?: StorageAdapter,
  ) {
    this.config = { ...DEFAULT_SESSION_KEY_CONFIG, ...config };
    if (
      !Number.isSafeInteger(this.config.maxExpiryMs) ||
      this.config.maxExpiryMs <= 0 ||
      !Number.isSafeInteger(this.config.defaultExpiryMs) ||
      this.config.defaultExpiryMs <= 0 ||
      this.config.defaultExpiryMs > this.config.maxExpiryMs
    ) {
      throw createSessionKeyError(
        "session_key_invalid_input",
        "defaultExpiryMs and maxExpiryMs must be positive safe integers, and defaultExpiryMs cannot exceed maxExpiryMs",
      );
    }
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
    this.validateScopeInput(fullScope);

    if (
      signerAddress !== undefined &&
      (!isValidAddress(signerAddress, "eip155") || isZeroAddress(signerAddress))
    ) {
      throw createSessionKeyError(
        "session_key_invalid_input",
        "signerAddress must be a non-zero EVM address",
      );
    }

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
    const privateKeyBytes = secp256k1.utils.randomSecretKey();
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
      { unsafeAllowWeakKdf: this.config.unsafeAllowWeakKdf },
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
    await this.storage.withKeyLock(sessionId, async () => {
      await this.storage.updateStatus(sessionId, "revoked");
      this.cache.delete(sessionId);

      if (this.activeBundle?.id === sessionId) {
        this.activeBundle = null;
      }
    });
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
    // Always re-read the record before returning a cached private key. A
    // second tab may have revoked or changed authorization since the last
    // call; returning a stale bundle would bypass that lifecycle decision.
    const stored = await this.readStoredSession(sessionId);
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
    tx: SessionKeyTransaction = {},
  ): Promise<`0x${string}`> {
    // The storage lock covers the complete check/sign/accounting sequence so
    // two managers (or two browser tabs using Web Locks) cannot both consume
    // the same remaining budget.
    return this.storage.withKeyLock(sessionId, () =>
      this.withSessionLock(sessionId, async () => {
        const stored = await this.readStoredSession(sessionId);
        if (!stored) {
          throw createSessionKeyError("session_key_not_found", sessionId);
        }
        return this.signStoredSessionKey(stored, messageHash, tx);
      }),
    );
  }

  /**
   * Revalidate a signed off-chain policy and consume its budget in one locked
   * operation. Product execution flows should use this method instead of a
   * separate `verifyOffchainAuthorization()` + `signWithSessionKey()` pair,
   * which would leave a cross-tab authorization-change window between calls.
   */
  async signWithVerifiedOffchainAuthorization(
    sessionId: string,
    buildExpectedMessage: (policy: SessionKeyInfo) => string,
    verify: OffchainAuthorizationVerifier,
    messageHash: `0x${string}`,
    tx: SessionKeyTransaction = {},
  ): Promise<`0x${string}`> {
    return this.storage.withKeyLock(sessionId, () =>
      this.withSessionLock(sessionId, async () => {
        this.assertMessageHash(messageHash);
        const stored = await this.readStoredSession(sessionId);
        if (!stored) {
          throw createSessionKeyError("session_key_not_found", sessionId);
        }
        this.validateSessionStatus(stored);
        const expectedMessage = buildExpectedMessage(
          this.toSessionKeyInfo(stored),
        );
        if (
          !(await this.verifyStoredOffchainAuthorization(
            stored,
            expectedMessage,
            verify,
          ))
        ) {
          throw createSessionKeyError(
            "session_key_invalid_input",
            "Off-chain authorization no longer matches the signed policy",
          );
        }
        return this.signStoredSessionKey(stored, messageHash, tx);
      }),
    );
  }

  /**
   * Check whether a session key's scope allows a given transaction.
   * Reads the authoritative usage counters before returning.
   */
  async checkSessionScope(
    sessionId: string,
    tx: SessionKeyTransaction,
  ): Promise<ScopeCheckResult> {
    let stored: StoredSessionKey | null;
    try {
      stored = await this.readStoredSession(sessionId);
    } catch (error) {
      return {
        valid: false,
        reason:
          error instanceof Error
            ? error.message
            : "Session key storage unavailable",
      };
    }
    if (!stored) {
      return { valid: false, reason: "Session key not found" };
    }

    try {
      this.validateSessionStatus(stored);
    } catch (e: any) {
      return { valid: false, reason: e.message ?? "Session key invalid" };
    }

    return this.checkScopeAgainstTx(
      stored.scope,
      stored.useCount,
      tx,
      stored.accumulatedValue,
      stored.accumulatedGas,
      stored.accumulatedTokenSpends,
    );
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
    await this.storage.withKeyLock(sessionId, async () => {
      const stored = await this.readStoredSession(sessionId);
      if (!stored) {
        throw createSessionKeyError("session_key_not_found", sessionId);
      }
      if (
        authorization.type !== stored.scope.mode ||
        !isValidAddress(authorization.signerAddress, "eip155") ||
        isZeroAddress(authorization.signerAddress) ||
        (stored.authorization.signerAddress !==
          "0x0000000000000000000000000000000000000000" &&
          authorization.signerAddress.toLowerCase() !==
            stored.authorization.signerAddress.toLowerCase())
      ) {
        throw createSessionKeyError(
          "session_key_invalid_input",
          "Authorization type or signer address does not match the session key",
        );
      }
      if (authorization.type === "eip7702" && !authorization.authorization) {
        throw createSessionKeyError(
          "session_key_invalid_input",
          "EIP-7702 authorization bytes are required",
        );
      }
      if (
        authorization.type === "offchain" &&
        !/^0x[0-9a-fA-F]{130}$/.test(authorization.rawSignature ?? "")
      ) {
        throw createSessionKeyError(
          "session_key_invalid_input",
          "Off-chain authorization requires a 65-byte EVM signature",
        );
      }
      stored.authorization = authorization;
      await this.storage.save(stored);
      this.cache.set(stored.id, stored);
    });
  }

  /**
   * Verify a persisted off-chain authorization without exposing its signature
   * through the public session model.
   *
   * The caller supplies the chain-specific verifier. Core first binds the
   * stored signature to the exact expected message and signer, so altered
   * scope/origin metadata cannot become authorized merely because a signature
   * field is present in browser storage.
   */
  async verifyOffchainAuthorization(
    sessionId: string,
    expectedMessage: string,
    verify: OffchainAuthorizationVerifier,
  ): Promise<boolean> {
    const stored = await this.readStoredSession(sessionId);
    if (!stored) return false;
    return this.verifyStoredOffchainAuthorization(
      stored,
      expectedMessage,
      verify,
    );
  }

  private async verifyStoredOffchainAuthorization(
    stored: StoredSessionKey,
    expectedMessage: string,
    verify: OffchainAuthorizationVerifier,
  ): Promise<boolean> {
    const authorization = stored.authorization;
    if (
      authorization.type !== "offchain" ||
      authorization.message !== expectedMessage ||
      !/^0x[0-9a-fA-F]{130}$/.test(authorization.rawSignature ?? "") ||
      !isValidAddress(authorization.signerAddress, "eip155") ||
      isZeroAddress(authorization.signerAddress)
    ) {
      return false;
    }

    try {
      return Boolean(
        await verify({
          message: authorization.message,
          signature: authorization.rawSignature as `0x${string}`,
          signerAddress: authorization.signerAddress,
        }),
      );
    } catch {
      return false;
    }
  }

  private assertMessageHash(messageHash: `0x${string}`): void {
    if (!/^0x[0-9a-fA-F]{64}$/.test(messageHash)) {
      throw createSessionKeyError(
        "session_key_invalid_input",
        "messageHash must be exactly 32 bytes",
      );
    }
  }

  /** Sign and account for one authoritative record while its key lock is held. */
  private async signStoredSessionKey(
    stored: StoredSessionKey,
    messageHash: `0x${string}`,
    tx: SessionKeyTransaction,
  ): Promise<`0x${string}`> {
    this.assertMessageHash(messageHash);
    this.validateSessionStatus(stored);
    if (
      !this.config.unsafeAllowUnauthorizedSigning &&
      !stored.authorization.rawSignature &&
      !stored.authorization.authorization
    ) {
      throw createSessionKeyError(
        "session_key_invalid_input",
        "Owner authorization must be attached before signing",
      );
    }
    const check = this.checkScopeAgainstTx(
      stored.scope,
      stored.useCount,
      tx,
      stored.accumulatedValue,
      stored.accumulatedGas,
      stored.accumulatedTokenSpends,
    );
    if (!check.valid) {
      throw createSessionKeyError(
        "session_key_scope_exceeded",
        check.reason ?? stored.id,
      );
    }

    const privateKey = decryptPrivateKey(
      stored.keyPair,
      this.encryptionPassword,
      this.config.pbkdf2Iterations,
    );
    this.activeBundle = {
      id: stored.id,
      privateKey,
      scope: stored.scope,
      authorization: stored.authorization,
      signerAddress: stored.authorization.signerAddress,
    };
    // `prehash: false` because messageHash is already a hash; on 2.x's default
    // the curve would hash it again and sign bytes no verifier expects.
    // `format: "recovered"` returns 65 bytes laid out [recovery, r, s] — 1.x
    // carried it on a Signature object that 2.x no longer returns.
    const sig = secp256k1.sign(
      hexToBytes(messageHash.slice(2)),
      hexToBytes(privateKey.slice(2)),
      { prehash: false, format: "recovered" },
    );
    const compact = Array.from(sig.subarray(1))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const v = sig[0]! + 27;
    const signature =
      `0x${compact}${v.toString(16).padStart(2, "0")}` as `0x${string}`;

    // Usage accounting is part of authorization, not best-effort telemetry.
    // If it cannot be persisted, do not return a usable signature.
    const tokenSpend = decodeScopedTokenSpend(stored.scope, tx).spend;
    await this.storage.incrementUsageUnlocked(stored.id, tx, tokenSpend);
    this.cache.delete(stored.id);
    return signature;
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

  /** Read the authoritative record; never authorize from a stale cache. */
  private async readStoredSession(
    sessionId: string,
  ): Promise<StoredSessionKey | null> {
    if (!this.storage.isAvailable()) {
      throw createSessionKeyError("session_key_storage_unavailable");
    }
    try {
      return await this.storage.get(sessionId);
    } catch (error) {
      throw createSessionKeyError("session_key_storage_unavailable", error);
    }
  }

  /**
   * Resolve the final scope by merging user-provided overrides with defaults.
   */
  private resolveScope(scope?: Partial<SessionKeyScope>): SessionKeyScope {
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

  /** Reject scope values that cannot represent a canonical EVM policy. */
  private validateScopeInput(scope: SessionKeyScope): void {
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(scope.expiry) || scope.expiry <= nowSec) {
      throw createSessionKeyError(
        "session_key_invalid_input",
        "Session expiry must be a future Unix timestamp",
      );
    }
    const maxExpirySec = Math.floor(
      (Date.now() + this.config.maxExpiryMs) / 1000,
    );
    if (scope.expiry > maxExpirySec) {
      throw createSessionKeyError(
        "session_key_invalid_input",
        `Session expiry cannot exceed ${this.config.maxExpiryMs}ms from creation`,
      );
    }
    if (
      scope.maxTxCount !== undefined &&
      (!Number.isSafeInteger(scope.maxTxCount) || scope.maxTxCount <= 0)
    ) {
      throw createSessionKeyError(
        "session_key_invalid_input",
        "maxTxCount must be a positive safe integer",
      );
    }
    for (const [name, value] of [
      ["maxTotalGas", scope.maxTotalGas],
      ["maxGasPerTx", scope.maxGasPerTx],
      ["maxTotalValue", scope.maxTotalValue],
      ["maxValuePerTx", scope.maxValuePerTx],
    ] as const) {
      if (value !== undefined && value < 0n) {
        throw createSessionKeyError(
          "session_key_invalid_input",
          `${name} cannot be negative`,
        );
      }
    }
    if (
      scope.allowedChainIds?.some(
        (chainId) => !Number.isSafeInteger(chainId) || chainId <= 0,
      )
    ) {
      throw createSessionKeyError(
        "session_key_invalid_input",
        "allowedChainIds must contain positive safe integers",
      );
    }
    if (
      scope.allowedContracts?.some(
        (address) =>
          !isValidAddress(address, "eip155") || isZeroAddress(address),
      )
    ) {
      throw createSessionKeyError(
        "session_key_invalid_input",
        "allowedContracts must contain non-zero EVM addresses",
      );
    }
    if (
      scope.allowedMethods?.some(
        (selector) => !/^0x[0-9a-fA-F]{8}$/.test(selector),
      )
    ) {
      throw createSessionKeyError(
        "session_key_invalid_input",
        "allowedMethods must contain 4-byte hex selectors",
      );
    }
    if (scope.tokenAllowances) {
      const normalizedAddresses = new Set<string>();
      for (const [address, amount] of Object.entries(scope.tokenAllowances)) {
        if (
          !isValidAddress(address, "eip155") ||
          isZeroAddress(address) ||
          amount < 0n
        ) {
          throw createSessionKeyError(
            "session_key_invalid_input",
            "tokenAllowances must contain non-negative values keyed by non-zero EVM addresses",
          );
        }
        const normalizedAddress = address.toLowerCase();
        if (normalizedAddresses.has(normalizedAddress)) {
          throw createSessionKeyError(
            "session_key_invalid_input",
            "tokenAllowances cannot contain duplicate token addresses",
          );
        }
        normalizedAddresses.add(normalizedAddress);
      }
    }
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
    if (stored.scope.expiry <= nowSec) {
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
    tx: SessionKeyTransaction,
    accumulatedValue = 0n,
    accumulatedGas = 0n,
    accumulatedTokenSpends?: StoredSessionKey["accumulatedTokenSpends"],
  ): ScopeCheckResult {
    const result: ScopeCheckResult = { valid: true };
    let txValue = 0n;
    let txGas = 0n;
    try {
      txValue = tx.value ? BigInt(tx.value) : 0n;
      txGas = tx.gas ? BigInt(tx.gas) : 0n;
    } catch {
      return {
        valid: false,
        reason: "Transaction value and gas must be valid integers",
      };
    }
    if (txValue < 0n || txGas < 0n) {
      return {
        valid: false,
        reason: "Transaction value and gas cannot be negative",
      };
    }
    if (
      tx.chainId !== undefined &&
      (!Number.isSafeInteger(tx.chainId) || tx.chainId <= 0)
    ) {
      return {
        valid: false,
        reason: "Transaction chain ID must be a positive safe integer",
      };
    }

    if (
      (scope.maxGasPerTx !== undefined || scope.maxTotalGas !== undefined) &&
      !tx.gas
    ) {
      return { valid: false, reason: "Transaction gas is required by scope" };
    }

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
    } else if (scope.allowedChainIds?.length) {
      return {
        valid: false,
        reason: "Transaction chain ID is required by scope",
      };
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
    } else if (scope.allowedContracts?.length) {
      return {
        valid: false,
        reason: "Transaction target is required by scope",
      };
    }

    // Forbidden methods check (MUST come before allowed methods — a method
    // can be both forbidden AND in the allowed list; forbidden always wins)
    if (
      this.config.forbiddenMethods.length > 0 &&
      tx.data &&
      tx.data.length >= 10
    ) {
      const methodId = tx.data.slice(0, 10).toLowerCase();
      if (
        this.config.forbiddenMethods.some(
          (method) => method.toLowerCase() === methodId,
        )
      ) {
        return {
          valid: false,
          reason: `Method ${methodId} is forbidden for session keys`,
        };
      }
    }

    const tokenSpendResult = decodeScopedTokenSpend(scope, tx);
    if (tokenSpendResult.reason) {
      return { valid: false, reason: tokenSpendResult.reason };
    }
    if (tokenSpendResult.spend) {
      const { tokenAddress, amount, allowance } = tokenSpendResult.spend;
      const spent = accumulatedTokenSpend(accumulatedTokenSpends, tokenAddress);
      if (spent + amount > allowance) {
        return {
          valid: false,
          reason: `Cumulative token spend ${spent + amount} exceeds allowance ${allowance} for ${tokenAddress}`,
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
      const methodId = tx.data.slice(0, 10).toLowerCase();
      if (
        !scope.allowedMethods.some(
          (method) => method.toLowerCase() === methodId,
        )
      ) {
        return {
          valid: false,
          reason: `Method ${methodId} not in allowed list`,
        };
      }
    } else if (scope.allowedMethods?.length) {
      return { valid: false, reason: "Transaction data is required by scope" };
    }

    // Value checks
    if (scope.maxValuePerTx !== undefined && txValue > scope.maxValuePerTx) {
      return {
        valid: false,
        reason: `Transaction value ${txValue} exceeds max per-tx value ${scope.maxValuePerTx}`,
      };
    }

    if (
      scope.maxTotalValue !== undefined &&
      accumulatedValue + txValue > scope.maxTotalValue
    ) {
      return {
        valid: false,
        reason: `Cumulative value ${accumulatedValue + txValue} exceeds max total value ${scope.maxTotalValue}`,
      };
    }

    // Gas checks
    if (scope.maxGasPerTx !== undefined && txGas > scope.maxGasPerTx) {
      return {
        valid: false,
        reason: `Gas ${txGas} exceeds max per-tx gas ${scope.maxGasPerTx}`,
      };
    }

    if (
      scope.maxTotalGas !== undefined &&
      accumulatedGas + txGas > scope.maxTotalGas
    ) {
      return {
        valid: false,
        reason: `Cumulative gas ${accumulatedGas + txGas} exceeds max total gas ${scope.maxTotalGas}`,
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
      result.remainingValue = scope.maxTotalValue - accumulatedValue - txValue;
    }
    if (scope.maxGasPerTx !== undefined) {
      result.remainingGas = scope.maxGasPerTx - txGas;
    }
    if (scope.maxTxCount !== undefined) {
      result.remainingTxCount = scope.maxTxCount - currentUseCount - 1;
    }

    return result;
  }

  /** Serialize sign/check/usage updates per key within this manager instance. */
  private async withSessionLock<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.sessionLocks.set(sessionId, gate);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionLocks.get(sessionId) === gate) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }

  /**
   * Reload the cache from storage, auto-marking expired keys.
   */
  private async refreshCache(): Promise<StoredSessionKey[]> {
    const keys = await this.storage.loadAll();
    const nowSec = Math.floor(Date.now() / 1000);
    let changed = false;

    for (const key of keys) {
      if (key.status === "active" && key.scope.expiry <= nowSec) {
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
      authorized: Boolean(
        stored.authorization.rawSignature || stored.authorization.authorization,
      ),
      authorizationType: stored.authorization.type,
      ...(stored.authorization.message
        ? { authorizationMessage: stored.authorization.message }
        : {}),
    };
  }
}

import { WalletError } from "../errors";
import type { TransactionRequest } from "../signers/types";
import type { StorageAdapter } from "../storage/types";
import {
  decryptSessionKey,
  encryptSessionKey,
  generateSessionKeyPair,
  signTransactionWithSessionKey,
} from "./crypto";
import { SessionKeyStorage } from "./storage";
import type {
  EncryptedKeyPair,
  ScopeCheckResult,
  SessionKeyBundle,
  SessionKeyInfo,
  SessionKeyPair,
  SessionKeyScope,
  SessionSignResult,
  SignedAuthorization,
  StoredSessionKey,
} from "./types";

/**
 * SessionKeyManager — manages the full session key lifecycle.
 *
 * Features:
 * - Generate session key pair (ECDSA secp256k1)
 * - Encrypt private key (AES-256-GCM, derived from master wallet seed)
 * - Create authorization scope and signing authorization
 * - Scope enforcement (mandatory on wallet side)
 * - List, revoke, auto-cleanup expired keys
 * - Sign transactions with session key
 *
 * Usage (integrated via PocketWallet):
 * ```ts
 * const mgr = new SessionKeyManager(walletSeed, storage, signerAddress);
 * const session = await mgr.createSessionKey({ expiry: ..., mode: "offchain" });
 * const result = await mgr.signWithSession(sessionId, tx);
 * ```
 */
export class SessionKeyManager {
  private _walletSeed: Uint8Array;
  private _storage: SessionKeyStorage;
  private _signerAddress: `0x${string}`;

  /**
   * @param walletSeed Master wallet seed (used to derive AES encryption key)
   * @param signerAddress Master wallet address (recorded in authorization)
   * @param storage Optional custom StorageAdapter
   */
  constructor(
    walletSeed: Uint8Array,
    signerAddress: `0x${string}`,
    storage?: StorageAdapter,
  ) {
    this._walletSeed = walletSeed;
    this._signerAddress = signerAddress;
    this._storage = new SessionKeyStorage(storage);
  }

  /**
   * Generate a new session key pair + encrypt and store it.
   *
   * @param scope Authorization scope (requires at least expiry and mode)
   * @returns SessionKeyInfo (public info, no private key)
   */
  async createSessionKey(scope: SessionKeyScope): Promise<SessionKeyInfo> {
    this._validateScope(scope);

    // 1. Generate key pair
    const keyPair = await generateSessionKeyPair();

    // 2. Encrypt private key
    const encrypted = await encryptSessionKey(keyPair, this._walletSeed);

    // 3. Create authorization (off-chain agreement)
    const authorization: SignedAuthorization = {
      signerAddress: this._signerAddress,
      type: scope.mode,
      // rawSignature can be filled later if the main wallet signs the scope hash
    };

    // 4. Create stored session key
    const session: StoredSessionKey = {
      id: this._generateId(),
      keyPair: encrypted,
      scope,
      authorization,
      status: "active",
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      useCount: 0,
    };

    // 5. Save
    await this._storage.save(session);

    return {
      id: session.id,
      publicKey: encrypted.publicKey,
      scope,
      status: "active",
      createdAt: session.createdAt,
      expiresAt: scope.expiry,
      useCount: 0,
      signerAddress: this._signerAddress,
    };
  }

  /**
   * List all active sessions (auto-cleanup expired ones).
   */
  async listSessions(): Promise<SessionKeyInfo[]> {
    // Clean up expired first
    await this._storage.autoCleanup();
    return this._storage.listActive();
  }

  /**
   * Revoke a session key.
   * - Marks as revoked (keeps record)
   * - Does not erase storage (preserves audit trail)
   */
  async revokeSession(sessionId: string): Promise<void> {
    const session = await this._storage.load(sessionId);
    if (!session) {
      throw new WalletError(
        "session_not_found",
        `Session key '${sessionId}' not found.`,
      );
    }
    if (session.status !== "active") {
      throw new WalletError(
        "session_inactive",
        `Session key '${sessionId}' is already ${session.status}.`,
      );
    }

    await this._storage.markRevoked(sessionId);
  }

  /**
   * Sign a transaction using a session key.
   *
   * Automatic checks:
   * - Session exists and is active
   * - Session has not expired
   * - Scope covers this transaction
   * - Spending limit / gas limit / tx count not exceeded
   *
   * @param sessionId Session key ID to use
   * @param tx Transaction request (TransactionRequest-compatible)
   */
  async signWithSession(
    sessionId: string,
    tx: TransactionRequest,
  ): Promise<SessionSignResult> {
    // 1. Load session
    const stored = await this._storage.load(sessionId);
    if (!stored) {
      throw new WalletError(
        "session_not_found",
        `Session key '${sessionId}' not found.`,
      );
    }

    // 2. Check status
    if (stored.status !== "active") {
      throw new WalletError(
        "session_inactive",
        `Session key '${sessionId}' is ${stored.status}.`,
      );
    }

    // 3. Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (stored.scope.expiry <= now) {
      await this._storage.markRevoked(sessionId);
      throw new WalletError(
        "session_expired",
        `Session key '${sessionId}' expired at ${new Date(stored.scope.expiry * 1000).toISOString()}.`,
      );
    }

    // 4. Get decrypted session key bundle
    const bundle = await this._getBundle(sessionId, stored);

    // 5. Check scope (with accumulated value/gas)
    const check = this._checkScope(
      stored.scope,
      tx,
      stored.useCount,
      stored.accumulatedValue,
      stored.accumulatedGas,
    );
    if (!check.valid) {
      throw new WalletError(
        "session_scope_exceeded",
        check.reason ?? "Transaction exceeds session key scope.",
      );
    }

    // 6. Sign transaction
    const signature = await signTransactionWithSessionKey(
      bundle.privateKey,
      tx,
    );

    // 7. Update usage record (includes accumulated value/gas tracking)
    await this._storage.recordUsage(sessionId, tx);

    return {
      signature,
      sessionId,
    };
  }

  /**
   * Check whether the session key's scope covers the given transaction.
   * Does not sign, only validates.
   */
  async checkScope(
    sessionId: string,
    tx: TransactionRequest,
  ): Promise<ScopeCheckResult> {
    const stored = await this._storage.load(sessionId);
    if (!stored) {
      return { valid: false, reason: `Session key '${sessionId}' not found.` };
    }

    if (stored.status !== "active") {
      return {
        valid: false,
        reason: `Session key '${sessionId}' is ${stored.status}.`,
      };
    }

    const now = Math.floor(Date.now() / 1000);
    if (stored.scope.expiry <= now) {
      return { valid: false, reason: "Session key expired." };
    }

    return this._checkScope(
      stored.scope,
      tx,
      stored.useCount,
      stored.accumulatedValue,
      stored.accumulatedGas,
    );
  }

  /**
   * Force-update a session key's authorization (call after master wallet signs).
   */
  async updateAuthorization(
    sessionId: string,
    authorization: SignedAuthorization,
  ): Promise<void> {
    const stored = await this._storage.load(sessionId);
    if (!stored) {
      throw new WalletError(
        "session_not_found",
        `Session key '${sessionId}' not found.`,
      );
    }

    stored.authorization = authorization;
    await this._storage.save(stored);
  }

  // ── Private methods ──────────────────────────────────────────

  /** Get decrypted session key bundle */
  private async _getBundle(
    sessionId: string,
    stored: StoredSessionKey,
  ): Promise<SessionKeyBundle> {
    const decrypted = await decryptSessionKey(stored.keyPair, this._walletSeed);
    return {
      id: sessionId,
      privateKey: decrypted.privateKey,
      scope: stored.scope,
      authorization: stored.authorization,
    };
  }

  /** Validate scope parameter validity */
  private _validateScope(scope: SessionKeyScope): void {
    if (!scope.expiry || scope.expiry <= Math.floor(Date.now() / 1000)) {
      throw new WalletError(
        "invalid_scope",
        "Session key expiry must be in the future.",
      );
    }

    if (
      !scope.mode ||
      !["eip7702", "offchain", "aa_module"].includes(scope.mode)
    ) {
      throw new WalletError(
        "invalid_scope",
        "Session key mode must be one of: eip7702, offchain, aa_module.",
      );
    }

    // Default security policy
    if (scope.maxTxCount !== undefined && scope.maxTxCount <= 0) {
      throw new WalletError("invalid_scope", "maxTxCount must be positive.");
    }
  }

  /** Core scope check logic */
  private _checkScope(
    scope: SessionKeyScope,
    tx: TransactionRequest,
    useCount: number,
    accumulatedValue?: bigint,
    accumulatedGas?: bigint,
  ): ScopeCheckResult {
    // Check tx count limit
    if (scope.maxTxCount !== undefined && useCount >= scope.maxTxCount) {
      return {
        valid: false,
        reason: `Transaction count limit reached (${useCount}/${scope.maxTxCount}).`,
        remainingTxCount: 0,
      };
    }

    // Check chain ID
    if (scope.allowedChainIds?.length) {
      const txChainId = tx.chainId;
      if (
        txChainId !== undefined &&
        !scope.allowedChainIds.includes(txChainId)
      ) {
        return {
          valid: false,
          reason: `Chain ID ${txChainId} is not in allowed chain IDs.`,
        };
      }
    }

    // Check allowed contracts
    if (scope.allowedContracts?.length) {
      const txTo = tx.to?.toLowerCase() as `0x${string}`;
      if (!scope.allowedContracts.some((c) => c.toLowerCase() === txTo)) {
        return {
          valid: false,
          reason: `Contract ${tx.to} is not in allowed contracts.`,
        };
      }
    }

    // Check allowed methods (first 4 bytes of data is method selector)
    if (scope.allowedMethods?.length) {
      const selector = tx.data?.slice(0, 10).toLowerCase(); // "0x" + 4 bytes = 10 chars
      if (
        !selector ||
        !scope.allowedMethods.some((m) => m.toLowerCase() === selector)
      ) {
        return {
          valid: false,
          reason: `Method selector ${tx.data?.slice(0, 10) ?? "none"} is not in allowed methods.`,
        };
      }
    }

    // Check per-tx gas limit
    if (scope.maxGasPerTx !== undefined && tx.gas) {
      const txGas = BigInt(tx.gas);
      if (txGas > scope.maxGasPerTx) {
        return {
          valid: false,
          reason: `Gas limit ${txGas} exceeds max per tx ${scope.maxGasPerTx}.`,
        };
      }
    }

    // Check per-tx value limit
    if (scope.maxValuePerTx !== undefined && tx.value) {
      const txValue = BigInt(tx.value);
      if (txValue > scope.maxValuePerTx) {
        return {
          valid: false,
          reason: `Transaction value ${txValue} exceeds max per tx ${scope.maxValuePerTx}.`,
        };
      }
    }

    // Check total gas limit (historical + current)
    if (scope.maxTotalGas !== undefined) {
      const currentAccumulated = accumulatedGas ?? 0n;
      // This tx also consumes gas (estimated)
      const txGas = tx.gas ? BigInt(tx.gas) : 0n;
      if (currentAccumulated + txGas > scope.maxTotalGas) {
        return {
          valid: false,
          reason: `Total gas limit exceeded (${currentAccumulated + txGas} > ${scope.maxTotalGas}).`,
        };
      }
    }

    // Check total value limit (historical + current)
    if (scope.maxTotalValue !== undefined) {
      const currentAccumulated = accumulatedValue ?? 0n;
      const txValue = tx.value ? BigInt(tx.value) : 0n;
      if (currentAccumulated + txValue > scope.maxTotalValue) {
        return {
          valid: false,
          reason: `Total value limit exceeded (${currentAccumulated + txValue} > ${scope.maxTotalValue}).`,
        };
      }
    }

    const remaining =
      scope.maxTxCount !== undefined
        ? Math.max(0, scope.maxTxCount - useCount - 1)
        : undefined;

    return {
      valid: true,
      remainingTxCount: remaining,
      remainingGas:
        scope.maxTotalGas !== undefined
          ? scope.maxTotalGas - (accumulatedGas ?? 0n)
          : undefined,
      remainingValue:
        scope.maxTotalValue !== undefined
          ? scope.maxTotalValue - (accumulatedValue ?? 0n)
          : undefined,
    };
  }

  /** Generate unique session ID (crypto RNG, rejection-sampled) */
  private _generateId(): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    const maxValid = 256 - (256 % chars.length); // 256 - 4 = 252
    const bytes = new Uint8Array(24);
    let id = "sk_";
    for (let i = 0; i < 24; i++) {
      let b: number;
      do {
        crypto.getRandomValues(bytes);
        b = bytes[i];
      } while (b >= maxValid);
      id += chars[b % chars.length];
    }
    return id;
  }
}

// Re-export types from this module for convenience
export type {
  EncryptedKeyPair,
  ScopeCheckResult,
  SessionKeyBundle,
  SessionKeyInfo,
  SessionKeyPair,
  SessionKeyScope,
  SessionSignResult,
  SignedAuthorization,
  StoredSessionKey,
} from "./types";

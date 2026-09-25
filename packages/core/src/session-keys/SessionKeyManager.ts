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
import {
  buildDelegation,
  DELEGATION_FRAMEWORK,
  delegationHash,
  delegationSigningDigest,
  encodePermissionContext,
  encodeRedeemDelegationsWithContext,
  encodeSingleExecution,
  type FrameworkDelegation,
  type FrameworkExecution,
} from "./delegation-framework";
import { createSessionKeyError } from "./errors";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  SessionKeyStorage,
} from "./storage";
import {
  type SessionKeyTypedDataRequest,
  sessionKeyAddress,
  snapshotTypedDataRequest,
  typedDataAsTransaction,
  typedDataDigest,
  validateTypedDataRequest,
} from "./typed-data";
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
  /** Decoded transfer destination, for the recipient allowlist. */
  recipient: `0x${string}`;
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
  let recipientStart: number;
  if (selector === ERC20_TRANSFER_SELECTOR) {
    recipientStart = 10;
    amountStart = 74;
    expectedLength = 138;
  } else if (selector === ERC20_TRANSFER_FROM_SELECTOR) {
    recipientStart = 74;
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
      recipient: `0x${data.slice(recipientStart + 24, recipientStart + 64)}`,
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
   *
   * Revocation is device-local: it stops this manager (and any other tab
   * sharing its storage) from signing with the key. A `SessionKeyBundle`
   * already handed out by `getSessionBundle()` holds the raw private key and
   * cannot be recalled; nor can anything the host did with it. For a key that
   * must be revocable after export, use an on-chain (EIP-7702 / AA module)
   * policy instead of an off-chain one.
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
   * The bundle contains the raw private key. Once returned, `revokeSession()`
   * can no longer stop its use — only this manager's own signing paths honour
   * revocation. Prefer `signWithSessionKey()` /
   * `signWithVerifiedOffchainAuthorization()`, which never release the key.
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
    // The raw key signs anything; handing it out would undo the recipient
    // limit exactly as a raw digest would.
    this.refuseRawDigestForRecipientScope(stored);

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
   * The scope is checked against `tx`, which the caller describes; nothing
   * ties `messageHash` to it. Use `signTypedDataWithSessionKey` where amount
   * and recipient must be bound to what is signed. Refused while the scope
   * sets `allowedRecipients`.
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
        this.refuseRawDigestForRecipientScope(stored);
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
        this.refuseRawDigestForRecipientScope(stored);
        return this.signStoredSessionKey(stored, messageHash, tx);
      }),
    );
  }

  /**
   * Sign EIP-712 typed data with a session key. Only EIP-3009
   * `TransferWithAuthorization` is understood; the manager computes the
   * digest from the request it checked, so nothing else can be signed under
   * this name. Policy is applied to the equivalent `transfer(to, value)` on
   * the token, plus: `from` must be the session key's own address,
   * `validBefore` must fall inside the session's lifetime.
   */
  async signTypedDataWithSessionKey(
    sessionId: string,
    request: SessionKeyTypedDataRequest,
  ): Promise<`0x${string}`> {
    return this.storage.withKeyLock(sessionId, () =>
      this.withSessionLock(sessionId, async () => {
        const stored = await this.readStoredSession(sessionId);
        if (!stored) {
          throw createSessionKeyError("session_key_not_found", sessionId);
        }
        // One copy for the check, the scope mapping and the digest.
        if (stored.scope.mode === "eip7702") {
          throw createSessionKeyError(
            "session_key_scope_exceeded",
            "An eip7702 session key signs only delegation redemptions (signDelegationRedemption).",
          );
        }
        const snapshot = snapshotTypedDataRequest(request);
        const tx = this.typedDataToScopedTransaction(stored, snapshot);
        return this.signStoredSessionKey(stored, typedDataDigest(snapshot), tx);
      }),
    );
  }

  /** As signTypedDataWithSessionKey, revalidating the off-chain policy first. */
  async signTypedDataWithVerifiedOffchainAuthorization(
    sessionId: string,
    buildExpectedMessage: (policy: SessionKeyInfo) => string,
    verify: OffchainAuthorizationVerifier,
    request: SessionKeyTypedDataRequest,
  ): Promise<`0x${string}`> {
    return this.storage.withKeyLock(sessionId, () =>
      this.withSessionLock(sessionId, async () => {
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
        // One copy for the check, the scope mapping and the digest.
        if (stored.scope.mode === "eip7702") {
          throw createSessionKeyError(
            "session_key_scope_exceeded",
            "An eip7702 session key signs only delegation redemptions (signDelegationRedemption).",
          );
        }
        const snapshot = snapshotTypedDataRequest(request);
        const tx = this.typedDataToScopedTransaction(stored, snapshot);
        return this.signStoredSessionKey(stored, typedDataDigest(snapshot), tx);
      }),
    );
  }

  /**
   * A raw digest cannot be tied to the `tx` it arrives with: the manager
   * signs the 32 bytes it is handed and checks the transaction it is told
   * about. So a scope that limits *who gets paid* cannot be enforced on it —
   * a harmless `transfer(payee, 0)` could accompany the digest of a transfer
   * to anyone (independent review, 2026-09-23). While `allowedRecipients` is
   * set, only paths where the manager derives the digest itself
   * (`signTypedDataWithSessionKey`) may sign.
   */
  private refuseRawDigestForRecipientScope(stored: StoredSessionKey): void {
    // An eip7702 key signs only its delegation redemptions; a raw digest or
    // its exported key would let it sign anything its address can send.
    if (stored.scope.mode === "eip7702") {
      throw createSessionKeyError(
        "session_key_scope_exceeded",
        "An eip7702 session key signs only delegation redemptions (signDelegationRedemption).",
      );
    }
    if (
      stored.scope.allowedRecipients &&
      stored.scope.allowedRecipients.length > 0
    ) {
      throw createSessionKeyError(
        "session_key_scope_exceeded",
        "This session key limits recipients; a raw digest cannot be bound to a recipient. Use signTypedDataWithSessionKey.",
      );
    }
  }

  /** Typed-data-specific refusals, then the transaction the scope check sees. */
  private typedDataToScopedTransaction(
    stored: StoredSessionKey,
    request: SessionKeyTypedDataRequest,
  ): SessionKeyTransaction {
    const structural = validateTypedDataRequest(request);
    if (structural) {
      throw createSessionKeyError("session_key_scope_exceeded", structural);
    }
    // The amount must count against something. Without a tokenAllowances
    // entry for this token the equivalent transfer has no budget, and the
    // scope check would let any value through.
    const token = request.domain.verifyingContract.toLowerCase();
    if (
      !stored.scope.tokenAllowances ||
      !Object.keys(stored.scope.tokenAllowances).some(
        (address) => address.toLowerCase() === token,
      )
    ) {
      throw createSessionKeyError(
        "session_key_scope_exceeded",
        "TransferWithAuthorization requires a tokenAllowances entry for the token",
      );
    }
    const selfAddress = sessionKeyAddress(stored.keyPair.publicKey);
    if (request.message.from.toLowerCase() !== selfAddress.toLowerCase()) {
      throw createSessionKeyError(
        "session_key_scope_exceeded",
        "TransferWithAuthorization.from must be the session key's own address",
      );
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const validBefore = Number(request.message.validBefore);
    const validAfter = Number(request.message.validAfter);
    if (validBefore <= nowSec) {
      throw createSessionKeyError(
        "session_key_scope_exceeded",
        "TransferWithAuthorization.validBefore is already in the past",
      );
    }
    if (validBefore > stored.scope.expiry) {
      throw createSessionKeyError(
        "session_key_scope_exceeded",
        "TransferWithAuthorization.validBefore outlives the session key",
      );
    }
    if (validAfter >= validBefore) {
      throw createSessionKeyError(
        "session_key_scope_exceeded",
        "TransferWithAuthorization validity window is empty",
      );
    }
    return typedDataAsTransaction(request);
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
      if (authorization.type === "eip7702") {
        // Unverified bytes here used to authorize the key. An eip7702 key is
        // authorized only by a delegation whose signature and caveats were
        // checked: prepareDelegation → owner signs → attachDelegation.
        throw createSessionKeyError(
          "session_key_invalid_input",
          "EIP-7702 session keys are authorized with attachDelegation, not setAuthorization",
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

  // ─── EIP-7702 delegation (MetaMask Delegation Framework) ──────────────

  /**
   * The unsigned delegation from the session's owner to its session key, for
   * `chainId`. The owner signs `delegationTypedData(delegation)` (or its
   * digest) and hands the signature to `attachDelegation`. Refuses a scope the
   * chain cannot enforce (see caveatsFromScope).
   */
  async prepareDelegation(
    sessionId: string,
    chainId: number,
    salt?: bigint,
  ): Promise<FrameworkDelegation> {
    const stored = await this.readStoredSession(sessionId);
    if (!stored) {
      throw createSessionKeyError("session_key_not_found", sessionId);
    }
    this.validateSessionStatus(stored);
    return this.delegationFor(stored, chainId, salt);
  }

  private delegationFor(
    stored: StoredSessionKey,
    chainId: number,
    salt: bigint | undefined,
  ): FrameworkDelegation {
    if (stored.scope.mode !== "eip7702") {
      throw createSessionKeyError(
        "session_key_invalid_input",
        "Only an eip7702 session key has a delegation",
      );
    }
    const owner = stored.authorization.signerAddress;
    if (!isValidAddress(owner, "eip155") || isZeroAddress(owner)) {
      throw createSessionKeyError(
        "session_key_invalid_input",
        "An eip7702 session key needs its owner address (createSessionKey signerAddress)",
      );
    }
    return buildDelegation({
      delegator: owner,
      delegate: sessionKeyAddress(stored.keyPair.publicKey),
      scope: stored.scope,
      chainId,
      salt,
      forbiddenMethods: this.config.forbiddenMethods,
    });
  }

  /**
   * Authorize an eip7702 session key with the owner's signed delegation.
   *
   * The delegation must be exactly the one `prepareDelegation` builds for
   * this key, scope and chain (compared by hash), and the signature must
   * recover to the owner over its EIP-712 digest — the same check the
   * owner's EIP7702StatelessDeleGator makes on chain (ECDSA.recover ==
   * address(this)), so a delegation accepted here is one the chain accepts.
   */
  async attachDelegation(
    sessionId: string,
    delegation: FrameworkDelegation,
    signature: `0x${string}`,
  ): Promise<void> {
    await this.storage.withKeyLock(sessionId, async () => {
      const stored = await this.readStoredSession(sessionId);
      if (!stored) {
        throw createSessionKeyError("session_key_not_found", sessionId);
      }
      this.validateSessionStatus(stored);
      if (
        !delegation ||
        typeof delegation.salt !== "bigint" ||
        !Number.isSafeInteger(delegation.chainId)
      ) {
        throw createSessionKeyError(
          "session_key_invalid_input",
          "A delegation from prepareDelegation is required",
        );
      }
      const expected = this.delegationFor(
        stored,
        delegation.chainId,
        delegation.salt,
      );
      if (delegationHash(expected) !== delegationHash(delegation)) {
        throw createSessionKeyError(
          "session_key_invalid_input",
          "The delegation does not match this session key's scope",
        );
      }
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature ?? "")) {
        throw createSessionKeyError(
          "session_key_invalid_input",
          "The delegation signature must be 65 bytes",
        );
      }
      const sig = hexToBytes(signature.slice(2));
      const v = sig[64] as number;
      let recovered: string | null = null;
      try {
        if (v === 27 || v === 28) {
          const signatureObject = secp256k1.Signature.fromBytes(
            sig.slice(0, 64),
            "compact",
          );
          // OpenZeppelin ECDSA (used by the DeleGator) rejects high-s.
          if (!signatureObject.hasHighS()) {
            const point = signatureObject
              .addRecoveryBit(v - 27)
              .recoverPublicKey(
                hexToBytes(delegationSigningDigest(expected).slice(2)),
              );
            recovered = sessionKeyAddress(`0x${point.toHex(true)}`);
          }
        }
      } catch {
        recovered = null;
      }
      const owner = stored.authorization.signerAddress;
      if (!recovered || recovered.toLowerCase() !== owner.toLowerCase()) {
        throw createSessionKeyError(
          "session_key_invalid_input",
          "The delegation signature does not recover to the owner",
        );
      }
      stored.authorization = {
        type: "eip7702",
        signerAddress: owner,
        authorization: encodePermissionContext([{ ...expected, signature }]),
        delegationChainId: expected.chainId,
      };
      await this.storage.save(stored);
      this.cache.set(stored.id, stored);
    });
  }

  /**
   * The `DelegationManager.redeemDelegations` call that has the owner's
   * account run `execution`, for an authorized eip7702 session key. The
   * session key sends it as its own transaction (to, value 0, data).
   */
  async buildDelegationRedemption(
    sessionId: string,
    execution: FrameworkExecution,
  ): Promise<{
    to: `0x${string}`;
    value: "0x0";
    data: `0x${string}`;
    chainId: number;
  }> {
    const stored = await this.readStoredSession(sessionId);
    if (!stored) {
      throw createSessionKeyError("session_key_not_found", sessionId);
    }
    this.validateSessionStatus(stored);
    const { chainId, data } = this.redemptionFor(stored, execution);
    return {
      to: DELEGATION_FRAMEWORK.delegationManager,
      value: "0x0",
      data,
      chainId,
    };
  }

  private redemptionFor(
    stored: StoredSessionKey,
    execution: FrameworkExecution,
  ): { chainId: number; data: `0x${string}` } {
    const auth = stored.authorization;
    if (
      stored.scope.mode !== "eip7702" ||
      auth.type !== "eip7702" ||
      !auth.authorization ||
      auth.delegationChainId === undefined
    ) {
      throw createSessionKeyError(
        "session_key_invalid_input",
        "This session key has no attached delegation",
      );
    }
    // The stored context is a single signed root delegation; re-encode the
    // call around it rather than trusting a caller's calldata.
    const context = auth.authorization;
    const executionData = encodeSingleExecution(execution);
    const data = encodeRedeemDelegationsWithContext(context, executionData);
    return { chainId: auth.delegationChainId, data };
  }

  /**
   * Sign the session key's redemption transaction.
   *
   * `digest` is the signing hash of `outerTx`, computed by the caller (core
   * has no EVM transaction encoder). What is checked: `outerTx` is exactly
   * the redemption of this key's delegation for `execution` on its chain,
   * with value 0; `execution` passes the session scope off chain; usage is
   * recorded before the signature is returned. The digest itself is not
   * derived here, so a caller holding the manager could have the key sign
   * another transaction or message from its own address. The owner's assets
   * still move only through the delegation, whose caveats — including
   * RedeemerEnforcer pinning this key as the only redeemer, so a
   * re-delegation it is tricked into signing cannot be redeemed — the chain
   * enforces regardless of what the key signs. The exposure left is the
   * key's own gas funds.
   */
  async signDelegationRedemption(
    sessionId: string,
    digest: `0x${string}`,
    outerTx: {
      to?: string;
      value?: string;
      data?: string;
      chainId?: number;
      /** The redemption's gas limit, checked against maxGasPerTx / maxTotalGas. */
      gas?: string;
    },
    execution: FrameworkExecution,
  ): Promise<`0x${string}`> {
    return this.storage.withKeyLock(sessionId, () =>
      this.withSessionLock(sessionId, async () => {
        const stored = await this.readStoredSession(sessionId);
        if (!stored) {
          throw createSessionKeyError("session_key_not_found", sessionId);
        }
        this.validateSessionStatus(stored);
        const { chainId, data } = this.redemptionFor(stored, execution);
        if (
          outerTx.chainId !== chainId ||
          !outerTx.to ||
          outerTx.to.toLowerCase() !==
            DELEGATION_FRAMEWORK.delegationManager.toLowerCase() ||
          BigInt(outerTx.value ?? "0") !== 0n ||
          (outerTx.data ?? "").toLowerCase() !== data.toLowerCase()
        ) {
          throw createSessionKeyError(
            "session_key_scope_exceeded",
            "The transaction is not this key's redemption for the execution",
          );
        }
        // The execution is what the scope governs; gas is the key's own spend
        // on the transaction it sends, so it comes from the outer transaction.
        return this.signStoredSessionKey(stored, digest, {
          to: execution.target,
          value: `0x${execution.value.toString(16)}`,
          data: execution.callData,
          chainId,
          ...(outerTx.gas !== undefined ? { gas: outerTx.gas } : {}),
        });
      }),
    );
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
      allowedRecipients: scope?.allowedRecipients ?? undefined,
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
      scope.allowedRecipients?.some(
        (address) =>
          !isValidAddress(address, "eip155") || isZeroAddress(address),
      )
    ) {
      throw createSessionKeyError(
        "session_key_invalid_input",
        "allowedRecipients must contain non-zero EVM addresses",
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
    if (scope.allowedRecipients && scope.allowedRecipients.length > 0) {
      // The recipient is knowable for exactly two shapes; anything else is
      // refused rather than guessed.
      const hasCalldata = Boolean(tx.data && tx.data !== "0x");
      const recipient = tokenSpendResult.spend
        ? tokenSpendResult.spend.recipient
        : hasCalldata
          ? undefined
          : tx.to;
      if (!recipient) {
        return {
          valid: false,
          reason:
            "Recipient allowlist is set but this call has no recognizable recipient",
        };
      }
      const lower = recipient.toLowerCase();
      if (!scope.allowedRecipients.some((r) => r.toLowerCase() === lower)) {
        return {
          valid: false,
          reason: `Recipient ${recipient} not in allowed list`,
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

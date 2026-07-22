/**
 * Session Keys / Ephemeral Keys — Type Definitions
 *
 * Defines the core types for session key creation, storage,
 * authorization, and scope-based transaction control.
 *
 * @see docs/features/session-keys.md
 */

// ─── Session Key Scope ─────────────────────────────────────────────────

/**
 * Defines the permitted scope for a session key.
 *
 * All numeric limits are best-effort enforced client-side.
 * For on-chain enforcement, use EIP-7702 or AA module delegation.
 */
export interface SessionKeyScope {
  /** Unix timestamp (seconds) after which the key expires */
  expiry: number;

  /** Maximum total gas across all transactions (wei) */
  maxTotalGas?: bigint;

  /** Maximum gas per single transaction (wei) */
  maxGasPerTx?: bigint;

  /** Maximum total value of assets transferred (wei / token base units) */
  maxTotalValue?: bigint;

  /** Maximum value per single transaction */
  maxValuePerTx?: bigint;

  /** Maximum number of transactions this key can sign */
  maxTxCount?: number;

  /** Allowed target contract addresses (empty = any contract) */
  allowedContracts?: `0x${string}`[];

  /** Allowed method selectors (4-byte hex, empty = any method) */
  allowedMethods?: string[];

  /** Per-token allowances: token address → max amount in token base units */
  tokenAllowances?: Record<`0x${string}`, bigint>;

  /** Chain IDs this key is valid for (empty = any chain) */
  allowedChainIds?: number[];

  /** Session type: off-chain agreement, EIP-7702 delegation, or AA module */
  mode: "offchain" | "eip7702" | "aa_module";
}

// ─── Key Pair ──────────────────────────────────────────────────────────

/** A secp256k1 key pair (private key NEVER persisted unencrypted) */
export interface SessionKeyPair {
  publicKey: `0x${string}`;
  privateKey: `0x${string}`;
}

// ─── Encrypted Storage ─────────────────────────────────────────────────

/** Encrypted session key data for local storage */
export interface EncryptedKeyPair {
  publicKey: `0x${string}`;
  encryptedPrivateKey: string; // AES-256-GCM ciphertext (hex)
  iv: string; // Initialization vector (hex)
  salt: string; // KDF salt (hex)
}

// ─── Authorization ─────────────────────────────────────────────────────

/** Authorization signature from the main wallet */
export interface SignedAuthorization {
  /** EIP-7702 authorization bytes (if mode === "eip7702") */
  authorization?: `0x${string}`;

  /** Off-chain signature of scope hash (if mode === "offchain") */
  rawSignature?: `0x${string}`;

  /** Main wallet address that signed this authorization */
  signerAddress: `0x${string}`;

  /** Authorization type */
  type: "eip7702" | "offchain" | "aa_module";
}

// ─── Persisted Session Key ─────────────────────────────────────────────

/** Full session key record stored locally (private key encrypted) */
export interface StoredSessionKey {
  /** Unique session key ID (UUID v4) */
  id: string;

  /** Encrypted key pair for secure persistence */
  keyPair: EncryptedKeyPair;

  /** Authorized scope */
  scope: SessionKeyScope;

  /** Main wallet's authorization signature */
  authorization: SignedAuthorization;

  /** Current status */
  status: SessionKeyStatus;

  /** Creation timestamp (Unix ms) */
  createdAt: number;

  /** Last usage timestamp (Unix ms) */
  lastUsedAt: number;

  /** Number of transactions signed with this key */
  useCount: number;
}

// ─── Public Info (no private key exposure) ─────────────────────────────

/** Session key public info — safe to expose to UI */
export interface SessionKeyInfo {
  id: string;
  publicKey: `0x${string}`;
  scope: SessionKeyScope;
  status: SessionKeyStatus;
  createdAt: number;
  expiresAt: number;
  useCount: number;
  signerAddress: `0x${string}`;
}

// ─── Session Key Status ────────────────────────────────────────────────

export type SessionKeyStatus = "active" | "revoked" | "expired";

// ─── Decrypted Session Key Bundle (memory only) ────────────────────────

/** Decrypted session key ready for signing (memory only) */
export interface SessionKeyBundle {
  id: string;
  privateKey: `0x${string}`;
  scope: SessionKeyScope;
  authorization: SignedAuthorization;
  /** The main wallet address that authorized this session */
  signerAddress: `0x${string}`;
}

// ─── Scope Check Result ────────────────────────────────────────────────

export interface ScopeCheckResult {
  valid: boolean;
  reason?: string;
  remainingGas?: bigint;
  remainingValue?: bigint;
  remainingTxCount?: number;
}

// ─── Session Key Manager Config ────────────────────────────────────────

export interface SessionKeyManagerConfig {
  /** Storage key prefix (default: "naculus_session_keys") */
  storagePrefix?: string;
  /** Default max total value for new session keys (wei, default: 0.1 ETH) */
  defaultMaxTotalValue?: bigint;
  /** Default max transactions per key (default: 50) */
  defaultMaxTxCount?: number;
  /** Default max session duration in ms (default: 24h) */
  defaultExpiryMs?: number;
  /** Whether to require allowedContracts (default: true) */
  requireAllowedContracts?: boolean;
  /** Forbidden method selectors (default: approve, permit) */
  forbiddenMethods?: string[];
  /** Key derivation salt for encryption (auto-generated if not provided) */
  encryptionSalt?: string;
  /** Password-derived encryption key (hex string). If not provided, a random one is generated on first use. */
  encryptionKey?: string;

  /**
   * PBKDF2 iteration count for key derivation.
   * Default: 600_000 (OWASP recommended for AES-256 in 2025).
   * Set lower (e.g. 1000) for testing to avoid timeout.
   */
  pbkdf2Iterations?: number;
}

// ─── Defaults ──────────────────────────────────────────────────────────

export const DEFAULT_SESSION_KEY_CONFIG: Required<SessionKeyManagerConfig> = {
  storagePrefix: "naculus_session_keys",
  defaultMaxTotalValue: BigInt("100000000000000000"), // 0.1 ETH
  defaultMaxTxCount: 50,
  defaultExpiryMs: 24 * 60 * 60 * 1000, // 24 hours
  requireAllowedContracts: true,
  forbiddenMethods: [
    "0x095ea7b3", // approve(address,uint256)
    "0xdd62ed3e", // allowance(address,address)
    "0xa22cb465", // setApprovalForAll(address,bool)
  ],
  encryptionSalt: "",
  encryptionKey: "",
  pbkdf2Iterations: 600_000,
};

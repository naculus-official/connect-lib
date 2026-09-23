/**
 * @naculus/wallet-engine — Embedded Wallet
 *
 * Self-custodial embedded wallet using BIP39 + HD key derivation.
 * Default storage: IndexedDB (async and origin-scoped, but not encrypted or
 * XSS-proof).
 * Falls back to localStorage (base64-encoded JSON) only when IndexedDB
 * is unavailable — with an explicit user warning.
 * Supports EVM signing (personal_sign, eth_sendTransaction).
 *
 * Design goals:
 * - Zero dependency on @naculus/connect-core (fully independent)
 * - Pluggable StorageAdapter for browser / Tauri / React Native
 * - Low barrier for non-web3 users ("EasyCard mode")
 * - Storage choices are explicit: IndexedDB is origin-scoped, and either
 *   backend can be wrapped with AES-256-GCM when a passphrase is supplied.
 */

export type { DetectedKey, KeyNamespace } from "./derivation/key-formats";
export {
  detectPrivateKey,
  toEvmPrivateKeyHex,
  toSolanaKeypairJson,
  toSolanaPrivateKeyBase58,
} from "./derivation/key-formats";
export type { Slip10Node } from "./derivation/slip10";
export {
  deriveEd25519,
  ed25519DeriveChild,
  ed25519MasterNode,
  parseHardenedPath,
} from "./derivation/slip10";
export type { SolanaKeypair } from "./derivation/solana";
// ── Key derivation ────────────────────────────────────────────────
export {
  deriveSolanaKeypair,
  SOLANA_DERIVATION_PATH,
  toSolanaSecretKeyBytes,
} from "./derivation/solana";
export { WalletError } from "./errors";
// ── Solana transaction wire format ────────────────────────────────
export type { ShortVec, SolanaTransactionLayout } from "./solana/transaction";
export {
  decodeShortVec,
  isFullySigned,
  parseSolanaTransaction,
  signSolanaTransaction,
  toBase64,
  toWireBytes,
} from "./solana/transaction";
// Session Keys
// Client-side session keys for automatic transaction signing
// without popping the wallet modal for every transaction.
export { SessionKeyManager } from "./session-keys/SessionKeyManager";
export type {
  ScopeCheckResult,
  SessionKeyBundle,
  SessionKeyInfo,
  SessionKeyPair,
  SessionKeyScope,
  SessionKeyStatus,
  SessionSignResult,
  SignedAuthorization,
  StoredSessionKey,
} from "./session-keys/types";
export { EVMSigner } from "./signers/evm";
export type {
  Eip7702AuthorizationOptions,
  Eip7702AuthorizationRequest,
  Signer,
  SignedEip7702Authorization,
  SignRequest,
  SignResult,
} from "./signers/types";
export { EthCallProvider } from "./simulation/providers/eth-call";
export type { SimulationProvider } from "./simulation/providers/types";
// Transaction Simulation
// Self-contained simulation module using eth_call (no external API dependency)
export { SimulationManager } from "./simulation/SimulationManager";
export type {
  ApprovalChange,
  BalanceChange,
  GasInfo,
  RiskAssessment,
  RiskLevel,
  RiskWarning,
  RiskWarningCategory,
  RiskWarningSeverity,
  SimulationConfig,
  SimulationCoverage,
  SimulationProviderName,
  SimulationResult,
  SimulationStatus,
  TransactionDescriptor,
} from "./simulation/types";
export type { EncryptedStorageOptions } from "./storage/encrypted";
export { EncryptedStorageAdapter } from "./storage/encrypted";
export type {
  StorageFindingSeverity,
  StorageSecurityFinding,
  StorageSecurityInput,
  StorageSecurityReport,
} from "./storage/security";
export { assessStorageSecurity } from "./storage/security";
export { IndexedDbStorageAdapter } from "./storage/indexed-db";
export { LocalStorageAdapter } from "./storage/local-storage";
export type {
  StorageAdapter,
  StorageSecurityLevel,
  StorageType,
} from "./storage/types";
export type {
  PrfAvailability,
  PrfUnlockProvider,
  UnlockMethod,
  UnlockState,
} from "./storage/unlock";
export { derivePrfWrappingKey } from "./storage/unlock";
export { TxPoller } from "./tx-monitor/poller";
export {
  MemoryHistoryStorage,
  TxHistoryStore,
} from "./tx-monitor/TxHistoryStore";
// Transaction Monitor
export { TxMonitor } from "./tx-monitor/TxMonitor";
export type {
  ProviderLike,
  TxHistoryQuery,
  TxStatus,
  TxStatusEntry,
  WatchTxOptions,
} from "./tx-monitor/types";
export {
  migrateWalletData,
  type PocketConfig,
  PocketWallet,
  type WalletAccount,
  type WalletData,
  type WalletDataV1,
  type WalletNamespace,
} from "./wallet";

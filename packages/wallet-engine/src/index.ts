/**
 * @naculus/wallet-engine — Embedded Wallet
 *
 * Self-custodial embedded wallet using BIP39 + HD key derivation.
 * Default storage: IndexedDB (secure, async, origin-isolated).
 * Falls back to localStorage (base64-encoded JSON) only when IndexedDB
 * is unavailable — with an explicit user warning.
 * Supports EVM signing (personal_sign, eth_sendTransaction).
 *
 * Design goals:
 * - Zero dependency on @naculus/connect-core (fully independent)
 * - Pluggable StorageAdapter for browser / Tauri / React Native
 * - Low barrier for non-web3 users ("EasyCard mode")
 * - Security-first storage: IndexedDB > localStorage, AES-256-GCM encryptable
 */

export { WalletError } from "./errors";
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
export type { Signer, SignRequest, SignResult } from "./signers/types";
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
  SimulationProviderName,
  SimulationResult,
  SimulationStatus,
  TransactionDescriptor,
} from "./simulation/types";
export { EncryptedStorageAdapter } from "./storage/encrypted";
export { IndexedDbStorageAdapter } from "./storage/indexed-db";
export { LocalStorageAdapter } from "./storage/local-storage";
export type {
  StorageAdapter,
  StorageSecurityLevel,
  StorageType,
} from "./storage/types";
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
export { type PocketConfig, PocketWallet, type WalletData } from "./wallet";

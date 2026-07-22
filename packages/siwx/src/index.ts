/**
 * @naculus/siwx — CAIP-122 Sign-In With X
 *
 * Chain-agnostic SIWx message creation, parsing, verification, and utilities.
 * Supports EVM (EIP-4361), Solana, XRPL, and other CAIP-122 compliant chains.
 */

export {
  verifyCosmwasmSignInMessage,
  verifyPolkadotSignInMessage,
  verifyStarknetSignInMessage,
} from "./chain-verifiers/index";
export {
  createSiwxMessage,
  DEFAULT_NONCE_LENGTH,
  getBlockchainName,
  isSiwxMessage,
  parseSiwxMessage,
  SIWX_VERSION,
} from "./message";
export type {
  SessionChangeCallback,
  SessionExpiryCallback,
  SiwxRefreshParams,
  SiwxSession,
  SiwxSessionManagerOptions,
  SiwxSignInParams,
} from "./session";
// ── Session Management ──────────────────────────────────────────
export {
  DEFAULT_SESSION_EXPIRY_SECONDS,
  DEFAULT_SESSION_STORAGE_KEY,
  SiwxSessionManager,
} from "./session";
export type { SiwxSessionStorage } from "./session-storage";
// ── Session Storage ────────────────────────────────────────────
export {
  checkSessionExpired,
  createLocalStorageSiwxSessionStorage,
  createMemorySiwxSessionStorage,
} from "./session-storage";
export type {
  ChainNamespace,
  SiwxMessage,
  SiwxParams,
  SiwxResult,
  SiwxVerificationResult,
} from "./types";
export {
  addSecondsISO,
  generateNonce,
  isValidDomain,
  isValidNonce,
  nowISO,
  parseChainId,
} from "./utils";
export type {
  VerifyOptions,
  VerifySiwxMessageParams,
} from "./verify";
export {
  createEVMVerifier,
  createSolanaVerifier,
  createXRPLVerifier,
  verifySiwxMessage,
} from "./verify";

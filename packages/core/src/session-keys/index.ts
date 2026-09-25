/**
 * Session Keys / Ephemeral Keys Module
 *
 * Short-lived, scoped cryptographic keys that enable automated
 * transaction signing without repeated wallet popups.
 *
 * @see docs/features/session-keys.md
 */

export type { SessionKeyErrorCode } from "./errors";
export { createSessionKeyError, SESSION_KEY_ERROR_MESSAGES } from "./errors";
export { SessionKeyManager } from "./SessionKeyManager";
export {
  decryptPrivateKey,
  encryptPrivateKey,
  SessionKeyStorage,
} from "./storage";

export type {
  EncryptedKeyPair,
  ScopeCheckResult,
  SessionKeyBundle,
  SessionKeyInfo,
  SessionKeyManagerConfig,
  SessionKeyPair,
  SessionKeyScope,
  SessionKeyTransaction,
  SessionKeyStatus,
  SignedAuthorization,
  StoredSessionKey,
} from "./types";

export { DEFAULT_SESSION_KEY_CONFIG } from "./types";
export {
  sessionKeyAddress,
  typedDataDigest,
  validateTypedDataRequest,
} from "./typed-data";
export type { SessionKeyTypedDataRequest } from "./typed-data";
export {
  ANY_DELEGATE,
  type BuildDelegationInput,
  buildDelegation,
  type CaveatOptions,
  caveatsFromScope,
  DELEGATION_FRAMEWORK,
  DELEGATION_FRAMEWORK_CHAIN_IDS,
  delegationHash,
  delegationSigningDigest,
  delegationTypedData,
  type FrameworkCaveat,
  type FrameworkDelegation,
  ROOT_AUTHORITY,
} from "./delegation-framework";

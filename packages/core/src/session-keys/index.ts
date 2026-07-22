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
  SessionKeyStatus,
  SignedAuthorization,
  StoredSessionKey,
} from "./types";

export { DEFAULT_SESSION_KEY_CONFIG } from "./types";

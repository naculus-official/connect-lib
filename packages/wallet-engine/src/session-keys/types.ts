// ── Session Key types ──────────────────────────────────────────
//
// The embedded wallet runs connect-core's SessionKeyManager, so its session
// key types are core's, re-exported for callers that import them from here.
//
// @see packages/core/src/session-keys/types.ts
// ───────────────────────────────────────────────────────────────

export type {
  EncryptedKeyPair,
  ScopeCheckResult,
  SessionKeyBundle,
  SessionKeyInfo,
  SessionKeyPair,
  SessionKeyScope,
  SessionKeyStatus,
  SignedAuthorization,
  StoredSessionKey,
} from "@naculus/connect-core";

// ── Session Key types ──────────────────────────────────────────
//
// Types that are identical to @naculus/connect-core are re-exported
// from there to avoid drift. Wallet-engine-specific extensions
// (accumulatedValue/accumulatedGas, SessionSignResult, bundle
// without signerAddress) are defined here.
//
// @see packages/core/src/session-keys/types.ts
// ───────────────────────────────────────────────────────────────

import type {
  EncryptedKeyPair as CoreEncryptedKeyPair,
  ScopeCheckResult as CoreScopeCheckResult,
  SessionKeyInfo as CoreSessionKeyInfo,
  SessionKeyPair as CoreSessionKeyPair,
  SessionKeyScope as CoreSessionKeyScope,
  SessionKeyStatus as CoreSessionKeyStatus,
  SignedAuthorization as CoreSignedAuthorization,
  StoredSessionKey as CoreStoredSessionKey,
} from "@naculus/connect-core";

// ─── Re-export identical types ─────────────────────────────────

export type SessionKeyScope = CoreSessionKeyScope;
export type SessionKeyPair = CoreSessionKeyPair;
export type EncryptedKeyPair = CoreEncryptedKeyPair;
export type SignedAuthorization = CoreSignedAuthorization;
export type SessionKeyInfo = CoreSessionKeyInfo;
export type ScopeCheckResult = CoreScopeCheckResult;
export type SessionKeyStatus = CoreSessionKeyStatus;

// ─── Wallet-engine-specific extensions ─────────────────────────

/** Full session key data stored locally */
export interface StoredSessionKey extends CoreStoredSessionKey {
  /** Accumulated spent value (wei), used for maxTotalValue check */
  accumulatedValue?: bigint;
  /** Accumulated spent gas (wei), used for maxTotalGas check */
  accumulatedGas?: bigint;
}

/** Session key bundle (includes decrypted data, used for signing) */
export interface SessionKeyBundle {
  id: string;
  privateKey: `0x${string}`;
  scope: SessionKeyScope;
  authorization: SignedAuthorization;
}

/** Transaction signing result (with session key context) */
export interface SessionSignResult {
  signature: `0x${string}`;
  sessionId: string;
}

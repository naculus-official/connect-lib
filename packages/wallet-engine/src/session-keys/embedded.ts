/**
 * The embedded wallet's session keys run on connect-core's SessionKeyManager.
 *
 * wallet-engine used to carry its own, weaker copy: no token allowances, no
 * forbidden selectors, no owner-authorization requirement, no cross-tab lock,
 * and it signed before persisting usage (docs/design/session-keys-convergence.md).
 * The copy is gone. wallet-engine now only builds the transaction and its
 * signing hash; core checks the policy against that same transaction, signs
 * the hash, and accounts the usage before returning the signature.
 */
import {
  LocalStorageAdapter as CoreLocalStorageAdapter,
  type StorageAdapter as CoreStorageAdapter,
  MemoryStorageAdapter,
  SessionKeyManager,
  type SessionKeyManagerConfig,
} from "@naculus/connect-core";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * Where wallet-engine's pre-0.3.0 session-key copy kept its records. Nothing
 * reads or writes this key any more, and nothing deletes it: those keys were
 * EOAs that users funded, and the encrypted record is the only copy of each
 * private key. A 0.2.x build can still decrypt it to move the funds.
 */
export const LEGACY_SESSION_KEYS_STORAGE_KEY = "naculus_session_keys";

/** Key prefix for the embedded wallet's session keys in localStorage. */
export const EMBEDDED_SESSION_KEYS_PREFIX = "naculus_embedded_";

export interface EmbeddedSessionKeyOptions {
  /**
   * Where the encrypted session-key records live. Defaults to localStorage
   * under `naculus_embedded_`, or memory when localStorage is unavailable.
   */
  storage?: CoreStorageAdapter;
  /**
   * Policy defaults and KDF settings passed to the core manager. The
   * encryption key is always derived from the wallet's seed.
   */
  config?: Omit<
    SessionKeyManagerConfig,
    "encryptionKey" | "encryptionSalt" | "storagePrefix"
  >;
}

/**
 * The key session-key records are sealed with: derived from the wallet's
 * seed, so it is exactly as available as the wallet itself — the same key
 * boundary the old copy used, domain-separated from every other use of the
 * seed.
 */
export function sessionKeyEncryptionKey(seed: Uint8Array): string {
  const label = new TextEncoder().encode("naculus/embedded-session-keys/v1");
  const input = new Uint8Array(seed.length + label.length);
  input.set(seed);
  input.set(label, seed.length);
  return bytesToHex(sha256(input));
}

/**
 * A fingerprint of the mnemonic, so the cached manager can tell which wallet
 * it belongs to without keeping the mnemonic itself in memory.
 */
export function mnemonicFingerprint(mnemonic: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(mnemonic)));
}

export function createEmbeddedSessionKeyManager(
  seed: Uint8Array,
  options: EmbeddedSessionKeyOptions = {},
): SessionKeyManager {
  let storage = options.storage;
  if (!storage) {
    const local = new CoreLocalStorageAdapter(EMBEDDED_SESSION_KEYS_PREFIX);
    storage = local.isAvailable() ? local : new MemoryStorageAdapter();
  }
  return new SessionKeyManager(
    { ...options.config, encryptionKey: sessionKeyEncryptionKey(seed) },
    storage,
  );
}

/** The statement the wallet signs to authorize one of its session keys. */
export function sessionAuthorizationMessage(input: {
  owner: string;
  sessionId: string;
  sessionKeyAddress: string;
  scope: unknown;
}): string {
  const scope = JSON.stringify(input.scope, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  return [
    "Naculus embedded wallet: authorize session key",
    `Owner: ${input.owner}`,
    `Session: ${input.sessionId}`,
    `Session key: ${input.sessionKeyAddress}`,
    `Scope: ${scope}`,
  ].join("\n");
}

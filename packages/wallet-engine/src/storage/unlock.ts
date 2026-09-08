/**
 * Unlock sources for encrypted wallet storage.
 *
 * What decides whether an attacker can read a stored wallet is not the cipher
 * — it is what supplies the key. A passphrase callback that returns a constant
 * puts the threshold at "any script on this origin". WebAuthn PRF raises it to
 * "this user, on this authenticator".
 *
 * This module defines the seam only. The PRF evaluation itself belongs to
 * whatever owns the credential (`@naculus/connector-passkeys`), because
 * wallet-engine must stay free of connector dependencies — the dependency
 * direction is one-way and this is the bottom of it.
 */

/** Which source produced the key that sealed a wrap. */
export type UnlockMethod = "passphrase" | "prf";

/**
 * Evaluates the WebAuthn PRF extension for a salt.
 *
 * Returns 32 bytes, or null when this cannot work right now: the platform has
 * no PRF, the credential was created before the extension was requested, or
 * the user declined. Null rather than throwing is deliberate — a caller must
 * be able to fall back rather than lock someone out of their own wallet.
 */
export interface PrfUnlockProvider {
  derive(salt: Uint8Array): Promise<Uint8Array | null>;
}

/**
 * What the unlock layer can do right now, for a security dashboard.
 *
 * `"unknown"` is a distinct answer from `"unavailable"`. Before any read or
 * write the adapter has not asked the authenticator anything, and reporting
 * that as "not supported" would tell a user their device cannot do something
 * it may well do.
 */
export type PrfAvailability = "unknown" | "available" | "unavailable" | "none";

export interface UnlockState {
  /**
   * - `none`       — no PRF provider was configured
   * - `unknown`    — configured, not yet exercised
   * - `available`  — the authenticator produced key material
   * - `unavailable`— asked, and it cannot (Firefox, pre-PRF credential, declined)
   */
  prf: PrfAvailability;
  /**
   * Which wraps the stored record actually carries, or null when no record has
   * been read or written in this session. An empty array would claim the
   * record has no wraps, which is a different and false statement.
   */
  sealedWith: UnlockMethod[] | null;
}

/** Domain separation for the storage key, so a future second use of PRF
 *  — a session token, say — cannot produce the same bytes. */
const HKDF_INFO = "naculus/wallet-storage/v1";

/**
 * Turn raw PRF output into an AES-256-GCM key.
 *
 * HKDF, not PBKDF2. PBKDF2's iteration count exists to make a low-entropy
 * human passphrase expensive to guess; PRF output is 32 uniformly random bytes
 * bound to an authenticator, so stretching it buys nothing and costs 600k
 * iterations on every unlock.
 */
export async function derivePrfWrappingKey(
  prfOutput: Uint8Array,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    prfOutput as unknown as BufferSource,
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as unknown as BufferSource,
      info: new TextEncoder().encode(HKDF_INFO) as unknown as BufferSource,
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

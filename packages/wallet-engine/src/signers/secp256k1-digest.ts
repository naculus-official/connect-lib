/**
 * Sign a digest that is already hashed, and return what EVM signing needs.
 *
 * This exists because `@noble/curves` 2.x changed two things at once, and both
 * of them are silent.
 *
 * **`prehash` now defaults to `true`.** In 1.x, `sign(digest, key)` signed the
 * bytes it was given. In 2.x the same call hashes them again with SHA-256 and
 * signs that. Every caller here passes a keccak-256 digest, so on the default
 * the library would sign `sha256(keccak256(payload))` — a perfectly valid
 * signature over bytes no chain asked about, recovering to an address the user
 * does not control. Nothing about that is a type error.
 *
 * **`sign` no longer returns an object.** 1.x gave a `Signature` carrying
 * `recovery`; 2.x returns raw bytes, and yields the recovery id only when asked
 * for `format: "recovered"`, where it is the 65th byte.
 *
 * Nine call sites needed the same three lines to get both right. They are here
 * instead, so the contract is stated once and verified once —
 * `crypto-fingerprint.mjs` pins the compact signature and the recovery id for a
 * known key and digest, and both are unchanged from 1.x.
 *
 * The curve module is a parameter rather than an import on purpose. Every
 * caller already reaches it through `await import("@noble/curves/secp256k1.js")`
 * so the curve stays out of the eager bundle; importing it here would undo
 * that for anyone who loads a signer without signing anything.
 */

/** The one method this needs, in the 2.x shape. */
export interface Secp256k1Like {
  sign(
    digest: Uint8Array,
    privateKey: Uint8Array,
    options: { prehash: false; format: "recovered" },
  ): Uint8Array;
}

export interface DigestSignature {
  /** 64-byte r‖s. */
  compact: Uint8Array;
  /** 0 or 1. EVM callers add 27, or 35 + 2 × chainId for EIP-155. */
  recovery: number;
}

/**
 * @param secp256k1 The curve module the caller already imported.
 * @param digest A hash, not a message. Nothing here hashes for you.
 * @param privateKey 32-byte secp256k1 key.
 */
export function signDigest(
  secp256k1: Secp256k1Like,
  digest: Uint8Array,
  privateKey: Uint8Array,
): DigestSignature {
  const signature = secp256k1.sign(digest, privateKey, {
    prehash: false,
    format: "recovered",
  });
  return {
    compact: signature.subarray(1),
    recovery: signature[0] as number,
  };
}

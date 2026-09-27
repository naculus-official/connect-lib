import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { WalletError } from "./errors";

/**
 * AES-256-GCM without WebCrypto, for runtimes that have none (React Native:
 * no `crypto.subtle`). Output is `iv (12) ‖ ciphertext ‖ tag (16)`; `aad`,
 * when given, must match on open. The 32-byte key comes from the caller —
 * e.g. a random key held in iOS Keychain / Android Keystore.
 */
export function aesGcmSeal(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  if (key.length !== 32) {
    throw new WalletError("invalid_input", "AES-256-GCM needs a 32-byte key.");
  }
  const iv = randomBytes(12);
  const sealed = gcm(key, iv, aad).encrypt(plaintext);
  const out = new Uint8Array(12 + sealed.length);
  out.set(iv);
  out.set(sealed, 12);
  return out;
}

/** Open `aesGcmSeal` output; throws on a wrong key, aad or altered bytes. */
export function aesGcmOpen(
  key: Uint8Array,
  sealed: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  if (key.length !== 32) {
    throw new WalletError("invalid_input", "AES-256-GCM needs a 32-byte key.");
  }
  if (sealed.length < 12 + 16) {
    throw new WalletError("decryption_failed", "Sealed data is too short.");
  }
  try {
    return gcm(key, sealed.subarray(0, 12), aad).decrypt(sealed.subarray(12));
  } catch {
    throw new WalletError(
      "decryption_failed",
      "Sealed data does not open: wrong key or altered data.",
    );
  }
}

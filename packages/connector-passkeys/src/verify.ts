/**
 * Verify a WebAuthn assertion.
 *
 * The connector stored a credential's public key from the moment it was
 * created and never used it. Producing signatures nobody checks is not an
 * authentication mechanism — it only looks like one, which is worse than
 * having none, because a caller reasonably assumes a returned signature meant
 * something.
 *
 * What a signature covers, per the WebAuthn spec:
 *
 *     signature = sign( authenticatorData ‖ SHA-256(clientDataJSON) )
 *
 * So verification needs both halves, and the checks below are not optional
 * extras — each one closes a specific attack:
 *
 * - **challenge**: without it a captured assertion replays forever
 * - **origin**: without it a phishing site's assertion is accepted
 * - **rpIdHash**: without it a credential for another site is accepted
 * - **user-verified flag**: without it "presence" passes as "verified"
 */

import { WalletError } from "@naculus/connect-core";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha2";
import type { PasskeyAssertion } from "./index";

export interface VerifyOptions {
  /** The exact challenge that was issued, as bytes. */
  expectedChallenge: Uint8Array;
  /** The origin this application is served from, e.g. "https://app.example". */
  expectedOrigin: string;
  /** The relying party ID the credential was created for, e.g. "example.com". */
  expectedRpId: string;
  /** COSE-format or SPKI public key bytes stored at registration. */
  publicKey: Uint8Array;
  /**
   * Require the authenticator to have verified the user, not merely detected
   * presence. Defaults to true, matching `userVerification: "required"` at
   * registration — accepting presence for a credential registered as verified
   * would silently downgrade it.
   */
  requireUserVerification?: boolean;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** base64url as WebAuthn uses it: no padding, `-` and `_` for `+` and `/`. */
function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (raw.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(raw)) {
    throw new WalletError("invalid_input", "Signature is not valid hex.");
  }
  const out = new Uint8Array(raw.length / 2);
  for (let i = 0; i < raw.length; i += 2) {
    out[i / 2] = Number.parseInt(raw.slice(i, i + 2), 16);
  }
  return out;
}

/**
 * Check an assertion against the challenge that was issued.
 *
 * Returns nothing on success and throws on any failure, so a caller cannot
 * accidentally treat a falsy return as a pass.
 */
export async function verifyPasskeyAssertion(
  assertion: PasskeyAssertion,
  options: VerifyOptions,
): Promise<void> {
  const clientDataBytes = new Uint8Array(assertion.clientDataJSON);
  let clientData: { type?: string; challenge?: string; origin?: string };
  try {
    clientData = JSON.parse(new TextDecoder().decode(clientDataBytes));
  } catch {
    throw new WalletError("invalid_input", "clientDataJSON is not valid JSON.");
  }

  if (clientData.type !== "webauthn.get") {
    // A registration response reused as an assertion would otherwise pass the
    // signature check while meaning something else entirely.
    throw new WalletError(
      "signature_rejected",
      `Expected an assertion, got "${clientData.type}".`,
    );
  }

  if (typeof clientData.challenge !== "string") {
    throw new WalletError(
      "signature_rejected",
      "Assertion carries no challenge.",
    );
  }
  if (
    !bytesEqual(
      base64UrlToBytes(clientData.challenge),
      options.expectedChallenge,
    )
  ) {
    throw new WalletError(
      "signature_rejected",
      "Assertion answers a different challenge; it may be a replay.",
    );
  }

  if (clientData.origin !== options.expectedOrigin) {
    throw new WalletError(
      "signature_rejected",
      `Assertion came from ${clientData.origin}, not ${options.expectedOrigin}.`,
    );
  }

  const authData = new Uint8Array(assertion.authenticatorData);
  if (authData.length < 37) {
    throw new WalletError("invalid_input", "authenticatorData is too short.");
  }

  const expectedRpIdHash = sha256(
    new TextEncoder().encode(options.expectedRpId),
  );
  if (!bytesEqual(authData.slice(0, 32), expectedRpIdHash)) {
    throw new WalletError(
      "signature_rejected",
      "Assertion is for a different relying party.",
    );
  }

  const flags = authData[32];
  if ((flags & 0x01) === 0) {
    throw new WalletError(
      "signature_rejected",
      "User presence flag is not set.",
    );
  }
  if ((options.requireUserVerification ?? true) && (flags & 0x04) === 0) {
    throw new WalletError(
      "signature_rejected",
      "User was not verified, only present.",
    );
  }

  // The signed bytes, exactly as the spec defines them.
  const signedData = new Uint8Array(authData.length + 32);
  signedData.set(authData);
  signedData.set(sha256(clientDataBytes), authData.length);

  const publicKey = normalizeP256PublicKey(options.publicKey);
  const ok = p256.verify(
    hexToBytes(assertion.signature),
    sha256(signedData),
    publicKey,
    { prehash: false, format: "der" },
  );
  if (!ok) {
    throw new WalletError("signature_rejected", "Signature does not verify.");
  }
}

/**
 * Accept the public key in either form the platform hands back.
 *
 * `getPublicKey()` returns SPKI DER; some paths carry the raw uncompressed
 * point. Both end in the same 65 bytes, so the last 65 starting with 0x04 is
 * the point either way.
 */
function normalizeP256PublicKey(key: Uint8Array): Uint8Array {
  if (key.length === 65 && key[0] === 0x04) return key;
  const start = key.length - 65;
  if (start >= 0 && key[start] === 0x04) return key.slice(start);
  throw new WalletError(
    "invalid_input",
    "Public key is not an uncompressed P-256 point or SPKI wrapping one.",
  );
}

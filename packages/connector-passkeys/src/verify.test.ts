import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import type { PasskeyAssertion } from "./index";
import { verifyPasskeyAssertion } from "./verify";

/**
 * These build a real assertion with a real P-256 key and verify it, rather
 * than mocking the crypto. Every negative case is a specific attack the check
 * exists to stop: a replayed challenge, a phishing origin, a credential for
 * another site, presence passing as verification, a registration response
 * reused as an assertion.
 */

const RP_ID = "example.com";
const ORIGIN = "https://example.com";
const CHALLENGE = new Uint8Array(32).fill(7);

const privateKey = p256.utils.randomSecretKey();
const publicKey = p256.getPublicKey(privateKey, false);

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function authenticatorData(opts?: {
  rpId?: string;
  userVerified?: boolean;
  userPresent?: boolean;
}): Uint8Array {
  const data = new Uint8Array(37);
  data.set(sha256(new TextEncoder().encode(opts?.rpId ?? RP_ID)));
  let flags = 0;
  if (opts?.userPresent ?? true) flags |= 0x01;
  if (opts?.userVerified ?? true) flags |= 0x04;
  data[32] = flags;
  return data;
}

function makeAssertion(opts?: {
  challenge?: Uint8Array;
  origin?: string;
  type?: string;
  rpId?: string;
  userVerified?: boolean;
  userPresent?: boolean;
  signWithOtherKey?: boolean;
}): PasskeyAssertion {
  const clientData = new TextEncoder().encode(
    JSON.stringify({
      type: opts?.type ?? "webauthn.get",
      challenge: b64url(opts?.challenge ?? CHALLENGE),
      origin: opts?.origin ?? ORIGIN,
    }),
  );
  const authData = authenticatorData(opts);
  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData);
  signed.set(sha256(clientData), authData.length);

  const key = opts?.signWithOtherKey
    ? p256.utils.randomSecretKey()
    : privateKey;
  // sign() returns a Signature object; the authenticator sends DER bytes.
  const sig = p256.sign(sha256(signed), key, { prehash: false, format: "der" });

  return {
    credentialId: "cred-1",
    signature: Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join(""),
    authenticatorData: authData.buffer.slice(
      authData.byteOffset,
      authData.byteOffset + authData.byteLength,
    ) as ArrayBuffer,
    clientDataJSON: clientData.buffer.slice(
      clientData.byteOffset,
      clientData.byteOffset + clientData.byteLength,
    ) as ArrayBuffer,
    userHandle: null,
  };
}

const opts = {
  expectedChallenge: CHALLENGE,
  expectedOrigin: ORIGIN,
  expectedRpId: RP_ID,
  publicKey,
};

describe("verifyPasskeyAssertion", () => {
  it("accepts a genuine assertion", async () => {
    await expect(
      verifyPasskeyAssertion(makeAssertion(), opts),
    ).resolves.toBeUndefined();
  });

  it("rejects a replayed challenge", async () => {
    // Without this check a captured assertion is valid forever.
    const stale = makeAssertion({ challenge: new Uint8Array(32).fill(9) });
    await expect(verifyPasskeyAssertion(stale, opts)).rejects.toThrow(
      /different challenge/,
    );
  });

  it("rejects an assertion from another origin", async () => {
    // The phishing case: a real authenticator, a real signature, wrong site.
    const phished = makeAssertion({ origin: "https://evil.example" });
    await expect(verifyPasskeyAssertion(phished, opts)).rejects.toThrow(
      /not https:\/\/example\.com/,
    );
  });

  it("rejects a credential registered for another relying party", async () => {
    const wrongRp = makeAssertion({ rpId: "other.example" });
    await expect(verifyPasskeyAssertion(wrongRp, opts)).rejects.toThrow(
      /different relying party/,
    );
  });

  it("rejects presence when verification was required", async () => {
    // Registered with userVerification: "required"; accepting a mere touch
    // would silently downgrade the credential.
    const presenceOnly = makeAssertion({ userVerified: false });
    await expect(verifyPasskeyAssertion(presenceOnly, opts)).rejects.toThrow(
      /not verified, only present/,
    );
  });

  it("accepts presence when the caller says verification is not required", async () => {
    await expect(
      verifyPasskeyAssertion(makeAssertion({ userVerified: false }), {
        ...opts,
        requireUserVerification: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects an assertion with no user present at all", async () => {
    const absent = makeAssertion({ userPresent: false, userVerified: false });
    await expect(
      verifyPasskeyAssertion(absent, {
        ...opts,
        requireUserVerification: false,
      }),
    ).rejects.toThrow(/presence flag/);
  });

  it("rejects a registration response reused as an assertion", async () => {
    const wrongType = makeAssertion({ type: "webauthn.create" });
    await expect(verifyPasskeyAssertion(wrongType, opts)).rejects.toThrow(
      /Expected an assertion/,
    );
  });

  it("rejects a signature from a different key", async () => {
    const forged = makeAssertion({ signWithOtherKey: true });
    await expect(verifyPasskeyAssertion(forged, opts)).rejects.toThrow(
      /does not verify/,
    );
  });

  it("rejects a truncated authenticatorData", async () => {
    const a = makeAssertion();
    await expect(
      verifyPasskeyAssertion(
        { ...a, authenticatorData: new ArrayBuffer(10) },
        opts,
      ),
    ).rejects.toThrow(/too short/);
  });

  it("rejects malformed clientDataJSON", async () => {
    const a = makeAssertion();
    await expect(
      verifyPasskeyAssertion(
        {
          ...a,
          clientDataJSON: new TextEncoder().encode("{nope")
            .buffer as ArrayBuffer,
        },
        opts,
      ),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("accepts an SPKI-wrapped public key as well as a raw point", async () => {
    // getPublicKey() returns SPKI DER; other paths carry the raw point.
    const spki = new Uint8Array(26 + publicKey.length);
    spki.set(publicKey, 26);
    await expect(
      verifyPasskeyAssertion(makeAssertion(), { ...opts, publicKey: spki }),
    ).resolves.toBeUndefined();
  });
});

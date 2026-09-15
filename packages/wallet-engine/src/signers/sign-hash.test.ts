import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { EVMSigner } from "./evm";

/**
 * signHash is the primitive an ERC-4337 SimpleAccount needs.
 *
 * `_validateSignature` there does `userOpHash.toEthSignedMessageHash()` and
 * recovers the owner, so the signature must cover
 * keccak256("\x19Ethereum Signed Message:\n32" ‖ hash) — the 32 raw bytes, not
 * the 66 characters of their hex spelling. Getting that wrong produces a
 * perfectly valid signature over the wrong digest, which fails on chain rather
 * than in any test that only checks the signature parses.
 *
 * The expectations below are derived from @noble directly rather than from a
 * previous run of the implementation, so they cannot drift with it.
 */

const signer = new EVMSigner();
const PRIVATE_KEY =
  "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318" as const;
const HASH = `0x${"ab".repeat(32)}` as const;

/** What SimpleAccount hashes before ecrecover. */
function ethSignedMessageHash(hash: string): Uint8Array {
  const digest = hexToBytes(hash.slice(2));
  const prefix = new TextEncoder().encode("\x19Ethereum Signed Message:\n32");
  const payload = new Uint8Array(prefix.length + digest.length);
  payload.set(prefix);
  payload.set(digest, prefix.length);
  return keccak_256(payload);
}

function recover(signature: string, digest: Uint8Array): string {
  const raw = signature.slice(2);
  const r = BigInt(`0x${raw.slice(0, 64)}`);
  const s = BigInt(`0x${raw.slice(64, 128)}`);
  const v = Number.parseInt(raw.slice(128, 130), 16);
  const sig = new secp256k1.Signature(r, s).addRecoveryBit(v - 27);
  const point = sig.recoverPublicKey(digest);
  const uncompressed = point.toBytes(false).slice(1);
  return `0x${bytesToHex(keccak_256(uncompressed).slice(-20))}`;
}

const ownerAddress = (() => {
  const pub = secp256k1.getPublicKey(hexToBytes(PRIVATE_KEY.slice(2)), false);
  return `0x${bytesToHex(keccak_256(pub.slice(1)).slice(-20))}`;
})();

describe("EVMSigner.signHash", () => {
  it("produces a 65-byte signature", async () => {
    const { signature } = await signer.signHash(HASH, PRIVATE_KEY);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("recovers the owner from the digest SimpleAccount checks", async () => {
    const { signature } = await signer.signHash(HASH, PRIVATE_KEY);
    expect(recover(signature, ethSignedMessageHash(HASH))).toBe(ownerAddress);
  });

  it("signs the 32 bytes, not their hex spelling", async () => {
    // The bug this primitive exists to prevent: signMessage would prefix the
    // 66-character string, so the two must not agree.
    const viaHash = await signer.signHash(HASH, PRIVATE_KEY);
    const viaMessage = await signer.signMessage({ message: HASH }, PRIVATE_KEY);
    expect(viaHash.signature).not.toBe(viaMessage.signature);

    // And the text form must NOT recover the owner from the 32-byte digest.
    expect(
      recover(viaMessage.signature as string, ethSignedMessageHash(HASH)),
    ).not.toBe(ownerAddress);
  });

  it("is deterministic", async () => {
    // RFC 6979. Two different signatures for one message would leak the key
    // across a nonce collision.
    const a = await signer.signHash(HASH, PRIVATE_KEY);
    const b = await signer.signHash(HASH, PRIVATE_KEY);
    expect(a.signature).toBe(b.signature);
  });

  it("emits a low-s signature", async () => {
    // EIP-2 rejects the high half; a high-s signature is malleable.
    const { signature } = await signer.signHash(HASH, PRIVATE_KEY);
    const s = BigInt(`0x${(signature as string).slice(66, 130)}`);
    expect(s <= secp256k1.Point.Fn.ORDER / 2n).toBe(true);
  });

  it("emits v as 27 or 28", async () => {
    const { signature } = await signer.signHash(HASH, PRIVATE_KEY);
    const v = Number.parseInt((signature as string).slice(130, 132), 16);
    expect([27, 28]).toContain(v);
  });

  it.each([
    ["short", "0xabcd"],
    ["unprefixed", "ab".repeat(32)],
    ["not hex", `0x${"zz".repeat(32)}`],
    ["too long", `0x${"ab".repeat(33)}`],
  ])("refuses a %s digest", async (_label, bad) => {
    await expect(
      signer.signHash(bad as `0x${string}`, PRIVATE_KEY),
    ).rejects.toThrow();
  });

  it("refuses a malformed private key", async () => {
    await expect(
      signer.signHash(HASH, "0x00" as `0x${string}`),
    ).rejects.toThrow(/32-byte hex/);
  });

  it("refuses a key outside the curve order", async () => {
    const tooLarge = `0x${"f".repeat(64)}` as const;
    await expect(signer.signHash(HASH, tooLarge)).rejects.toThrow(
      /secp256k1 range/,
    );
  });

  it("different hashes give different signatures", async () => {
    const a = await signer.signHash(HASH, PRIVATE_KEY);
    const b = await signer.signHash(`0x${"cd".repeat(32)}`, PRIVATE_KEY);
    expect(a.signature).not.toBe(b.signature);
  });
});

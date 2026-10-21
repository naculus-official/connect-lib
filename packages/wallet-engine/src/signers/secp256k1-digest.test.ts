import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { signDigest } from "./secp256k1-digest";

const PRIVATE_KEY = hexToBytes(
  "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
);
const DIGEST = new Uint8Array(32).fill(0xab);

function addressFromPublicKey(publicKey: Uint8Array): string {
  return `0x${bytesToHex(keccak_256(publicKey.slice(1)).slice(-20))}`;
}

describe("signDigest", () => {
  it("returns a 65-byte signature that recovers the known key address", () => {
    const signature = signDigest(secp256k1, DIGEST, PRIVATE_KEY);
    const bytes = Uint8Array.from([...signature.compact, signature.recovery]);
    expect(bytes).toHaveLength(65);

    const compact = signature.compact;
    const recovered = new secp256k1.Signature(
      BigInt(`0x${bytesToHex(compact.slice(0, 32))}`),
      BigInt(`0x${bytesToHex(compact.slice(32))}`),
    )
      .addRecoveryBit(signature.recovery)
      .recoverPublicKey(DIGEST)
      .toBytes(false);
    expect(addressFromPublicKey(recovered)).toBe(
      "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23",
    );
  });

  it.each([31, 33])("rejects a %i-byte digest", (length) => {
    expect(() => signDigest(secp256k1, new Uint8Array(length), PRIVATE_KEY)).toThrow(
      `Digest must be exactly 32 bytes; received ${length} bytes.`,
    );
  });
});

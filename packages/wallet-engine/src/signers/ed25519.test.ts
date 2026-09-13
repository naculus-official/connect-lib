import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { deriveSolanaKeypair } from "../derivation/solana";
import { Ed25519Signer } from "./ed25519";

/**
 * Two properties here would each produce a signature Solana rejects if copied
 * from the EVM signer: the message must not be prefixed, and there is no
 * recovery id to emit. Both are asserted rather than assumed.
 */

const signer = new Ed25519Signer();
const SECRET = `0x${"11".repeat(32)}` as const;
const PUBLIC = ed25519.getPublicKey(hexToBytes(SECRET.slice(2)));

const sigBytes = (hex: string) => hexToBytes(hex.slice(2));

describe("Ed25519Signer.signMessage", () => {
  it("produces a signature the public key verifies", async () => {
    const message = "naculus";
    const { signature } = await signer.signMessage({ message }, SECRET);
    expect(
      ed25519.verify(
        sigBytes(signature),
        new TextEncoder().encode(message),
        PUBLIC,
      ),
    ).toBe(true);
  });

  it("signs the raw bytes with no prefix", async () => {
    // EIP-191 wraps a message before hashing; Solana does not. A prefix here
    // would verify against nothing any other wallet computes.
    const message = "naculus";
    const { signature } = await signer.signMessage({ message }, SECRET);
    const expected = ed25519.sign(
      new TextEncoder().encode(message),
      hexToBytes(SECRET.slice(2)),
    );
    expect(sigBytes(signature)).toEqual(expected);
  });

  it("emits a 64-byte signature", async () => {
    const { signature } = await signer.signMessage({ message: "x" }, SECRET);
    expect(signature).toMatch(/^0x[0-9a-f]{128}$/);
  });

  it("emits no recovery id", async () => {
    // ed25519 verification takes the public key as an input; there is nothing
    // to recover, so filling this in would be a placeholder pretending to be
    // a value.
    const result = await signer.signMessage({ message: "x" }, SECRET);
    expect(result.recovery).toBeUndefined();
  });

  it("handles non-ASCII exactly as UTF-8 bytes", async () => {
    const message = "簽章測試 🔑";
    const { signature } = await signer.signMessage({ message }, SECRET);
    expect(
      ed25519.verify(
        sigBytes(signature),
        new TextEncoder().encode(message),
        PUBLIC,
      ),
    ).toBe(true);
  });

  it("is deterministic", async () => {
    const a = await signer.signMessage({ message: "x" }, SECRET);
    const b = await signer.signMessage({ message: "x" }, SECRET);
    expect(a.signature).toBe(b.signature);
  });

  it.each(["0x11", "not-hex", `0x${"11".repeat(31)}`, ""])(
    "refuses the malformed key %o",
    async (key) => {
      await expect(
        signer.signMessage({ message: "x" }, key as `0x${string}`),
      ).rejects.toThrow(/32 bytes/);
    },
  );

  it("refuses a missing message", async () => {
    await expect(signer.signMessage({} as never, SECRET)).rejects.toThrow(
      /message string/,
    );
  });
});

describe("Ed25519Signer.signBytes", () => {
  it("signs pre-serialized transaction bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const { signature } = await signer.signBytes(bytes, SECRET);
    expect(ed25519.verify(sigBytes(signature), bytes, PUBLIC)).toBe(true);
  });

  it("refuses empty input", async () => {
    await expect(signer.signBytes(new Uint8Array(0), SECRET)).rejects.toThrow(
      /non-empty/,
    );
  });
});

describe("Ed25519Signer.signTransaction", () => {
  it("refuses, naming why an EVM request cannot describe a Solana transaction", async () => {
    await expect(
      signer.signTransaction({ to: "0x0" } as never, SECRET),
    ).rejects.toThrow(/Serialize the transaction with Solana tooling/);
  });
});

describe("end to end from a mnemonic", () => {
  it("signs with the key derived at the Solana path", async () => {
    // The whole chain: phrase → SLIP-0010 → ed25519 → a signature Solana
    // verifies against the address a user would see in Phantom.
    const bip39 = await import("@scure/bip39");
    const seed = await bip39.mnemonicToSeed(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    const keypair = deriveSolanaKeypair(seed);
    const message = "sign in to naculus";

    const { signature } = await signer.signMessage(
      { message },
      `0x${bytesToHex(keypair.secretKey)}`,
    );

    expect(
      ed25519.verify(
        sigBytes(signature),
        new TextEncoder().encode(message),
        base58.decode(keypair.address),
      ),
    ).toBe(true);
  });
});

import { ed25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import {
  deriveSolanaKeypair,
  SOLANA_DERIVATION_PATH,
  toSolanaSecretKeyBytes,
} from "./solana";

/**
 * The exit guarantee for Solana.
 *
 * A user must be able to take the same recovery phrase to Phantom, Solflare or
 * the Solana CLI and find the same account. That holds only while the path is
 * the one those wallets default to and the derivation is SLIP-0010.
 *
 * The expectations below are computed by a second implementation written
 * directly against the SLIP-0010 text, not recorded from `deriveSolanaKeypair`.
 * An implementation that only agrees with itself proves nothing.
 */

/** SLIP-0010 ed25519, written out longhand as an independent check. */
function independentDerive(seed: Uint8Array, path: string): Uint8Array {
  let I = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  let key = I.slice(0, 32);
  let chainCode = I.slice(32);

  for (const segment of path.split("/").slice(1)) {
    const match = /^(\d+)'$/.exec(segment);
    if (!match) throw new Error(`Invalid hardened path segment: ${segment}`);
    const value = Number.parseInt(match[1], 10);
    if (!Number.isSafeInteger(value) || value > 0x7fffffff) {
      throw new Error(`Hardened path segment is out of range: ${segment}`);
    }
    const index = value + 0x80000000;
    const data = new Uint8Array(37);
    data[0] = 0;
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, index, false);
    I = hmac(sha512, chainCode, data);
    key = I.slice(0, 32);
    chainCode = I.slice(32);
  }
  return key;
}

async function seedFrom(mnemonic: string): Promise<Uint8Array> {
  const bip39 = await import("@scure/bip39");
  return bip39.mnemonicToSeed(mnemonic);
}

const MNEMONICS = [
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
  "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
];

describe("Solana derivation", () => {
  it("uses the path Phantom, Solflare and Backpack default to", () => {
    // Stated explicitly so changing it has to change this test too. A path of
    // our own choosing would give a valid wallet at an address no other
    // software would ever show the user.
    expect(SOLANA_DERIVATION_PATH).toBe("m/44'/501'/0'/0'");
  });

  it("makes the independent vector reject malformed hardened segments", () => {
    const seed = new Uint8Array(64);
    expect(() => independentDerive(seed, "m/44/501'")).toThrow(
      /Invalid hardened path segment/,
    );
    expect(() => independentDerive(seed, "m/44''/501'")).toThrow(
      /Invalid hardened path segment/,
    );
    expect(() => independentDerive(seed, "m/2147483648'/501'")).toThrow(
      /out of range/,
    );
  });

  it.each(MNEMONICS)(
    "agrees with an independent SLIP-0010 derivation",
    async (mnemonic) => {
      const seed = await seedFrom(mnemonic);
      const expected = independentDerive(seed, SOLANA_DERIVATION_PATH);
      const keypair = deriveSolanaKeypair(seed);
      expect(keypair.secretKey).toEqual(expected);
    },
  );

  it("derives the address as base58 of the ed25519 public key", async () => {
    const seed = await seedFrom(MNEMONICS[0]);
    const keypair = deriveSolanaKeypair(seed);
    const expected = base58.encode(
      ed25519.getPublicKey(independentDerive(seed, SOLANA_DERIVATION_PATH)),
    );
    expect(keypair.address).toBe(expected);
  });

  it("produces an address of the length Solana uses", async () => {
    const seed = await seedFrom(MNEMONICS[0]);
    const { address, publicKey } = deriveSolanaKeypair(seed);
    expect(publicKey).toHaveLength(32);
    expect(address.length).toBeGreaterThanOrEqual(32);
    expect(address.length).toBeLessThanOrEqual(44);
    // Base58 excludes 0, O, I and l precisely so an address cannot be misread.
    expect(address).not.toMatch(/[0OIl]/);
  });

  it("round-trips the address back to the public key", async () => {
    const seed = await seedFrom(MNEMONICS[0]);
    const { address, publicKey } = deriveSolanaKeypair(seed);
    expect(base58.decode(address)).toEqual(publicKey);
  });

  it("gives different accounts for different phrases", async () => {
    const [a, b] = await Promise.all(MNEMONICS.slice(0, 2).map(seedFrom));
    expect(deriveSolanaKeypair(a).address).not.toBe(
      deriveSolanaKeypair(b).address,
    );
  });

  it("is deterministic", async () => {
    const seed = await seedFrom(MNEMONICS[0]);
    expect(deriveSolanaKeypair(seed).address).toBe(
      deriveSolanaKeypair(seed).address,
    );
  });

  it("exports the 64-byte form the Solana CLI expects", async () => {
    // The exit route: this is what a user pastes into another tool.
    const seed = await seedFrom(MNEMONICS[0]);
    const keypair = deriveSolanaKeypair(seed);
    const bytes = toSolanaSecretKeyBytes(keypair);
    expect(bytes).toHaveLength(64);
    expect(bytes.slice(0, 32)).toEqual(keypair.secretKey);
    expect(bytes.slice(32)).toEqual(keypair.publicKey);
  });

  it("signs verifiably with the derived key", async () => {
    // Proof the keypair is usable, not merely well-shaped.
    const seed = await seedFrom(MNEMONICS[0]);
    const { secretKey, publicKey } = deriveSolanaKeypair(seed);
    const message = new TextEncoder().encode("naculus");
    const signature = ed25519.sign(message, secretKey);
    expect(ed25519.verify(signature, message, publicKey)).toBe(true);
  });

  it("refuses a non-hardened path", async () => {
    const seed = await seedFrom(MNEMONICS[0]);
    expect(() => deriveSolanaKeypair(seed, "m/44'/501'/0'/0")).toThrow(
      /hardened/i,
    );
  });

  it("honours an explicit account index", async () => {
    // Multi-account wallets walk the third segment.
    const seed = await seedFrom(MNEMONICS[0]);
    const first = deriveSolanaKeypair(seed, "m/44'/501'/0'/0'");
    const second = deriveSolanaKeypair(seed, "m/44'/501'/1'/0'");
    expect(first.address).not.toBe(second.address);
  });
});

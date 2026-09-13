import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import {
  detectPrivateKey,
  toEvmPrivateKeyHex,
  toSolanaKeypairJson,
  toSolanaPrivateKeyBase58,
} from "./key-formats";
import { deriveSolanaKeypair } from "./solana";

/**
 * Cross-wallet interoperability, in both directions.
 *
 * No specification says how a private key is written down — the derivation
 * standards decide which key belongs to which account, and the text encoding
 * is convention. Convention is enough, but only if followed exactly, so both
 * directions are asserted here rather than assumed:
 *
 * - what this wallet exports must parse the way MetaMask and Phantom parse it
 * - what those export must import here and produce the same address
 *
 * The expected addresses are computed from the key material directly, not
 * recorded from these functions.
 */

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** How MetaMask turns a private key into an address. */
function evmAddressFrom(secret: Uint8Array): string {
  const pub = secp256k1.getPublicKey(secret, false);
  return `0x${bytesToHex(keccak_256(pub.slice(1)).slice(-20))}`;
}

/** How Phantom turns a keypair into an address. */
function solanaAddressFrom(seed: Uint8Array): string {
  return base58.encode(ed25519.getPublicKey(seed));
}

const EVM_SECRET = hexToBytes(
  "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
);
const SOL_SEED = hexToBytes("11".repeat(32));

describe("what we export, other wallets can read", () => {
  it("emits an EVM key in the form MetaMask accepts", () => {
    const exported = toEvmPrivateKeyHex(EVM_SECRET);
    expect(exported).toMatch(/^0x[0-9a-f]{64}$/);
    // Parsed the way MetaMask parses it, it controls the same address.
    expect(evmAddressFrom(hexToBytes(exported.slice(2)))).toBe(
      evmAddressFrom(EVM_SECRET),
    );
  });

  it("emits a Solana key in the base58 form Phantom accepts", () => {
    const exported = toSolanaPrivateKeyBase58(SOL_SEED);
    const decoded = base58.decode(exported);
    expect(decoded).toHaveLength(64);
    // Phantom checks this pairing; so does anything else that reads the form.
    expect(bytesToHex(ed25519.getPublicKey(decoded.slice(0, 32)))).toBe(
      bytesToHex(decoded.slice(32)),
    );
    expect(solanaAddressFrom(decoded.slice(0, 32))).toBe(
      solanaAddressFrom(SOL_SEED),
    );
  });

  it("emits the JSON array solana-keygen writes", () => {
    const parsed = JSON.parse(toSolanaKeypairJson(SOL_SEED));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(64);
    expect(parsed.every((n: number) => n >= 0 && n <= 255)).toBe(true);
    expect(Uint8Array.from(parsed).slice(0, 32)).toEqual(SOL_SEED);
  });

  it("refuses to export a value that is not a valid EVM key", () => {
    // Above the curve order. Emitting it would produce a key no wallet can use.
    expect(() => toEvmPrivateKeyHex(hexToBytes("ff".repeat(32)))).toThrow(
      /secp256k1 order/,
    );
  });
});

describe("what other wallets export, we can read", () => {
  it("reads a MetaMask key and knows it is EVM", () => {
    const detected = detectPrivateKey(`0x${bytesToHex(EVM_SECRET)}`);
    expect(detected.namespace).toBe("eip155");
    expect(evmAddressFrom(detected.secret)).toBe(evmAddressFrom(EVM_SECRET));
  });

  it("reads a Phantom key and knows it is Solana", () => {
    const detected = detectPrivateKey(toSolanaPrivateKeyBase58(SOL_SEED));
    expect(detected.namespace).toBe("solana");
    expect(solanaAddressFrom(detected.secret)).toBe(
      solanaAddressFrom(SOL_SEED),
    );
  });

  it("reads a solana-keygen keypair file", () => {
    const detected = detectPrivateKey(toSolanaKeypairJson(SOL_SEED));
    expect(detected.namespace).toBe("solana");
    expect(detected.secret).toEqual(SOL_SEED);
  });

  it("round-trips every namespace", async () => {
    // The whole guarantee in one place: derive, export, re-import, same account.
    const bip39 = await import("@scure/bip39");
    const seed = await bip39.mnemonicToSeed(MNEMONIC);
    const solana = deriveSolanaKeypair(seed);

    const backSolana = detectPrivateKey(
      toSolanaPrivateKeyBase58(solana.secretKey),
    );
    expect(backSolana.namespace).toBe("solana");
    expect(solanaAddressFrom(backSolana.secret)).toBe(solana.address);

    const backEvm = detectPrivateKey(toEvmPrivateKeyHex(EVM_SECRET));
    expect(evmAddressFrom(backEvm.secret)).toBe(evmAddressFrom(EVM_SECRET));
  });
});

describe("what we refuse, and why", () => {
  it("refuses a bare 32-byte hex rather than guessing a chain", () => {
    expect(() => detectPrivateKey(bytesToHex(EVM_SECRET))).toThrow(
      /does not say which chain/,
    );
  });

  it("refuses a Solana address pasted as a key", () => {
    // The case the refusal exists for: an address is 32 base58 bytes, exactly
    // the shape of a bare key. Accepting it would create an account the user
    // cannot control, with nothing to explain why it is empty.
    const address = solanaAddressFrom(SOL_SEED);
    expect(() => detectPrivateKey(address)).toThrow(/does not say which chain/);
  });

  it("refuses a 64-byte value whose halves do not match", () => {
    // Not a keypair, whatever it looks like. Importing it would produce an
    // address the key cannot sign for.
    const mismatched = new Uint8Array(64);
    mismatched.set(SOL_SEED);
    mismatched.set(ed25519.getPublicKey(hexToBytes("22".repeat(32))), 32);
    expect(() => detectPrivateKey(base58.encode(mismatched))).toThrow(
      /does not match its secret half/,
    );
  });

  it("refuses an EVM-shaped key above the curve order", () => {
    expect(() => detectPrivateKey(`0x${"ff".repeat(32)}`)).toThrow(
      /secp256k1 order/,
    );
  });

  it("refuses a JSON array of the wrong length", () => {
    expect(() =>
      detectPrivateKey(JSON.stringify(new Array(32).fill(1))),
    ).toThrow(/64 byte values/);
  });

  it.each(["", "   ", "hello", "0x1234", "{}"])("refuses %o", (input) => {
    expect(() => detectPrivateKey(input)).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { PocketWallet } from "./wallet";

/**
 * The exit guarantee.
 *
 * If this project disappears tomorrow, a user's funds must still be reachable
 * from any other wallet. That holds only while the mnemonic is standard
 * BIP-39, the derivation is the BIP-44 path other wallets default to, and the
 * phrase can actually be retrieved from storage.
 *
 * These vectors are the published BIP-39 test mnemonics with the addresses
 * that MetaMask, Rabby, Trust and Ledger Live derive from them at
 * m/44'/60'/0'/0/0. They are not recorded from this implementation — if a
 * refactor changes the derivation, these fail, and that is the point.
 */

const VECTORS: ReadonlyArray<{ mnemonic: string; address: string }> = [
  {
    mnemonic:
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    address: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
  },
  {
    mnemonic:
      "legal winner thank year wave sausage worth useful legal winner thank yellow",
    address: "0x58A57ed9d8d624cBD12e2C467D34787555bB1b25",
  },
];

/**
 * Derive the address independently of PocketWallet.
 *
 * Uses @scure/bip39 + @scure/bip32 + @noble/curves directly, so agreement is a
 * genuine cross-check rather than the implementation confirming itself. The
 * two hardcoded vectors above are the published ones; this covers everything
 * else without anyone having to trust a remembered address.
 */
async function deriveIndependently(mnemonic: string): Promise<string> {
  const bip39 = await import("@scure/bip39");
  const { wordlist } = await import("@scure/bip39/wordlists/english.js");
  const { HDKey } = await import("@scure/bip32");
  const { secp256k1 } = await import("@noble/curves/secp256k1.js");
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const { bytesToHex } = await import("@noble/hashes/utils.js");

  if (!bip39.validateMnemonic(mnemonic, wordlist)) {
    throw new Error("not a valid BIP-39 mnemonic");
  }
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const node = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0");
  if (!node.privateKey) throw new Error("no private key at that path");
  const pub = secp256k1.getPublicKey(node.privateKey, false);
  return `0x${bytesToHex(keccak_256(pub.slice(1)).slice(-20))}`;
}

const wallet = () => new PocketWallet({ autoSave: false });

describe("BIP-39 / BIP-44 interoperability", () => {
  it.each(VECTORS)(
    "derives the address other wallets derive from $address",
    async ({ mnemonic, address }) => {
      const data = await wallet().importMnemonic(mnemonic);
      expect(data.address?.toLowerCase()).toBe(address.toLowerCase());
    },
  );

  it("uses the derivation path other wallets default to", async () => {
    // Stated explicitly: the exit guarantee depends on this exact string, so
    // a change to it should have to change this test too.
    const explicit = new PocketWallet({
      autoSave: false,
      derivationPath: "m/44'/60'/0'/0/0",
    });
    const data = await explicit.importMnemonic(VECTORS[0].mnemonic);
    expect(data.address?.toLowerCase()).toBe(VECTORS[0].address.toLowerCase());
  });

  it("generates a 12-word phrase from the standard English wordlist", async () => {
    const data = await wallet().generate();
    const words = data.mnemonic.trim().split(/\s+/);
    expect(words).toHaveLength(12);
    // Round-trip through import: only a valid BIP-39 phrase survives.
    const reimported = await wallet().importMnemonic(data.mnemonic);
    expect(reimported.address).toBe(data.address);
  });

  it.each([
    "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
    "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
  ])(
    "agrees with an independent derivation of the same path",
    async (mnemonic) => {
      const expected = await deriveIndependently(mnemonic);
      const data = await wallet().importMnemonic(mnemonic);
      expect(data.address?.toLowerCase()).toBe(expected.toLowerCase());
    },
  );

  it("agrees independently on a freshly generated phrase too", async () => {
    const created = await wallet().generate();
    const expected = await deriveIndependently(created.mnemonic);
    expect(created.address?.toLowerCase()).toBe(expected.toLowerCase());
  });

  it("rejects a phrase that is not valid BIP-39", async () => {
    await expect(
      wallet().importMnemonic("not actually a real mnemonic phrase at all ok"),
    ).rejects.toThrow(/mnemonic/i);
  });

  it("keeps the phrase retrievable rather than showing it once and losing it", async () => {
    // A wallet whose recovery phrase cannot be read back is not self-custody,
    // whatever the derivation says.
    const w = wallet();
    const created = await w.generate();
    expect(w.getWalletData()?.mnemonic).toBe(created.mnemonic);
  });

  it("exposes the private key for a wallet imported without a phrase", async () => {
    // importPrivateKey leaves no mnemonic, so the key itself has to be the
    // exit route.
    const key = `0x${"11".repeat(32)}` as const;
    const w = wallet();
    const data = await w.importPrivateKey(key);
    expect(data.mnemonic).toBe("");
    expect(w.getWalletData()?.privateKey).toBe(key);
  });
});

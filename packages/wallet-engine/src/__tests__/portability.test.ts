import { HDKey } from "@scure/bip32";
import { base58 } from "@scure/base";
import { mnemonicToSeed } from "@scure/bip39";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { StorageAdapter } from "../storage/types";
import type { WalletData } from "../wallet";
import { PocketWallet } from "../wallet";

/**
 * Can a user leave?
 *
 * A self-custodial wallet that cannot hand back a key another wallet reads is
 * custodial in every way that matters. These tests check both directions
 * against derivations computed here from the published standards, never
 * against this implementation's own output — a test that compares the code to
 * itself proves only that it is self-consistent.
 */

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

class MemoryStorage implements StorageAdapter {
  private d: WalletData | null = null;
  readonly type = "memory" as const;
  isAvailable() {
    return true;
  }
  async load() {
    return this.d;
  }
  async save(d: WalletData) {
    this.d = d;
  }
  async clear() {
    this.d = null;
  }
}

function wallet() {
  return new PocketWallet({ storage: new MemoryStorage() });
}

/** BIP-32 / BIP-44 over secp256k1, independent of anything in this package. */
async function independentEvmKey(mnemonic: string): Promise<string> {
  const seed = await mnemonicToSeed(mnemonic);
  const node = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0");
  return `0x${bytesToHex(node.privateKey!)}`;
}

/** keccak-256 of the uncompressed public key, last 20 bytes. */
function independentEvmAddress(privateKeyHex: string): string {
  // 2.x takes bytes only; 1.x also accepted a hex string. Decoding here keeps
  // this an independent derivation rather than one that borrows the SDK's own
  // hex handling.
  const pk = hexToBytes(privateKeyHex.replace(/^0x/, ""));
  const pub = secp256k1.getPublicKey(pk, false).slice(1);
  return `0x${bytesToHex(keccak_256(pub).slice(-20))}`;
}

let w: PocketWallet;
beforeEach(() => {
  w = wallet();
});

describe("out: what this wallet hands a user", () => {
  it("exports an EVM key MetaMask's derivation agrees with", async () => {
    await w.importMnemonic(MNEMONIC);
    const exported = w.exportPrivateKey("eip155");
    expect(exported).toBe(await independentEvmKey(MNEMONIC));
    expect(exported).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("exports the address that key actually controls", async () => {
    await w.importMnemonic(MNEMONIC);
    const account = w.account("eip155")!;
    expect(account.address.toLowerCase()).toBe(
      independentEvmAddress(w.exportPrivateKey("eip155")).toLowerCase(),
    );
  });

  // Phantom takes base58 of secret‖public, 64 bytes. The stored form is hex,
  // which Phantom rejects — an export a user has to convert by hand is the
  // same as no export.
  it("exports a Solana key in the 64-byte base58 form Phantom takes", async () => {
    await w.importMnemonic(MNEMONIC);
    const exported = w.exportPrivateKey("solana");
    const bytes = base58.decode(exported);
    expect(bytes).toHaveLength(64);

    const seed = bytes.slice(0, 32);
    const publicKey = bytes.slice(32);
    // The trailing half must be the public key the leading half produces,
    // or the value is a 64-byte string no wallet can use.
    expect(Array.from(publicKey)).toEqual(
      Array.from(ed25519.getPublicKey(seed)),
    );
    expect(base58.encode(publicKey)).toBe(w.account("solana")!.address);
  });

  it("exports the JSON byte array solana-keygen writes", async () => {
    await w.importMnemonic(MNEMONIC);
    const json = JSON.parse(w.exportSolanaKeypairJson());
    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(64);
    expect(base58.encode(new Uint8Array(json.slice(32)))).toBe(
      w.account("solana")!.address,
    );
  });

  // A phrase produces both accounts, so the case that has only one is a raw
  // key import: a key is on exactly one curve.
  it("refuses to export a namespace this wallet has no key for", async () => {
    await w.importPrivateKey(await independentEvmKey(MNEMONIC));
    expect(w.account("solana")).toBeNull();
    expect(() => w.exportPrivateKey("solana")).toThrow(/holds no solana/);
    expect(() => w.exportSolanaKeypairJson()).toThrow(/holds no solana/);
  });
});

describe("in: what this wallet accepts from elsewhere", () => {
  it("takes a MetaMask key and lands on the same address", async () => {
    const key = await independentEvmKey(MNEMONIC);
    await w.importPrivateKey(key);
    expect(w.account("eip155")!.address.toLowerCase()).toBe(
      independentEvmAddress(key).toLowerCase(),
    );
  });

  it("takes a Phantom base58 key", async () => {
    const source = wallet();
    await source.importMnemonic(MNEMONIC);
    const phantomKey = source.exportPrivateKey("solana");

    await w.importPrivateKey(phantomKey);
    expect(w.account("solana")!.address).toBe(
      source.account("solana")!.address,
    );
    // A key is on exactly one curve, so no EVM account is invented for it.
    expect(w.account("eip155")).toBeNull();
  });

  it("takes a solana-keygen keypair file", async () => {
    const source = wallet();
    await source.importMnemonic(MNEMONIC);

    await w.importPrivateKey(source.exportSolanaKeypairJson());
    expect(w.account("solana")!.address).toBe(
      source.account("solana")!.address,
    );
  });

  it("recovers every account from the phrase alone", async () => {
    const source = wallet();
    const created = await source.generate();

    const restored = wallet();
    await restored.importMnemonic(created.mnemonic);

    expect(restored.account("eip155")!.address).toBe(
      source.account("eip155")!.address,
    );
    expect(restored.account("solana")!.address).toBe(
      source.account("solana")!.address,
    );
  });
});

describe("round trip", () => {
  it("survives export, import and export again unchanged", async () => {
    await w.importMnemonic(MNEMONIC);

    for (const namespace of ["eip155", "solana"] as const) {
      const first = w.exportPrivateKey(namespace);
      const second = wallet();
      await second.importPrivateKey(first);
      expect(second.exportPrivateKey(namespace)).toBe(first);
    }
  });

  // The phrase is the backup that carries everything; a raw key carries one
  // account. Both have to work, and they are not interchangeable.
  it("keeps the phrase readable after the wallet is stored and reloaded", async () => {
    const storage = new MemoryStorage();
    const first = new PocketWallet({ storage });
    await first.importMnemonic(MNEMONIC);

    const reopened = new PocketWallet({ storage });
    await reopened.load();
    expect(reopened.getWalletData()!.mnemonic).toBe(MNEMONIC);
  });
});

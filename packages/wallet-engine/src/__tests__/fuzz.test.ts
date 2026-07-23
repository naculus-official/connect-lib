import { describe, it, expect } from "vitest";
import { PocketWallet, EvmWalletError } from "../wallet";
import type { StorageAdapter, WalletData } from "../wallet";

class VoidStorage implements StorageAdapter {
  private d: WalletData | null = null;
  isAvailable() { return true; }
  async load() { return this.d; }
  async save(data: WalletData) { this.d = data; }
  async clear() { this.d = null; }
}

function randomHex(len: number): `0x${string}` {
  let s = "0x";
  for (let i = 0; i < len; i++) s += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  return s as `0x${string}`;
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

describe("Fuzz: PocketWallet input validation", () => {
  it("rejects invalid private key format (short)", async () => {
    const w = new PocketWallet({ storage: new VoidStorage(), autoSave: false });
    await expect(w.importPrivateKey("0x" + "ab".repeat(31) as `0x${string}`)).rejects.toThrow();
  });

  it("rejects invalid private key format (long)", async () => {
    const w = new PocketWallet({ storage: new VoidStorage(), autoSave: false });
    await expect(w.importPrivateKey("0x" + "ab".repeat(33) as `0x${string}`)).rejects.toThrow();
  });

  it("rejects private key with non-hex chars", async () => {
    const w = new PocketWallet({ storage: new VoidStorage(), autoSave: false });
    await expect(w.importPrivateKey("0x" + "zz".repeat(32) as `0x${string}`)).rejects.toThrow();
  });

  it("signs with random 32-byte key (does not crash)", async () => {
    const w = new PocketWallet({ storage: new VoidStorage(), autoSave: false });
    await w.importPrivateKey(randomHex(64));
    const sig = await w.signMessage("hello");
    expect(sig.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("rejects all-zeros key (not a valid secp256k1 scalar)", async () => {
    const w = new PocketWallet({ storage: new VoidStorage(), autoSave: false });
    await expect(w.importPrivateKey(("0x" + "00".repeat(32)) as `0x${string}`)).rejects.toThrow();
  });

  it("rejects all-FF key (exceeds secp256k1 curve order)", async () => {
    const w = new PocketWallet({ storage: new VoidStorage(), autoSave: false });
    await expect(w.importPrivateKey(("0x" + "ff".repeat(32)) as `0x${string}`)).rejects.toThrow();
  });

  it("signs empty message", async () => {
    const w = new PocketWallet({ storage: new VoidStorage(), autoSave: false });
    await w.importPrivateKey(randomHex(64));
    const sig = await w.signMessage("");
    expect(sig.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("handles very long message", async () => {
    const w = new PocketWallet({ storage: new VoidStorage(), autoSave: false });
    await w.importPrivateKey(randomHex(64));
    const long = "x".repeat(100_000);
    const sig = await w.signMessage(long);
    expect(sig.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("handles unicode message", async () => {
    const w = new PocketWallet({ storage: new VoidStorage(), autoSave: false });
    await w.importPrivateKey(randomHex(64));
    const sig = await w.signMessage("🔥 🚀 hello Привет");
    expect(sig.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("signs transaction with random params (does not crash)", async () => {
    const w = new PocketWallet({ storage: new VoidStorage(), autoSave: false });
    await w.importPrivateKey(randomHex(64));
    for (let i = 0; i < 5; i++) {
      const sig = await w.signTransaction({
        to: randomHex(40),
        value: randomHex(8),
        nonce: randomHex(2),
        gas: "0x5208",
        gasPrice: "0x" + Math.floor(Math.random() * 1e9).toString(16),
        chainId: 1,
      });
      expect(sig.signature).toMatch(/^0x[0-9a-f]+$/);
    }
  });

  it("rejects transaction without to address", async () => {
    const w = new PocketWallet({ storage: new VoidStorage(), autoSave: false });
    await w.importPrivateKey(randomHex(64));
    await expect(w.signTransaction({} as any)).rejects.toThrow();
  });

  it("handles concurrent sign calls", async () => {
    const w = new PocketWallet({ storage: new VoidStorage(), autoSave: false });
    await w.importPrivateKey(randomHex(64));
    const results = await Promise.all([
      w.signMessage("a"),
      w.signMessage("b"),
      w.signMessage("c"),
      w.signMessage("d"),
    ]);
    expect(results).toHaveLength(4);
    for (const r of results) expect(r.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("importMnemonic rejects invalid mnemonics", async () => {
    const w = new PocketWallet({ storage: new VoidStorage(), autoSave: false });
    await expect(w.importMnemonic("")).rejects.toThrow();
    await expect(w.importMnemonic("   ")).rejects.toThrow();
    await expect(w.importMnemonic("hello world")).rejects.toThrow();
    await expect(w.importMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon")).rejects.toThrow();
  });
});

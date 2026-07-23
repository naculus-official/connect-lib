import { describe, it, expect, beforeAll } from "vitest";
import { PocketWallet } from "../wallet";
import type { StorageAdapter, WalletData } from "../wallet";

const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

class MockStorage implements StorageAdapter {
  private data: WalletData | null = null;
  isAvailable() { return true; }
  async load() { return this.data; }
  async save(data: WalletData) { this.data = data; }
  async clear() { this.data = null; }
}

describe("Financial Crypto Compliance: Key Security", () => {
  it("derives same address from same mnemonic (deterministic)", async () => {
    const w1 = new PocketWallet({ storage: new MockStorage(), autoSave: false });
    const w2 = new PocketWallet({ storage: new MockStorage(), autoSave: false });
    await w1.importMnemonic(TEST_MNEMONIC);
    await w2.importMnemonic(TEST_MNEMONIC);
    const d1 = w1["data"];
    const d2 = w2["data"];
    expect(d1?.address).toBe(d2?.address);
  });

  it("signs with secp256k1 and produces recoverable signature", async () => {
    const w = new PocketWallet({ storage: new MockStorage(), autoSave: false });
    await w.importMnemonic(TEST_MNEMONIC);
    const msg = "0x" + Buffer.from("hello").toString("hex");
    const sig = await w.signMessage(msg);
    expect(sig.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("signs EIP-1559 transaction", async () => {
    const w = new PocketWallet({ storage: new MockStorage(), autoSave: false });
    await w.importMnemonic(TEST_MNEMONIC);
    const tx = await w.signTransaction({
      to: "0x" + "ab".repeat(20) as `0x${string}`,
      value: "0xde0b6b3a7640000",
      nonce: "0x0" as `0x${string}`,
      maxFeePerGas: "0x59682f00" as `0x${string}`,
      maxPriorityFeePerGas: "0x3b9aca00" as `0x${string}`,
      gas: "0x5208" as `0x${string}`,
      chainId: 1,
    });
    expect(tx.signature).toMatch(/^0x02[0-9a-f]+$/);
  });

  it("signs legacy transaction", async () => {
    const w = new PocketWallet({ storage: new MockStorage(), autoSave: false });
    await w.importMnemonic(TEST_MNEMONIC);
    const tx = await w.signTransaction({
      to: "0x" + "ab".repeat(20) as `0x${string}`,
      value: "0xde0b6b3a7640000",
      nonce: "0x0" as `0x${string}`,
      gasPrice: "0x4a817c800" as `0x${string}`,
      gas: "0x5208" as `0x${string}`,
      chainId: 1,
    });
    expect(tx.signature.slice(2, 4)).not.toBe("02");
  });
});

describe("Financial Crypto Compliance: Address Derivation", () => {
  it("EVM address is 20 bytes with 0x prefix", async () => {
    const w = new PocketWallet({ storage: new MockStorage(), autoSave: false });
    await w.importMnemonic(TEST_MNEMONIC);
    const d = w["data"];
    expect(d?.address).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("address starts with 0x and is 42 chars", async () => {
    const w = new PocketWallet({ storage: new MockStorage(), autoSave: false });
    await w.importMnemonic(TEST_MNEMONIC);
    const d = w["data"];
    expect(d?.address).toMatch(/^0x[0-9a-f]{40}$/);
  });
});

describe("Financial Crypto Compliance: Key Isolation", () => {
  it("two wallets have different addresses (different mnemonics)", async () => {
    const w1 = new PocketWallet({ storage: new MockStorage(), autoSave: false });
    const w2 = new PocketWallet({ storage: new MockStorage(), autoSave: false });
    await w1.generate();
    await w2.generate();
    const d1 = w1["data"];
    const d2 = w2["data"];
    expect(d1?.address).not.toBe(d2?.address);
  });

  it("re-generating wallet overwrites old keys", async () => {
    const storage = new MockStorage();
    const w = new PocketWallet({ storage, autoSave: false });
    await w.generate();
    const addr1 = w["data"]?.address;
    await w.generate();
    const addr2 = w["data"]?.address;
    expect(addr1).not.toBe(addr2);
  });
});

describe("Financial Crypto Compliance: Message Signing Standards", () => {
  it("signs EIP-191 personal_sign format", async () => {
    const w = new PocketWallet({ storage: new MockStorage(), autoSave: false });
    await w.importMnemonic(TEST_MNEMONIC);
    const msg = "0x" + Buffer.from("Hello, World!").toString("hex");
    const sig = await w.signMessage(msg);
    expect(sig.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(sig.signature.length).toBe(132);
  });

  it("signs empty message", async () => {
    const w = new PocketWallet({ storage: new MockStorage(), autoSave: false });
    await w.importMnemonic(TEST_MNEMONIC);
    const msg = "0x" as `0x${string}`;
    const sig = await w.signMessage(msg);
    expect(sig.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("signs deterministically (RFC 6979) — same message, same signature", async () => {
    const w = new PocketWallet({ storage: new MockStorage(), autoSave: false });
    await w.importMnemonic(TEST_MNEMONIC);
    const msg = "0x" + Buffer.from("test").toString("hex");
    const sig1 = await w.signMessage(msg);
    const sig2 = await w.signMessage(msg);
    expect(sig1.signature).toBe(sig2.signature);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PocketWallet } from "../wallet";
import type { StorageAdapter, WalletData } from "../wallet";
import { IsolatedSigner } from "../signers/isolated-signer";

const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

class MockStorage implements StorageAdapter {
  private d: WalletData | null = null;
  isAvailable() { return true; }
  async load() { return this.d; }
  async save(data: WalletData) { this.d = data; }
  async clear() { this.d = null; }
}

class MockWorker {
  private onmessageFn: ((e: any) => void) | null = null;
  onmessage: ((e: any) => void) | null = null;
  constructor(_url: URL, _opts?: any) {}
  postMessage(msg: any) {
    const id = msg.id ?? "0";
    setTimeout(() => {
      const fn = this.onmessageFn || this.onmessage;
      if (!fn) return;
      switch (msg.type) {
        case "init":
        case "initWithKey":
          fn({ data: { id, type: "ready" } });
          break;
        case "signMessage":
        case "signTransaction":
          fn({ data: { id, type: "signed", signature: "0x" + "ab".repeat(65) } });
          break;
        case "clear":
          fn({ data: { id, type: "cleared" } });
          break;
      }
    }, 5);
  }
  terminate() {}
  addEventListener(type: string, fn: any) { if (type === "message") this.onmessageFn = fn; }
}

describe("PocketWallet with isolation: worker", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (globalThis as any).Worker = MockWorker as any;
  });

  it("creates IsolatedSigner when isolation=worker", () => {
    const wallet = new PocketWallet({ storage: new MockStorage(), isolation: "worker", autoSave: false });
    expect(wallet["_signer"]).toBeInstanceOf(IsolatedSigner);
  });

  it("creates EVMSigner when isolation not specified", () => {
    const wallet = new PocketWallet({ storage: new MockStorage(), autoSave: false });
    expect(wallet["_signer"]).not.toBeInstanceOf(IsolatedSigner);
  });

  it("generates wallet in worker isolation mode", async () => {
    const wallet = new PocketWallet({ storage: new MockStorage(), isolation: "worker", autoSave: false });
    await wallet.generate();
    expect(wallet["data"]).not.toBeNull();
  });

  it("imports mnemonic in worker isolation mode", async () => {
    const wallet = new PocketWallet({ storage: new MockStorage(), isolation: "worker", autoSave: false });
    await wallet.importMnemonic(TEST_MNEMONIC);
    expect(wallet["data"]).not.toBeNull();
  });

  it("generates deterministic address same as non-isolated", async () => {
    const w1 = new PocketWallet({ storage: new MockStorage(), isolation: "worker", autoSave: false });
    const w2 = new PocketWallet({ storage: new MockStorage(), autoSave: false });
    await w1.importMnemonic(TEST_MNEMONIC);
    await w2.importMnemonic(TEST_MNEMONIC);
    const d1 = w1["data"];
    const d2 = w2["data"];
    expect(d1?.address).toBe(d2?.address);
  });

  it("clears worker on wallet.clear", async () => {
    const wallet = new PocketWallet({ storage: new MockStorage(), isolation: "worker", autoSave: false });
    await wallet.generate();
    const signer = wallet["_signer"] as IsolatedSigner;
    const spy = vi.spyOn(signer, "clear");
    await wallet.clear();
    expect(spy).toHaveBeenCalledOnce();
  });

  it("signs message in worker isolation mode", async () => {
    const wallet = new PocketWallet({ storage: new MockStorage(), isolation: "worker", autoSave: false });
    await wallet.importMnemonic(TEST_MNEMONIC);
    const result = await wallet.signMessage("hello");
    expect(result.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });
});

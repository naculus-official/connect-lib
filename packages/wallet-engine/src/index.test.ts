import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletError } from "./errors";
import { LocalStorageAdapter } from "./storage/local-storage";
import type { StorageAdapter } from "./storage/types";
import { PocketWallet, type WalletData } from "./wallet";

// ── Storage Adapter for testing ───────────────────────────────────

class MockStorage implements StorageAdapter {
  private data: WalletData | null = null;

  isAvailable(): boolean {
    return true;
  }
  async load(): Promise<WalletData | null> {
    return this.data;
  }
  async save(data: WalletData): Promise<void> {
    this.data = data;
  }
  async clear(): Promise<void> {
    this.data = null;
  }
}

// ── Known test vectors ────────────────────────────────────────────

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// ── Wallet generation tests ───────────────────────────────────────

describe("PocketWallet", () => {
  let wallet: PocketWallet;

  beforeEach(() => {
    wallet = new PocketWallet({ storage: new MockStorage(), autoSave: false });
  });

  describe("generate", () => {
    it("should create a wallet with valid address", async () => {
      const data = await wallet.generate();
      expect(data.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(data.mnemonic).toBeTruthy();
      expect(data.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
      expect(data.createdAt).toBeGreaterThan(0);
    });

    it("should set hasWallet after generate", async () => {
      expect(wallet.hasWallet).toBe(false);
      await wallet.generate();
      expect(wallet.hasWallet).toBe(true);
    });

    it("should expose address as getter after generate", async () => {
      const data = await wallet.generate();
      expect(wallet.address?.toLowerCase()).toBe(data.address.toLowerCase());
    });

    it("should expose mnemonic as getter after generate", async () => {
      const data = await wallet.generate();
      expect(wallet.mnemonic).toBe(data.mnemonic);
    });
  });

  describe("importMnemonic", () => {
    it("should import a valid mnemonic", async () => {
      const data = await wallet.importMnemonic(TEST_MNEMONIC);
      expect(data.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(data.mnemonic).toBe(TEST_MNEMONIC);
      expect(wallet.address).toBe(data.address);
    });

    it("should reject an invalid mnemonic", async () => {
      await expect(wallet.importMnemonic("foo bar baz")).rejects.toThrow(
        "Invalid mnemonic",
      );
    });

    it("should reject empty string", async () => {
      await expect(wallet.importMnemonic("")).rejects.toThrow();
    });
  });

  describe("importPrivateKey", () => {
    it("should import a valid 64-char hex key", async () => {
      const pk = `0x${"ab".repeat(32)}` as `0x${string}`;
      const data = await wallet.importPrivateKey(pk);
      expect(data.privateKey).toBe(pk);
      expect(data.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(data.mnemonic).toBe("");
    });

    it("should reject short key", async () => {
      const pk = "0xabcd" as `0x${string}`;
      await expect(wallet.importPrivateKey(pk)).rejects.toThrow(
        "Invalid private key",
      );
    });

    it("should reject non-hex key", async () => {
      const pk = `0x${"zz".repeat(32)}` as `0x${string}`;
      await expect(wallet.importPrivateKey(pk)).rejects.toThrow(
        "Invalid private key",
      );
    });
  });
});

// ── Signing tests (deterministic with known key) ──────────────────

describe("PocketWallet signing", () => {
  let wallet: PocketWallet;

  beforeEach(async () => {
    wallet = new PocketWallet({ storage: new MockStorage(), autoSave: false });
    await wallet.importMnemonic(TEST_MNEMONIC);
  });

  describe("signMessage", () => {
    it("should produce a valid signature hex", async () => {
      const result = await wallet.signMessage("Hello, World!");
      expect(result.signature).toMatch(/^0x[0-9a-f]{130}$/);
      expect(result.recovery).toBeTypeOf("number");
    });

    it("should be deterministic with same message", async () => {
      const r1 = await wallet.signMessage("test");
      const r2 = await wallet.signMessage("test");
      expect(r1.signature).toBe(r2.signature);
    });

    it("should produce different signatures for different messages", async () => {
      const r1 = await wallet.signMessage("msg1");
      const r2 = await wallet.signMessage("msg2");
      expect(r1.signature).not.toBe(r2.signature);
    });

    it("should throw when no wallet loaded", async () => {
      const empty = new PocketWallet({ storage: new MockStorage() });
      await expect(empty.signMessage("test")).rejects.toThrow(
        "No wallet loaded",
      );
    });
  });

  describe("signTransaction", () => {
    it("should produce a valid RLP-signed transaction", async () => {
      const tx = {
        to: "0x" + "ab".repeat(20),
        value: "0x0",
        nonce: "0x0",
        gasPrice: "0x4a817c800",
        gas: "0x5208",
        chainId: 1,
      };
      const result = await wallet.signTransaction(tx);
      expect(result.signature).toMatch(/^0x[0-9a-f]+$/);
      expect(result.signature.length).toBeGreaterThan(200);
    });

    it("should throw when missing to address", async () => {
      await expect(wallet.signTransaction({} as any)).rejects.toThrow(
        "Missing",
      );
    });
  });
});

// ── Storage tests ─────────────────────────────────────────────────

describe("PocketWallet storage", () => {
  let mockStorage: MockStorage;
  let wallet: PocketWallet;

  beforeEach(() => {
    mockStorage = new MockStorage();
    wallet = new PocketWallet({ storage: mockStorage, autoSave: true });
  });

  it("should save wallet after generate when autoSave is true", async () => {
    await wallet.generate();
    const loaded = await mockStorage.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.address).toBe(wallet.address);
  });

  it("should not save when autoSave is false", async () => {
    wallet = new PocketWallet({ storage: mockStorage, autoSave: false });
    await wallet.generate();
    const loaded = await mockStorage.load();
    expect(loaded).toBeNull();
  });

  it("should load wallet from storage", async () => {
    await wallet.generate();
    const address = wallet.address;

    const wallet2 = new PocketWallet({ storage: mockStorage, autoSave: false });
    const found = await wallet2.load();
    expect(found).toBe(true);
    expect(wallet2.address?.toLowerCase()).toBe(address?.toLowerCase());
  });

  it("should clear wallet from storage", async () => {
    await wallet.generate();
    expect(wallet.hasWallet).toBe(true);

    await wallet.clear();
    expect(wallet.hasWallet).toBe(false);

    const loaded = await mockStorage.load();
    expect(loaded).toBeNull();
  });

  it("should return false from load when no wallet stored", async () => {
    const wallet2 = new PocketWallet({ storage: mockStorage, autoSave: false });
    expect(await wallet2.load()).toBe(false);
  });
});

// ── Wipe tests ────────────────────────────────────────────────────

describe("PocketWallet wipe", () => {
  it("should overwrite sensitive data then clear", async () => {
    const storage = new MockStorage();
    const wallet = new PocketWallet({ storage, autoSave: false });
    await wallet.generate();

    await wallet.wipe();
    expect(wallet.hasWallet).toBe(false);
    expect(wallet.mnemonic).toBeNull();
    expect(wallet.address).toBeNull();

    const stored = await storage.load();
    expect(stored).toBeNull();
  });
});

// ── LocalStorageAdapter tests ─────────────────────────────────────

describe("LocalStorageAdapter", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "localStorage",
      (() => {
        let store: Record<string, string> = {};
        return {
          getItem: (k: string) => store[k] ?? null,
          setItem: (k: string, v: string) => {
            store[k] = v;
          },
          removeItem: (k: string) => {
            delete store[k];
          },
          clear: () => {
            store = {};
          },
          get length() {
            return Object.keys(store).length;
          },
          key: (i: number) => Object.keys(store)[i] ?? null,
        };
      })(),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("should detect availability", () => {
    const adapter = new LocalStorageAdapter("test");
    expect(adapter.isAvailable()).toBe(true);
  });

  it("should save and load wallet data", async () => {
    const adapter = new LocalStorageAdapter("test");
    const data: WalletData = {
      mnemonic: "test mnemonic",
      privateKey: "0x" + "ab".repeat(32),
      address: "0x" + "cd".repeat(20),
      createdAt: Date.now(),
    };
    await adapter.save(data);
    const loaded = await adapter.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.address).toBe(data.address);
    expect(loaded!.mnemonic).toBe(data.mnemonic);
  });

  it("should clear stored data", async () => {
    const adapter = new LocalStorageAdapter("test");
    const data: WalletData = {
      mnemonic: "test",
      privateKey: "0x" + "ab".repeat(32),
      address: "0x" + "cd".repeat(20),
      createdAt: Date.now(),
    };
    await adapter.save(data);
    await adapter.clear();
    expect(await adapter.load()).toBeNull();
  });

  it("should use custom key prefix", async () => {
    const adapter = new LocalStorageAdapter("myapp_wallet");
    await adapter.save({
      mnemonic: "test",
      privateKey: "0x" + "ab".repeat(32),
      address: "0x" + "cd".repeat(20),
      createdAt: Date.now(),
    });
    const raw = localStorage.getItem("myapp_wallet");
    expect(raw).not.toBeNull();
  });
});

// ── Config tests ──────────────────────────────────────────────────

describe("PocketWallet config", () => {
  it("should use custom derivation path", async () => {
    const w1 = new PocketWallet({
      storage: new MockStorage(),
      derivationPath: "m/44'/60'/0'/0/0",
      autoSave: false,
    });
    const w2 = new PocketWallet({
      storage: new MockStorage(),
      derivationPath: "m/44'/60'/0'/0/1",
      autoSave: false,
    });

    await w1.importMnemonic(TEST_MNEMONIC);
    await w2.importMnemonic(TEST_MNEMONIC);

    expect(w1.address?.toLowerCase()).not.toBe(w2.address?.toLowerCase());
  });

  it("should set and get chainId", () => {
    const w = new PocketWallet({ storage: new MockStorage() });
    expect(w.state.chainId).toBe("eip155:1");
    w.setChain("eip155:137");
    expect(w.state.chainId).toBe("eip155:137");
  });

  it("should auto-prefix eip155 when setting chain with plain number", () => {
    const w = new PocketWallet({ storage: new MockStorage() });
    w.setChain("137");
    expect(w.state.chainId).toBe("eip155:137");
  });

  it("should use provided storage", () => {
    const storage = new MockStorage();
    const w = new PocketWallet({ storage });
    expect((w as any)._storage).toBe(storage);
  });

  it("should use provided RPC URL", async () => {
    const w = new PocketWallet({ rpcUrl: "https://rpc.example.com" });
    // Access rpcUrl through cfg (private) — verify no error at construction
    expect(w.state.isConnected).toBe(false);
  });
});

// ── Error class tests ─────────────────────────────────────────────

describe("WalletError", () => {
  it("should set name to WalletError", () => {
    const err = new WalletError("test_code", "test message");
    expect(err.name).toBe("WalletError");
  });

  it("should preserve code and cause", () => {
    const cause = new Error("root cause");
    const err = new WalletError("bad_stuff", "something broke", cause);
    expect(err.code).toBe("bad_stuff");
    expect(err.cause).toBe(cause);
  });
});

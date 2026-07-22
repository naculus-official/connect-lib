import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPocketConnector, type PocketConnector } from "./index";

// LocalStorage mock
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
});

// Mock crypto dependencies
vi.mock("@scure/bip39", () => ({
  generateMnemonic: vi.fn(
    () =>
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  ),
  mnemonicToSeed: vi.fn(async () => new Uint8Array(64).fill(0x42)),
  validateMnemonic: vi.fn(
    (mnemonic: string) =>
      mnemonic.length > 0 && mnemonic.split(" ").length >= 12,
  ),
}));

vi.mock("@noble/curves/secp256k1", () => ({
  secp256k1: {
    getPublicKey: vi.fn(() => {
      const pub = new Uint8Array(65);
      pub[0] = 0x04;
      for (let i = 1; i < 65; i++) pub[i] = 0xaa;
      return pub;
    }),
    sign: vi.fn(() => ({
      recovery: 0,
      toBytes: () => {
        const sig = new Uint8Array(64);
        for (let i = 0; i < 32; i++) sig[i] = 0xbb;
        for (let i = 32; i < 64; i++) sig[i] = 0xcc;
        return sig;
      },
    })),
  },
}));

vi.mock("@scure/bip32", () => ({
  HDKey: {
    fromMasterSeed: vi.fn(() => ({
      derive: () => ({ privateKey: new Uint8Array(32).fill(0x11) }),
    })),
  },
}));

describe("PocketConnector", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  describe("factory", () => {
    it("should create connector with default config", () => {
      const connector = createPocketConnector();
      expect(connector.id).toBe("pocket");
      expect(connector.name).toBe("Pocket Wallet");
      expect(connector.kind).toBe("embedded");
    });

    it("should create connector with custom storage key", () => {
      createPocketConnector({ storageKey: "custom_key" });
    });

    it("should have correct capabilities", () => {
      const connector = createPocketConnector();
      expect(connector.supports.desktop).toBe(true);
      expect(connector.supports.mobile).toBe(true);
      expect(connector.supports.qr).toBe(false);
      expect(connector.supports.trustedReconnect).toBe(true);
    });
  });

  describe("generateWallet", () => {
    it("should generate mnemonic and address", async () => {
      const connector = createPocketConnector({ autoSave: false });
      const result = await connector.generateWallet();
      expect(result.mnemonic).toBeTruthy();
      expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(result.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
    });

    it("should have wallet after generation", async () => {
      const connector = createPocketConnector({ autoSave: false });
      expect(connector.hasWallet()).toBe(false);
      await connector.generateWallet();
      expect(connector.hasWallet()).toBe(true);
    });

    it("should auto-save to localStorage when enabled", async () => {
      const connector = createPocketConnector({
        autoSave: true,
        storageKey: "test_auto_save",
      });
      await connector.generateWallet();
      expect(localStorageMock.setItem).toHaveBeenCalled();
    });
  });

  describe("save and load", () => {
    it("load should return false when no wallet saved", async () => {
      const connector = createPocketConnector({
        storageKey: "test_load_empty",
      });
      expect(await connector.load()).toBe(false);
    });

    it("should load previously saved wallet", async () => {
      const connector1 = createPocketConnector({
        autoSave: true,
        storageKey: "test_load",
      });
      await connector1.generateWallet();
      const savedAddr = connector1.getAddress();
      expect(savedAddr).not.toBeNull();

      // Create new connector with same key — should load from localStorage
      const connector2 = createPocketConnector({ storageKey: "test_load" });
      expect(await connector2.load()).toBe(true);
      expect(connector2.getAddress()).toBe(savedAddr);
      expect(connector2.hasWallet()).toBe(true);
    });
  });

  describe("connect / disconnect", () => {
    it("should generate wallet on connect if none exists", async () => {
      const connector = createPocketConnector({ autoSave: false });
      const session = await connector.connect();
      expect(session.walletType).toBe("embedded");
      expect(connector.hasWallet()).toBe(true);
    });

    it("should disconnect properly", async () => {
      const connector = createPocketConnector({ autoSave: false });
      await connector.connect();
      expect(connector.hasWallet()).toBe(true);
      await connector.disconnect();
      // disconnect nullifies the internal wallet reference
      expect(connector.getWallet()).toBeNull();
    });
  });

  describe("getAccounts", () => {
    it("should return empty array when no wallet", async () => {
      const connector = createPocketConnector();
      const session = await connector.connect();
      await connector.disconnect();
      // After disconnect, getAccounts should return empty
      const accounts = await connector.getAccounts(session);
      expect(accounts).toEqual([]);
    });

    it("should return account after generation", async () => {
      const connector = createPocketConnector({ autoSave: false });
      const session = await connector.connect();
      const accounts = await connector.getAccounts(session);
      expect(accounts.length).toBe(1);
      expect(accounts[0]).toContain("eip155:");
    });
  });

  describe("sendTransaction", () => {
    it("should throw when no to address", async () => {
      const connector = createPocketConnector();
      const session = await connector.connect();
      await expect(
        connector.sendTransaction(session, {} as any),
      ).rejects.toThrow("Missing");
    });

    it("should throw when no RPC URL configured", async () => {
      const connector = createPocketConnector();
      const session = await connector.connect();
      await expect(
        connector.sendTransaction(session, {
          to: "0x1234567890123456789012345678901234567890",
        }),
      ).rejects.toThrow("RPC URL not configured");
    });
  });

  describe("switchChain", () => {
    it("should switch to eip155 chain correctly", async () => {
      const connector = createPocketConnector();
      const session = await connector.connect();
      await connector.switchChain(session, "eip155:8453");
      expect(session.namespaces.eip155.chains).toEqual(["eip155:8453"]);
    });

    it("should prepend eip155: if needed", async () => {
      const connector = createPocketConnector();
      const session = await connector.connect();
      await connector.switchChain(session, "8453");
      expect(session.namespaces.eip155.chains).toEqual(["eip155:8453"]);
    });
  });

  describe("wipe", () => {
    it("should clear in-memory wallet data", async () => {
      const connector = createPocketConnector({ autoSave: false });
      await connector.generateWallet();
      expect(connector.hasWallet()).toBe(true);
      await connector.wipe();
      expect(connector.hasWallet()).toBe(false);
      expect(connector.getAddress()).toBeNull();
    });

    it("should remove localStorage item", async () => {
      const connector = createPocketConnector({
        autoSave: true,
        storageKey: "wipe_test",
      });
      await connector.generateWallet();
      expect(localStorageMock.getItem("wipe_test")).not.toBeNull();
      await connector.wipe();
      expect(localStorageMock.getItem("wipe_test")).toBeNull();
    });

    it("should be safe to call when no wallet exists", async () => {
      const connector = createPocketConnector();
      await expect(connector.wipe()).resolves.not.toThrow();
      expect(connector.hasWallet()).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("load() should handle corrupt base64 data", async () => {
      localStorageMock.setItem("corrupt_base64", "not-valid-base64!!!");
      const connector = createPocketConnector({ storageKey: "corrupt_base64" });
      expect(await connector.load()).toBe(false);
    });
  });

  describe("importFromMnemonic", () => {
    it("should import from valid mnemonic", async () => {
      const connector = createPocketConnector({ autoSave: false });
      const result = await connector.importFromMnemonic(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      );
      expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(result.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(connector.hasWallet()).toBe(true);
    });

    it("should throw on invalid mnemonic", async () => {
      const connector = createPocketConnector({ autoSave: false });
      await expect(connector.importFromMnemonic("invalid")).rejects.toThrow(
        "Invalid mnemonic",
      );
    });
  });

  describe("importFromPrivateKey", () => {
    it("should import from valid private key", async () => {
      const connector = createPocketConnector({ autoSave: false });
      const hex = "11".repeat(32);
      const pk = ("0x" + hex) as unknown as `0x${string}`;
      const result = await connector.importFromPrivateKey(pk);
      expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(result.privateKey).toBe(pk);
      expect(connector.hasWallet()).toBe(true);
    });

    it("should throw on invalid private key format", async () => {
      const connector = createPocketConnector({ autoSave: false });
      await expect(
        connector.importFromPrivateKey("0xinvalid" as unknown as `0x${string}`),
      ).rejects.toThrow("Invalid private key");
    });
  });

  describe("signMessage", () => {
    it("should return a signature", async () => {
      const connector = createPocketConnector({ autoSave: false });
      const session = await connector.connect();
      const sig = await connector.signMessage(session, {
        message: "hello world",
      });
      expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/);
    });
  });

  describe("signTransaction", () => {
    it("should return a valid signature via PocketWallet", async () => {
      const connector = createPocketConnector({ autoSave: false });
      const session = await connector.connect();
      const result = await connector.signTransaction(session, {
        to: "0x1234567890123456789012345678901234567890",
        value: "0x0",
      } as any);
      expect(result).toHaveProperty("signature");
      expect((result as any).signature).toMatch(/^0x[0-9a-fA-F]+$/);
    });
  });

  describe("getWallet / getAddress", () => {
    it("should return null before generation", () => {
      const connector = createPocketConnector();
      expect(connector.getWallet()).toBeNull();
      expect(connector.getAddress()).toBeNull();
    });

    it("should return data after generation", async () => {
      const connector = createPocketConnector({ autoSave: false });
      await connector.generateWallet();
      expect(connector.getWallet()).not.toBeNull();
      expect(connector.getWallet()!.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(connector.getAddress()).toBe(connector.getWallet()!.address);
    });
  });
});

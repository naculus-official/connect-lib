import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmptySession,
  isSessionExpired,
  LocalStorageSessionStorage,
  type UniversalWalletSession,
  updateSession,
} from "./session";

describe("createEmptySession", () => {
  it("should create a session with required fields", () => {
    const session = createEmptySession({
      id: "test-id",
      walletId: "wallet-1",
      walletType: "walletconnect",
      namespaces: {
        eip155: {
          chains: ["eip155:1"],
          accounts: ["eip155:1:0x742d35Cc6634C0532925a3b844Bc9e7595f0fE1"],
          methods: ["eth_requestAccounts"],
          events: ["accountsChanged"],
        },
      },
      platform: "desktop-web",
    });

    expect(session.id).toBe("test-id");
    expect(session.walletId).toBe("wallet-1");
    expect(session.walletType).toBe("walletconnect");
    expect(session.platform).toBe("desktop-web");
    expect(session.createdAt).toBeDefined();
    expect(session.updatedAt).toBeDefined();
  });

  it("should use provided timestamps", () => {
    const session = createEmptySession({
      id: "test-id",
      walletId: "wallet-1",
      walletType: "walletconnect",
      namespaces: {
        eip155: { chains: [], accounts: [], methods: [], events: [] },
      },
      platform: "desktop-web",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    });

    expect(session.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(session.updatedAt).toBe("2024-01-02T00:00:00.000Z");
  });
});

describe("updateSession", () => {
  it("should update session namespaces", () => {
    const session: UniversalWalletSession = {
      id: "test-id",
      walletId: "wallet-1",
      walletType: "walletconnect",
      namespaces: {
        eip155: {
          chains: ["eip155:1"],
          accounts: ["eip155:1:0x123"],
          methods: [],
          events: [],
        },
      },
      platform: "desktop-web",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };

    const updated = updateSession(session, {
      namespaces: {
        eip155: {
          chains: ["eip155:1", "eip155:137"],
          accounts: ["eip155:1:0x123", "eip155:137:0x456"],
          methods: ["eth_requestAccounts"],
          events: ["accountsChanged"],
        },
      },
    });

    expect(updated.namespaces.eip155.chains).toHaveLength(2);
    expect(updated.namespaces.eip155.accounts).toHaveLength(2);
    expect(updated.updatedAt).not.toBe(session.updatedAt);
  });
});

describe("isSessionExpired", () => {
  it("should return false when session has no expiry", () => {
    const session: UniversalWalletSession = {
      id: "test-id",
      walletId: "wallet-1",
      walletType: "walletconnect",
      namespaces: {
        eip155: { chains: [], accounts: [], methods: [], events: [] },
      },
      platform: "desktop-web",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(isSessionExpired(session, new Date())).toBe(false);
  });

  it("should return true when session is expired", () => {
    const session: UniversalWalletSession = {
      id: "test-id",
      walletId: "wallet-1",
      walletType: "walletconnect",
      namespaces: {
        eip155: { chains: [], accounts: [], methods: [], events: [] },
      },
      platform: "desktop-web",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      auth: {
        method: "siwe",
        expiresAt: "2020-01-01T00:00:00.000Z",
      },
    };

    expect(isSessionExpired(session, new Date())).toBe(true);
  });

  it("should return false when session is not expired", () => {
    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 1);

    const session: UniversalWalletSession = {
      id: "test-id",
      walletId: "wallet-1",
      walletType: "walletconnect",
      namespaces: {
        eip155: { chains: [], accounts: [], methods: [], events: [] },
      },
      platform: "desktop-web",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      auth: {
        method: "siwe",
        expiresAt: futureDate.toISOString(),
      },
    };

    expect(isSessionExpired(session, new Date())).toBe(false);
  });
});

// localStorage mock for node environment (core tests don't use jsdom)
function createMockStorage(): Storage {
  const store: Record<string, string> = {};
  const mock: Record<string, any> = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
  mock.__proto__ = { setItem: mock.setItem };
  return mock as Storage;
}

describe("LocalStorageSessionStorage", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = createMockStorage();
  });

  it("should save and load a session", async () => {
    const storage = new LocalStorageSessionStorage("test_save_load");
    const session: UniversalWalletSession = {
      id: "sess-1",
      walletId: "w-1",
      walletType: "walletconnect",
      namespaces: {
        eip155: {
          chains: ["eip155:1"],
          accounts: ["eip155:1:0xabc"],
          methods: ["eth_sendTransaction"],
          events: ["accountsChanged"],
        },
      },
      platform: "desktop-web",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };

    await storage.save(session);
    const loaded = await storage.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("sess-1");
    expect(loaded!.walletId).toBe("w-1");
    expect(loaded!.namespaces.eip155.accounts).toContain("eip155:1:0xabc");
  });

  it("should return null when no session saved", async () => {
    const storage = new LocalStorageSessionStorage("test_empty");
    const result = await storage.load();
    expect(result).toBeNull();
  });

  it("should clear a saved session", async () => {
    const storage = new LocalStorageSessionStorage("test_clear");
    const session: UniversalWalletSession = {
      id: "sess-clear",
      walletId: "w-clear",
      walletType: "eip6963",
      namespaces: {
        eip155: {
          chains: ["eip155:137"],
          accounts: ["eip155:137:0xdef"],
          methods: [],
          events: [],
        },
      },
      platform: "desktop-web",
      createdAt: "2025-06-01T00:00:00.000Z",
      updatedAt: "2025-06-01T00:00:00.000Z",
    };

    await storage.save(session);
    expect(await storage.load()).not.toBeNull();

    await storage.clear();
    expect(await storage.load()).toBeNull();
  });

  it("should isolate sessions with different keys", async () => {
    const storageA = new LocalStorageSessionStorage("key_a");
    const storageB = new LocalStorageSessionStorage("key_b");

    const sessionA: UniversalWalletSession = {
      id: "sess-a",
      walletId: "w-a",
      walletType: "walletconnect",
      namespaces: {
        eip155: { chains: [], accounts: [], methods: [], events: [] },
      },
      platform: "desktop-web",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };

    await storageA.save(sessionA);

    expect(await storageB.load()).toBeNull();
    expect(await storageA.load()).not.toBeNull();
  });

  it("should handle corrupt JSON gracefully and return null", async () => {
    (globalThis as any).localStorage.setItem(
      "test_corrupt:session",
      "this is not json",
    );
    const storage = new LocalStorageSessionStorage("test_corrupt");
    const result = await storage.load();
    expect(result).toBeNull();
  });

  it("isAvailable should work with in-memory localStorage", () => {
    const storage = new LocalStorageSessionStorage();
    expect(storage.isAvailable()).toBe(true);
  });

  it("save should not throw when localStorage is full", async () => {
    const storage = new LocalStorageSessionStorage("test_quota");
    const session: UniversalWalletSession = {
      id: "quota-test",
      walletId: "w",
      walletType: "walletconnect",
      namespaces: {
        eip155: { chains: [], accounts: [], methods: [], events: [] },
      },
      platform: "desktop-web",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };

    const orig = (globalThis as any).localStorage.__proto__.setItem;
    (globalThis as any).localStorage.__proto__.setItem = vi.fn(() => {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    });

    await expect(storage.save(session)).resolves.toBeUndefined();

    (globalThis as any).localStorage.__proto__.setItem = orig;
  });

  it("should persist across different instances with same key", async () => {
    const session: UniversalWalletSession = {
      id: "persist-test",
      walletId: "w-persist",
      walletType: "walletconnect",
      namespaces: {
        eip155: { chains: [], accounts: [], methods: [], events: [] },
      },
      platform: "desktop-web",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };

    const writer = new LocalStorageSessionStorage("persist_key");
    await writer.save(session);

    const reader = new LocalStorageSessionStorage("persist_key");
    const loaded = await reader.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("persist-test");
  });
});

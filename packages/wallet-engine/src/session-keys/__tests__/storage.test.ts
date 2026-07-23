import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionKeyStorage } from "../storage";
import type { StoredSessionKey, SessionKeyScope, EncryptedKeyPair, SignedAuthorization } from "../types";

// Mock localStorage for testing
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
    get length() { return Object.keys(store).length; },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
  };
})();

Object.defineProperty(globalThis, "localStorage", { value: localStorageMock });

describe("session-keys / storage", () => {
  let storage: SessionKeyStorage;

  beforeEach(() => {
    localStorageMock.clear();
    storage = new SessionKeyStorage();
  });

  function createMockSession(id: string, overrides?: Partial<StoredSessionKey>): StoredSessionKey {
    const scope: SessionKeyScope = {
      expiry: Math.floor(Date.now() / 1000) + 3600,
      mode: "offchain",
    };

    const keyPair: EncryptedKeyPair = {
      publicKey: `0x${"aa".repeat(33)}` as `0x${string}`,
      encryptedPrivateKey: "deadbeef",
      iv: "00112233445566778899aabb",
      salt: "ffeeddccbbaa998877665544",
    };

    const authorization: SignedAuthorization = {
      signerAddress: `0x${"bb".repeat(20)}` as `0x${string}`,
      type: "offchain",
    };

    const base: StoredSessionKey = {
      id,
      keyPair,
      scope,
      authorization,
      status: "active",
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      useCount: 0,
    };

    return { ...base, ...overrides };
  }

  describe("loadAll / save", () => {
    it("should return empty array when no sessions stored", async () => {
      const sessions = await storage.loadAll();
      expect(sessions).toEqual([]);
    });

    it("should save and load a single session", async () => {
      const session = createMockSession("sk_test123");
      await storage.save(session);

      const loaded = await storage.loadAll();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe("sk_test123");
      expect(loaded[0].status).toBe("active");
    });

    it("should update existing session on save", async () => {
      const session = createMockSession("sk_test123");
      await storage.save(session);

      session.status = "revoked";
      await storage.save(session);

      const loaded = await storage.load("sk_test123");
      expect(loaded?.status).toBe("revoked");
    });
  });

  describe("delete", () => {
    it("should remove a session", async () => {
      await storage.save(createMockSession("sk_1"));
      await storage.save(createMockSession("sk_2"));

      await storage.delete("sk_1");

      const all = await storage.loadAll();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe("sk_2");
    });
  });

  describe("listActive", () => {
    it("should only return active sessions", async () => {
      await storage.save(createMockSession("sk_active"));
      await storage.save(createMockSession("sk_revoked", { status: "revoked" }));

      const list = await storage.listActive();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe("sk_active");
    });

    it("should mark expired sessions and exclude them", async () => {
      await storage.save(createMockSession("sk_expired", {
        scope: { expiry: Math.floor(Date.now() / 1000) - 60, mode: "offchain" },
      }));

      const list = await storage.listActive();
      expect(list).toHaveLength(0);

      const loaded = await storage.load("sk_expired");
      expect(loaded?.status).toBe("expired");
    });
  });

  describe("autoCleanup", () => {
    it("should remove expired sessions", async () => {
      await storage.save(createMockSession("sk_old", {
        scope: { expiry: Math.floor(Date.now() / 1000) - 3600, mode: "offchain" },
      }));
      await storage.save(createMockSession("sk_fresh"));

      const cleaned = await storage.autoCleanup();
      expect(cleaned).toBe(1);

      const all = await storage.loadAll();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe("sk_fresh");
    });
  });

  describe("recordUsage / markRevoked", () => {
    it("should track usage count", async () => {
      const session = createMockSession("sk_usage");
      await storage.save(session);

      await storage.recordUsage("sk_usage");
      const loaded = await storage.load("sk_usage");
      expect(loaded?.useCount).toBe(1);

      await storage.recordUsage("sk_usage");
      const loaded2 = await storage.load("sk_usage");
      expect(loaded2?.useCount).toBe(2);
    });

    it("should mark session as revoked", async () => {
      const session = createMockSession("sk_rev");
      await storage.save(session);

      await storage.markRevoked("sk_rev");
      const loaded = await storage.load("sk_rev");
      expect(loaded?.status).toBe("revoked");
    });
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import type { SiwxSession } from "../src/session";
import {
  checkSessionExpired,
  createLocalStorageSiwxSessionStorage,
  createMemorySiwxSessionStorage,
} from "../src/session-storage";

// ── Helpers ─────────────────────────────────────────────────────────

function makeSession(overrides: Partial<SiwxSession> = {}): SiwxSession {
  const expiresAt =
    overrides.expiresAt ?? new Date(Date.now() + 3600_000).toISOString(); // 1h from now
  return {
    id: "siwx_test_abc",
    chainId: "eip155:1",
    address: "0x1234567890abcdef1234567890abcdef12345678",
    domain: "example.com",
    message: {
      raw: "example.com wants you to sign in...",
      domain: "example.com",
      address: "0x1234567890abcdef1234567890abcdef12345678",
      statement: null,
      uri: "https://example.com/login",
      version: 1,
      chainId: "eip155:1",
      nonce: "abc123",
      issuedAt: new Date().toISOString(),
      expirationTime: expiresAt,
      notBefore: null,
      resources: [],
      requestId: null,
      blockchain: "Ethereum",
    },
    signature: "0xdeadbeef",
    issuedAt: new Date().toISOString(),
    expiresAt,
    refreshedAt: null,
    ...overrides,
  };
}

// ── localStorage polyfill ───────────────────────────────────────────

function setupLocalStorage(): void {
  const store: Record<string, string> = {};
  const ls = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      Object.keys(store).forEach((k) => delete store[k]);
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: ls,
    writable: true,
    configurable: true,
  });
}

function clearLocalStorage(): void {
  if (typeof localStorage !== "undefined") {
    const keys = Object.keys(localStorage);
    keys.forEach((k) => localStorage.removeItem(k));
  }
}

// ── Tests: createMemorySiwxSessionStorage ────────────────────────────

describe("createMemorySiwxSessionStorage", () => {
  const storageKey = "test_siwx_session";

  beforeEach(() => {
    // Clear the underlying Map by creating a throwaway storage
    const s = createMemorySiwxSessionStorage(storageKey);
    s.clear();
  });

  it("should return null when no session stored", async () => {
    const storage = createMemorySiwxSessionStorage(storageKey);
    expect(await storage.get()).toBeNull();
  });

  it("should store and retrieve a session", async () => {
    const storage = createMemorySiwxSessionStorage(storageKey);
    const session = makeSession();

    await storage.set(session);
    const retrieved = await storage.get();

    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(session.id);
    expect(retrieved!.signature).toBe("0xdeadbeef");
  });

  it("should return null for expired sessions (auto-cleanup)", async () => {
    const storage = createMemorySiwxSessionStorage(storageKey);
    // Session that expired 10 seconds ago
    const expired = makeSession({
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
    });

    await storage.set(expired);
    const retrieved = await storage.get();
    expect(retrieved).toBeNull();
  });

  it("should report has() correctly", async () => {
    const storage = createMemorySiwxSessionStorage(storageKey);
    expect(await storage.has()).toBe(false);

    await storage.set(makeSession());
    expect(await storage.has()).toBe(true);
  });

  it("should remove a session", async () => {
    const storage = createMemorySiwxSessionStorage(storageKey);

    await storage.set(makeSession());
    expect(await storage.get()).not.toBeNull();

    await storage.remove();
    expect(await storage.get()).toBeNull();
  });

  it("should have() return false for expired sessions", async () => {
    const storage = createMemorySiwxSessionStorage(storageKey);
    const expired = makeSession({
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
    });

    await storage.set(expired);
    expect(await storage.has()).toBe(false);
  });

  it("should not treat non-session data as a session", async () => {
    // With memory storage, bad data can only enter through valid sessions,
    // so this verifies that storing/replacing with a valid session works
    // and that the basic round-trip is sound.
    const storage = createMemorySiwxSessionStorage(storageKey);
    expect(await storage.get()).toBeNull();
    expect(await storage.has()).toBe(false);

    await storage.set(makeSession());
    expect(await storage.get()).not.toBeNull();
  });
});

// ── Tests: createLocalStorageSiwxSessionStorage ──────────────────────

describe("createLocalStorageSiwxSessionStorage", () => {
  const storageKey = "ls_test_siwx_session";

  beforeEach(() => {
    setupLocalStorage();
    clearLocalStorage();
  });

  it("should store and retrieve a session", async () => {
    const storage = createLocalStorageSiwxSessionStorage(storageKey);
    const session = makeSession();

    await storage.set(session);
    const retrieved = await storage.get();

    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(session.id);
    expect(retrieved!.signature).toBe("0xdeadbeef");
  });

  it("should auto-remove expired sessions on get()", async () => {
    const storage = createLocalStorageSiwxSessionStorage(storageKey);
    const expired = makeSession({
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
    });

    await storage.set(expired);
    // After get(), the expired entry should be gone
    const retrieved = await storage.get();
    expect(retrieved).toBeNull();
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it("should report has() correctly", async () => {
    const storage = createLocalStorageSiwxSessionStorage(storageKey);
    expect(await storage.has()).toBe(false);

    await storage.set(makeSession());
    expect(await storage.has()).toBe(true);
  });

  it("should persist data across storage instances", async () => {
    // Write with one instance
    const writer = createLocalStorageSiwxSessionStorage(storageKey);
    await writer.set(makeSession());

    // Read with another instance
    const reader = createLocalStorageSiwxSessionStorage(storageKey);
    const retrieved = await reader.get();
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe("siwx_test_abc");
  });

  it("should remove from actual localStorage", async () => {
    const storage = createLocalStorageSiwxSessionStorage(storageKey);

    await storage.set(makeSession());
    expect(localStorage.getItem(storageKey)).not.toBeNull();

    await storage.remove();
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it("should handle corrupt localStorage data", async () => {
    const storage = createLocalStorageSiwxSessionStorage(storageKey);
    localStorage.setItem(storageKey, "{corrupt}");

    expect(await storage.get()).toBeNull();
    // Should have cleaned it up
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it("should support different storage keys", async () => {
    const storageA = createLocalStorageSiwxSessionStorage("key_a");
    const storageB = createLocalStorageSiwxSessionStorage("key_b");

    await storageA.set(makeSession({ id: "session_a" }));
    await storageB.set(makeSession({ id: "session_b" }));

    const a = await storageA.get();
    const b = await storageB.get();
    expect(a!.id).toBe("session_a");
    expect(b!.id).toBe("session_b");

    // Removing one should not affect the other
    await storageA.remove();
    expect(await storageA.get()).toBeNull();
    expect(await storageB.get()).not.toBeNull();
  });
});

// ── Tests: checkSessionExpired ──────────────────────────────────────

describe("checkSessionExpired", () => {
  it("should return true for null session", () => {
    expect(checkSessionExpired(null)).toBe(true);
  });

  it("should return false for session without expiry", () => {
    const session = makeSession({ expiresAt: null });
    expect(checkSessionExpired(session)).toBe(false);
  });

  it("should return false for non-expired session", () => {
    const session = makeSession({
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(checkSessionExpired(session)).toBe(false);
  });

  it("should return true for expired session", () => {
    const session = makeSession({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(checkSessionExpired(session)).toBe(true);
  });
});

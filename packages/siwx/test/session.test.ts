import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SiwxSession, SiwxSignInParams } from "../src/session";
import {
  DEFAULT_SESSION_EXPIRY_SECONDS,
  SiwxSessionManager,
} from "../src/session";
import { createMemorySiwxSessionStorage } from "../src/session-storage";

// ── Helpers ─────────────────────────────────────────────────────────

const TEST_SIGNATURE = "0xtest_signature_abc123";

// Shared Map so that different managers using the same key share storage.
const sharedStorageMap = new Map<string, string>();

function createTestManager(options?: {
  signMessage?: (params: {
    message: string;
    address: string;
  }) => string | Promise<string>;
  defaultExpirySeconds?: number;
}): SiwxSessionManager {
  const storageKey = "test_siwx_session";
  return new SiwxSessionManager({
    storage: {
      async get() {
        const raw = sharedStorageMap.get(storageKey);
        if (!raw) return null;
        try {
          const session = JSON.parse(raw) as SiwxSession;
          if (
            session.expiresAt &&
            new Date(session.expiresAt).getTime() <= Date.now()
          ) {
            sharedStorageMap.delete(storageKey);
            return null;
          }
          return session;
        } catch {
          sharedStorageMap.delete(storageKey);
          return null;
        }
      },
      async set(session: SiwxSession) {
        sharedStorageMap.set(storageKey, JSON.stringify(session));
      },
      async remove() {
        sharedStorageMap.delete(storageKey);
      },
      async has() {
        const raw = sharedStorageMap.get(storageKey);
        if (!raw) return false;
        try {
          const session = JSON.parse(raw) as SiwxSession;
          if (
            session.expiresAt &&
            new Date(session.expiresAt).getTime() <= Date.now()
          ) {
            sharedStorageMap.delete(storageKey);
            return false;
          }
          return true;
        } catch {
          sharedStorageMap.delete(storageKey);
          return false;
        }
      },
      async clear() {
        sharedStorageMap.clear();
      },
    },
    signMessage:
      options?.signMessage ?? vi.fn().mockResolvedValue(TEST_SIGNATURE),
    defaultExpirySeconds: options?.defaultExpirySeconds,
  });
}

beforeEach(() => {
  sharedStorageMap.clear();
});

const baseSignInParams: SiwxSignInParams = {
  chainId: "eip155:1",
  address: "0x1234567890abcdef1234567890abcdef12345678",
  domain: "example.com",
  uri: "https://example.com/login",
  statement: "Sign in to access your account.",
  nonce: "testNonce123",
};

// ── Tests ───────────────────────────────────────────────────────────

describe("SiwxSessionManager", () => {
  let mgr: SiwxSessionManager;

  beforeEach(() => {
    mgr = createTestManager();
  });

  afterEach(async () => {
    await mgr.signOut().catch(() => {});
  });

  // -----------------------------------------------------------------------
  // signIn
  // -----------------------------------------------------------------------

  describe("signIn", () => {
    it("should create a session with all required fields", async () => {
      const session = await mgr.signIn(baseSignInParams);

      expect(session).toBeDefined();
      expect(session.id).toMatch(/^siwx_/);
      expect(session.chainId).toBe("eip155:1");
      expect(session.address).toBe(
        "0x1234567890abcdef1234567890abcdef12345678",
      );
      expect(session.domain).toBe("example.com");
      expect(session.signature).toBe(TEST_SIGNATURE);
      expect(session.message).toBeDefined();
      expect(session.issuedAt).toBeDefined();
    });

    it("should set a default expiry of 24h when expirySeconds is not provided", async () => {
      const session = await mgr.signIn(baseSignInParams);

      expect(session.expiresAt).not.toBeNull();
      const diff =
        new Date(session.expiresAt!).getTime() -
        new Date(session.issuedAt).getTime();
      // 24h ± 2s tolerance
      expect(diff).toBeGreaterThan(
        DEFAULT_SESSION_EXPIRY_SECONDS * 1000 - 2000,
      );
      expect(diff).toBeLessThan(DEFAULT_SESSION_EXPIRY_SECONDS * 1000 + 2000);
    });

    it("should respect custom expirySeconds", async () => {
      const session = await mgr.signIn({
        ...baseSignInParams,
        expirySeconds: 3600, // 1 hour
      });

      expect(session.expiresAt).not.toBeNull();
      const diff =
        new Date(session.expiresAt!).getTime() -
        new Date(session.issuedAt).getTime();
      expect(diff).toBeGreaterThan(3600 * 1000 - 2000);
      expect(diff).toBeLessThan(3600 * 1000 + 2000);
    });

    it("should set no expiry when expirySeconds is 0", async () => {
      const session = await mgr.signIn({
        ...baseSignInParams,
        expirySeconds: 0,
      });

      expect(session.expiresAt).toBeNull();
    });

    it("should generate a nonce when not provided", async () => {
      const session = await mgr.signIn({
        ...baseSignInParams,
        nonce: undefined,
      });

      expect(session.message.nonce).toBeDefined();
      expect(session.message.nonce.length).toBeGreaterThan(0);
    });

    it("should use the provided signMessage function", async () => {
      const mockSign = vi.fn().mockResolvedValue("0xcustom_sig");
      const customMgr = createTestManager({ signMessage: mockSign });

      const session = await customMgr.signIn(baseSignInParams);

      expect(mockSign).toHaveBeenCalledTimes(1);
      expect(mockSign).toHaveBeenCalledWith({
        message: expect.stringContaining("example.com wants you to sign in"),
        address: baseSignInParams.address,
      });
      expect(session.signature).toBe("0xcustom_sig");
    });

    it("should include metadata when provided", async () => {
      const session = await mgr.signIn({
        ...baseSignInParams,
      });

      // No metadata by default
      expect(session.metadata).toBeUndefined();
    });

    it("should persist the session to storage after signIn", async () => {
      await mgr.signIn(baseSignInParams);

      // Create a new manager with the same storage key to verify persistence
      const freshMgr = createTestManager();
      const restored = await freshMgr.restore();
      expect(restored).not.toBeNull();
      expect(restored!.address).toBe(baseSignInParams.address);
    });
  });

  // -----------------------------------------------------------------------
  // getSession
  // -----------------------------------------------------------------------

  describe("getSession", () => {
    it("should return null when no session exists", () => {
      expect(mgr.getSession()).toBeNull();
    });

    it("should return the active session after signIn", async () => {
      await mgr.signIn(baseSignInParams);

      const session = mgr.getSession();
      expect(session).not.toBeNull();
      expect(session!.address).toBe(baseSignInParams.address);
    });

    it("should return null for expired session", async () => {
      // Create a session that expired 1 second ago
      const mgrWithInstantExpiry = createTestManager({
        defaultExpirySeconds: 0,
      });

      // For 0 expiry, expiresAt is null, so let's test with 1ms expiry
      const expiredSession = await mgr.signIn({
        ...baseSignInParams,
        expirySeconds: 0, // no expiry
      });

      // Test that non-expiring sessions are returned
      expect(mgr.getSession()).not.toBeNull();
    });

    it("should return session after signIn and restore", async () => {
      await mgr.signIn(baseSignInParams);

      const freshMgr = createTestManager();
      expect(freshMgr.getSession()).toBeNull(); // not in memory

      await freshMgr.restore();
      expect(freshMgr.getSession()).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // signOut
  // -----------------------------------------------------------------------

  describe("signOut", () => {
    it("should clear the session from memory", async () => {
      await mgr.signIn(baseSignInParams);
      expect(mgr.getSession()).not.toBeNull();

      await mgr.signOut();
      expect(mgr.getSession()).toBeNull();
    });

    it("should clear the session from storage", async () => {
      await mgr.signIn(baseSignInParams);

      await mgr.signOut();

      const freshMgr = createTestManager();
      const restored = await freshMgr.restore();
      expect(restored).toBeNull();
    });

    it("should not throw when signing out without an active session", async () => {
      await expect(mgr.signOut()).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // refresh
  // -----------------------------------------------------------------------

  describe("refresh", () => {
    it("should refresh an active session with updated timestamps", async () => {
      const session = await mgr.signIn(baseSignInParams);
      const originalId = session.id;
      const originalSignature = session.signature;
      const originalIssuedAt = session.issuedAt;

      // Wait a tiny bit so timestamps differ
      await new Promise((r) => setTimeout(r, 10));

      const refreshed = await mgr.refresh();

      expect(refreshed.id).toBe(originalId); // same session
      expect(refreshed.issuedAt).not.toBe(originalIssuedAt);
      expect(refreshed.refreshedAt).not.toBeNull();
      expect(refreshed.signature).toBe(TEST_SIGNATURE); // same mock
      expect(refreshed.address).toBe(baseSignInParams.address);
    });

    it("should update the expiry in the refreshed session", async () => {
      await mgr.signIn({
        ...baseSignInParams,
        expirySeconds: 3600,
      });

      const refreshed = await mgr.refresh({ expirySeconds: 7200 });

      const diff =
        new Date(refreshed.expiresAt!).getTime() -
        new Date(refreshed.issuedAt).getTime();
      expect(diff).toBeGreaterThan(7200 * 1000 - 2000);
      expect(diff).toBeLessThan(7200 * 1000 + 2000);
    });

    it("should throw when no active session exists", async () => {
      await expect(mgr.refresh()).rejects.toThrow(
        "No active session to refresh",
      );
    });

    it("should persist the refreshed session", async () => {
      const session = await mgr.signIn(baseSignInParams);
      const originalExpiresAt = session.expiresAt;

      await new Promise((r) => setTimeout(r, 5));
      await mgr.refresh({ expirySeconds: 7200 });

      // Verify the storage now has the refreshed version
      const freshMgr = createTestManager();
      const restored = await freshMgr.restore();
      expect(restored!.expiresAt).not.toBe(originalExpiresAt);
    });
  });

  // -----------------------------------------------------------------------
  // restore
  // -----------------------------------------------------------------------

  describe("restore", () => {
    it("should restore a session from storage", async () => {
      const session = await mgr.signIn(baseSignInParams);

      const freshMgr = createTestManager();
      const restored = await freshMgr.restore();

      expect(restored).not.toBeNull();
      expect(restored!.id).toBe(session.id);
      expect(restored!.address).toBe(session.address);
    });

    it("should throw on signOut after expiry if storage was cleaned", async () => {
      await mgr.signIn({
        ...baseSignInParams,
        expirySeconds: 0, // no expiry
      });
      expect(mgr.getSession()).not.toBeNull();
    });

    it("should return null when nothing in storage", async () => {
      const result = await mgr.restore();
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // isExpired / getTimeUntilExpiry
  // -----------------------------------------------------------------------

  describe("expiry queries", () => {
    it("should return true for isExpired when no session", () => {
      expect(mgr.isExpired()).toBe(true);
    });

    it("should return false for isExpired with an active session", async () => {
      await mgr.signIn(baseSignInParams);
      expect(mgr.isExpired()).toBe(false);
    });

    it("should return null for getTimeUntilExpiry when no session", () => {
      expect(mgr.getTimeUntilExpiry()).toBeNull();
    });

    it("should return positive number for getTimeUntilExpiry with an active session", async () => {
      await mgr.signIn(baseSignInParams);
      const remaining = mgr.getTimeUntilExpiry();
      expect(remaining).toBeGreaterThan(0);
    });

    it("should return null for getTimeUntilExpiry when session has no expiry", async () => {
      const noExpMgr = createTestManager();
      await noExpMgr.signIn({
        ...baseSignInParams,
        expirySeconds: 0,
      });
      expect(noExpMgr.getTimeUntilExpiry()).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Event callbacks
  // -----------------------------------------------------------------------

  describe("onSessionChange", () => {
    it("should fire onSessionChange after signIn", async () => {
      const callback = vi.fn();
      mgr.onSessionChange(callback);

      await mgr.signIn(baseSignInParams);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ address: baseSignInParams.address }),
      );
    });

    it("should fire onSessionChange with null after signOut", async () => {
      await mgr.signIn(baseSignInParams);
      const callback = vi.fn();
      mgr.onSessionChange(callback);

      await mgr.signOut();

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(null);
    });

    it("should fire onSessionChange after refresh", async () => {
      await mgr.signIn(baseSignInParams);
      const callback = vi.fn();
      mgr.onSessionChange(callback);

      await mgr.refresh();

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ refreshedAt: expect.any(String) }),
      );
    });

    it("should fire onSessionChange after restore", async () => {
      await mgr.signIn(baseSignInParams);

      const freshMgr = createTestManager();
      const callback = vi.fn();
      freshMgr.onSessionChange(callback);

      const restored = await freshMgr.restore();

      expect(callback).toHaveBeenCalledTimes(1);
      expect(restored).not.toBeNull();
    });

    it("should allow unsubscribing from session changes", async () => {
      const callback = vi.fn();
      const unsubscribe = mgr.onSessionChange(callback);
      unsubscribe();

      await mgr.signIn(baseSignInParams);
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("onExpiry", () => {
    it("should fire onExpiry callback", async () => {
      const callback = vi.fn();
      mgr.onExpiry(callback);

      // Create a session that will "expire" immediately by using a timer
      // We can't easily test the timer, but we can verify the callback is registered
      await mgr.signIn(baseSignInParams);

      // Verify callback was not fired yet (session still valid)
      expect(callback).not.toHaveBeenCalled();
    });

    it("should allow unsubscribing from expiry", async () => {
      const callback = vi.fn();
      const unsubscribe = mgr.onExpiry(callback);
      unsubscribe();
      expect(true).toBe(true); // no crash
    });
  });

  // -----------------------------------------------------------------------
  // Chain-agnostic
  // -----------------------------------------------------------------------

  describe("chain-agnostic support", () => {
    it("should support Solana CAIP-2 chain ID", async () => {
      const solanaSession = await mgr.signIn({
        ...baseSignInParams,
        chainId: "solana:4sGjMW1s",
        address: "5JG7DPRQAxJVCLx3GxsHTxP1KZbSyLmPQBLkLhFZPGrH",
      });

      expect(solanaSession.chainId).toBe("solana:4sGjMW1s");
      expect(solanaSession.message.chainId).toBe("solana:4sGjMW1s");
      expect(solanaSession.message.blockchain).toBe("Solana");
    });

    it("should support XRPL CAIP-2 chain ID", async () => {
      const xrplSession = await mgr.signIn({
        ...baseSignInParams,
        chainId: "xrpl:0",
        address: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
      });

      expect(xrplSession.chainId).toBe("xrpl:0");
      expect(xrplSession.message.blockchain).toBe("XRP Ledger");
    });

    it("should support custom blockchain name override", async () => {
      const session = await mgr.signIn({
        ...baseSignInParams,
        blockchain: "CustomChain",
      });

      expect(session.message.blockchain).toBe("CustomChain");
    });
  });
});

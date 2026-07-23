import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionKeyManager } from "../SessionKeyManager";
import type { SessionKeyScope } from "../types";
import type { TransactionRequest } from "../../signers/types";

// Mock localStorage
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

describe("session-keys / SessionKeyManager", () => {
  const TEST_SEED = new Uint8Array(32).fill(0x42);
  const TEST_ADDRESS = "0x" + "ab".repeat(20) as `0x${string}`;
  let mgr: SessionKeyManager;

  beforeEach(() => {
    localStorageMock.clear();
    mgr = new SessionKeyManager(TEST_SEED, TEST_ADDRESS);
  });

  function makeScope(overrides?: Partial<SessionKeyScope>): SessionKeyScope {
    return {
      expiry: Math.floor(Date.now() / 1000) + 3600,
      mode: "offchain",
      maxTxCount: 10,
      maxValuePerTx: BigInt("100000000000000000"), // 0.1 ETH
      maxTotalValue: BigInt("500000000000000000"), // 0.5 ETH
      ...overrides,
    };
  }

  describe("createSessionKey", () => {
    it("should create a session key with valid scope", async () => {
      const info = await mgr.createSessionKey(makeScope());

      expect(info.id).toMatch(/^sk_[a-z0-9]{24}$/);
      expect(info.publicKey).toMatch(/^0x[0-9a-f]{66}$/);
      expect(info.status).toBe("active");
      expect(info.scope.expiry).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(info.signerAddress).toBe(TEST_ADDRESS);
    });

    it("should reject past expiry", async () => {
      await expect(
        mgr.createSessionKey(makeScope({ expiry: Math.floor(Date.now() / 1000) - 60 })),
      ).rejects.toThrow("future");
    });

    it("should reject invalid mode", async () => {
      await expect(
        mgr.createSessionKey(makeScope({ mode: "invalid" as any })),
      ).rejects.toThrow("mode");
    });
  });

  describe("listSessions", () => {
    it("should return created sessions", async () => {
      await mgr.createSessionKey(makeScope());
      await mgr.createSessionKey(makeScope());

      const sessions = await mgr.listSessions();
      expect(sessions).toHaveLength(2);
    });

    it("should exclude expired sessions", async () => {
      // Create a fresh session
      const good = await mgr.createSessionKey(makeScope({ expiry: Math.floor(Date.now() / 1000) + 100 }));

      // Manually insert an already-expired session via storage for testing
      const { SessionKeyStorage } = await import("../storage");
      const { SessionKeyManager: SKM } = await import("../SessionKeyManager");
      const s = new SessionKeyStorage();
      const pair = await (await import("../crypto")).generateSessionKeyPair();
      const encrypted = await (await import("../crypto")).encryptSessionKey(pair, TEST_SEED);
      await s.save({
        id: "sk_expired_test",
        keyPair: encrypted,
        scope: { expiry: Math.floor(Date.now() / 1000) - 60, mode: "offchain" },
        authorization: { signerAddress: TEST_ADDRESS, type: "offchain" },
        status: "active",
        createdAt: Date.now() - 3600000,
        lastUsedAt: Date.now() - 3600000,
        useCount: 0,
      });

      const sessions = await mgr.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe(good.id);
    });

    it("should exclude revoked sessions", async () => {
      const info = await mgr.createSessionKey(makeScope());
      await mgr.revokeSession(info.id);

      const sessions = await mgr.listSessions();
      expect(sessions).toHaveLength(0);
    });
  });

  describe("revokeSession", () => {
    it("should mark a session as revoked", async () => {
      const info = await mgr.createSessionKey(makeScope());
      await mgr.revokeSession(info.id);

      // After revoke, it should not appear in list
      const sessions = await mgr.listSessions();
      expect(sessions.find(s => s.id === info.id)).toBeUndefined();
    });

    it("should throw for non-existent session", async () => {
      await expect(mgr.revokeSession("sk_nonexistent")).rejects.toThrow("not found");
    });

    it("should throw for already revoked session", async () => {
      const info = await mgr.createSessionKey(makeScope());
      await mgr.revokeSession(info.id);
      await expect(mgr.revokeSession(info.id)).rejects.toThrow("already");
    });
  });

  describe("signWithSession", () => {
    it("should sign a valid transaction within scope", async () => {
      const info = await mgr.createSessionKey(makeScope());

      const tx: TransactionRequest = {
        to: "0x" + "cd".repeat(20),
        value: "0x" + BigInt("10000000000000000").toString(16), // 0.01 ETH
        data: "0x",
        gas: "0x5208", // 21000
        nonce: "0x1",
        chainId: 1,
      };

      const result = await mgr.signWithSession(info.id, tx);
      expect(result.signature).toMatch(/^0x[0-9a-f]+$/);
      expect(result.sessionId).toBe(info.id);
    });

    it("should reject expired session", async () => {
      // Create session that expires immediately (now)
      const { SessionKeyStorage } = await import("../storage");
      const s = new SessionKeyStorage();
      const pair = await (await import("../crypto")).generateSessionKeyPair();
      const encrypted = await (await import("../crypto")).encryptSessionKey(pair, TEST_SEED);
      await s.save({
        id: "sk_expired_now",
        keyPair: encrypted,
        scope: { expiry: Math.floor(Date.now() / 1000) - 60, mode: "offchain" },
        authorization: { signerAddress: TEST_ADDRESS, type: "offchain" },
        status: "active",
        createdAt: Date.now() - 3600000,
        lastUsedAt: Date.now() - 3600000,
        useCount: 0,
      });

      const tx: TransactionRequest = {
        to: "0x" + "cd".repeat(20),
        value: "0x1",
        data: "0x",
        gas: "0x5208",
        nonce: "0x1",
        chainId: 1,
      };

      await expect(mgr.signWithSession("sk_expired_now", tx)).rejects.toThrow("expired");
    });

    it("should reject revoked session", async () => {
      const info = await mgr.createSessionKey(makeScope());
      await mgr.revokeSession(info.id);

      const tx: TransactionRequest = {
        to: "0x" + "cd".repeat(20),
        value: "0x1",
        data: "0x",
        gas: "0x5208",
        nonce: "0x1",
        chainId: 1,
      };

      await expect(mgr.signWithSession(info.id, tx)).rejects.toThrow("revoked");
    });

    it("should reject tx exceeding value per tx limit", async () => {
      const info = await mgr.createSessionKey(makeScope({
        maxValuePerTx: BigInt("10000000000000000"), // 0.01 ETH
      }));

      const tx: TransactionRequest = {
        to: "0x" + "cd".repeat(20),
        value: "0x" + BigInt("20000000000000000").toString(16), // 0.02 ETH
        data: "0x",
        gas: "0x5208",
        nonce: "0x1",
        chainId: 1,
      };

      await expect(mgr.signWithSession(info.id, tx)).rejects.toThrow("exceeds");
    });

    it("should track usage count", async () => {
      const info = await mgr.createSessionKey(makeScope());

      const tx: TransactionRequest = {
        to: "0x" + "cd".repeat(20),
        value: "0x1",
        data: "0x",
        gas: "0x5208",
        nonce: "0x1",
        chainId: 1,
      };

      await mgr.signWithSession(info.id, tx);
      await mgr.signWithSession(info.id, tx);

      // After usage, check scope refetch (internal; public API check)
      const check = await mgr.checkScope(info.id, tx);
      expect(check.valid).toBe(true);
    });

    it("should reject tx exceeding maxTxCount", async () => {
      const info = await mgr.createSessionKey(makeScope({ maxTxCount: 1 }));

      const tx: TransactionRequest = {
        to: "0x" + "cd".repeat(20),
        value: "0x1",
        data: "0x",
        gas: "0x5208",
        nonce: "0x1",
        chainId: 1,
      };

      // First one works
      await mgr.signWithSession(info.id, tx);

      // Second should fail (useCount reached maxTxCount)
      await expect(mgr.signWithSession(info.id, tx)).rejects.toThrow("Transaction count limit");
    });

    it("should reject tx with non-allowed contract", async () => {
      const info = await mgr.createSessionKey(makeScope({
        allowedContracts: ["0x" + "aa".repeat(20) as `0x${string}`],
      }));

      const tx: TransactionRequest = {
        to: "0x" + "bb".repeat(20), // not in allowedContracts
        value: "0x1",
        data: "0x",
        gas: "0x5208",
        nonce: "0x1",
        chainId: 1,
      };

      await expect(mgr.signWithSession(info.id, tx)).rejects.toThrow("not in allowed contracts");
    });

    it("should reject tx with non-allowed method", async () => {
      const info = await mgr.createSessionKey(makeScope({
        allowedContracts: ["0x" + "aa".repeat(20) as `0x${string}`],
        allowedMethods: ["0xa9059cbb"], // transfer(address,uint256)
      }));

      const tx: TransactionRequest = {
        to: "0x" + "aa".repeat(20),
        value: "0x1",
        data: "0x095ea7b3" + "00".repeat(20), // approve() selector
        gas: "0x5208",
        nonce: "0x1",
        chainId: 1,
      };

      await expect(mgr.signWithSession(info.id, tx)).rejects.toThrow("not in allowed methods");
    });

    it("should reject tx with non-allowed chainId", async () => {
      const info = await mgr.createSessionKey(makeScope({
        allowedChainIds: [1],
      }));

      const tx: TransactionRequest = {
        to: "0x" + "cd".repeat(20),
        value: "0x1",
        data: "0x",
        gas: "0x5208",
        nonce: "0x1",
        chainId: 137, // Polygon, not in allowedChainIds
      };

      await expect(mgr.signWithSession(info.id, tx)).rejects.toThrow("not in allowed chain IDs");
    });
  });

  describe("checkScope", () => {
    it("should return valid scope for matching tx", async () => {
      const info = await mgr.createSessionKey(makeScope());

      const tx: TransactionRequest = {
        to: "0x" + "cd".repeat(20),
        value: "0x1",
        data: "0x",
        gas: "0x5208",
        nonce: "0x1",
        chainId: 1,
      };

      const result = await mgr.checkScope(info.id, tx);
      expect(result.valid).toBe(true);
    });

    it("should return invalid for non-existent session", async () => {
      const tx: TransactionRequest = {
        to: "0x" + "cd".repeat(20),
        value: "0x1",
        data: "0x",
      };

      const result = await mgr.checkScope("sk_nonexistent", tx);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("not found");
    });

    it("should return remainingTxCount with scope info", async () => {
      const info = await mgr.createSessionKey(makeScope({ maxTxCount: 5 }));

      const tx: TransactionRequest = {
        to: "0x" + "cd".repeat(20),
        value: "0x1",
        data: "0x",
        gas: "0x5208",
        nonce: "0x1",
        chainId: 1,
      };

      // Use 1 of 5
      await mgr.signWithSession(info.id, tx);

      const result = await mgr.checkScope(info.id, tx);
      expect(result.remainingTxCount).toBe(3); // 5 - 1 - 1 = 3 remaining after this check
    });
  });
});

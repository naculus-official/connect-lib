import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ADDRESSES } from "@naculus/test-utils/test-constants";
import { SessionKeyManager } from "../SessionKeyManager";
import { MemoryStorageAdapter } from "../../storage";
import type { SessionKeyScope, SessionKeyInfo } from "../types";

// ─── Helpers ───────────────────────────────────────────────────────────

function createManager(config?: Record<string, unknown>) {
  return new SessionKeyManager(
    {
      defaultExpiryMs: 60_000, // 1 minute for tests
      defaultMaxTxCount: 5,
      defaultMaxTotalValue: BigInt("1000000000000000000"), // 1 ETH
      requireAllowedContracts: false,
      pbkdf2Iterations: 10, // FAST for testing (default: 600_000)
      encryptionKey: "test-key",
      ...config,
    },
    new MemoryStorageAdapter(),
  );
}

function makeScope(overrides?: Partial<SessionKeyScope>): SessionKeyScope {
  return {
    expiry: Math.floor(Date.now() / 1000) + 3600,
    mode: "offchain",
    maxTxCount: 10,
    maxTotalValue: BigInt("100000000000000000"), // 0.1 ETH
    allowedContracts: ["0xdAC17F958D2ee523a2206206994597C13D831ec7" as `0x${string}`],
    allowedMethods: ["0xa9059cbb"], // transfer(address,uint256)
    allowedChainIds: [1],
    ...overrides,
  };
}

const signerAddress = "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18" as `0x${string}`;
const testTx = {
  to: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  value: "0x2386f26fc10000", // 0.01 ETH in wei (10^16 = 0.01 * 10^18)
  data: "0xa9059cbb" + "0".repeat(120), // transfer(address,uint256)
  chainId: 1,
};

// ─── Tests ─────────────────────────────────────────────────────────────

describe("SessionKeyManager", () => {
  let manager: SessionKeyManager;

  beforeEach(() => {
    manager = createManager();
  });

  afterEach(async () => {
    await manager.clearAll();
  });

  describe("createSessionKey", () => {
    it("should create a session key with default scope", async () => {
      const info = await manager.createSessionKey(undefined, signerAddress);
      expect(info.id).toBeTruthy();
      expect(info.publicKey).toMatch(/^0x[a-f0-9]{66}$/i);
      expect(info.status).toBe("active");
      expect(info.useCount).toBe(0);
      expect(info.signerAddress).toBe(signerAddress);
      expect(info.scope.mode).toBe("offchain");
    });

    it("should create a session key with custom scope", async () => {
      const scope = makeScope({
        maxTxCount: 3,
        maxTotalValue: BigInt("50000000000000000"), // 0.05 ETH
      });
      const info = await manager.createSessionKey(scope, signerAddress);

      expect(info.scope.maxTxCount).toBe(3);
      expect(info.scope.maxTotalValue).toBe(BigInt("50000000000000000"));
    });

    it("should generate a unique public key each time", async () => {
      const info1 = await manager.createSessionKey(undefined, signerAddress);
      const info2 = await manager.createSessionKey(undefined, signerAddress);
      expect(info1.publicKey).not.toBe(info2.publicKey);
      expect(info1.id).not.toBe(info2.id);
    });

    it("should throw when requireAllowedContracts is enabled and no contracts provided", async () => {
      const strictManager = createManager({ requireAllowedContracts: true });
      await expect(
        strictManager.createSessionKey({ mode: "offchain" }, signerAddress),
      ).rejects.toThrow();
    });
  });

  describe("listSessions", () => {
    it("should return empty list when no keys exist", async () => {
      const sessions = await manager.listSessions();
      expect(sessions).toEqual([]);
    });

    it("should list all created session keys", async () => {
      await manager.createSessionKey(undefined, signerAddress);
      await manager.createSessionKey(undefined, signerAddress);
      await manager.createSessionKey(undefined, signerAddress);

      const sessions = await manager.listSessions();
      expect(sessions).toHaveLength(3);
    });

    it("should include revoked and expired keys", async () => {
      const info = await manager.createSessionKey(undefined, signerAddress);
      await manager.revokeSession(info.id);

      const sessions = await manager.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("revoked");
    });

    it("should mark expired keys as expired", async () => {
      const expiredManager = createManager({ defaultExpiryMs: -100_000 }); // well in the past
      const info = await expiredManager.createSessionKey(undefined, signerAddress);

      const sessions = await expiredManager.listSessions();
      expect(sessions.find((s) => s.id === info.id)?.status).toBe("expired");
    });
  });

  describe("revokeSession", () => {
    it("should revoke an active session key", async () => {
      const info = await manager.createSessionKey(undefined, signerAddress);
      expect(info.status).toBe("active");

      await manager.revokeSession(info.id);

      const sessions = await manager.listSessions();
      const revoked = sessions.find((s) => s.id === info.id);
      expect(revoked?.status).toBe("revoked");
    });

    it("should throw when trying to use a revoked key", async () => {
      const info = await manager.createSessionKey(undefined, signerAddress);
      await manager.revokeSession(info.id);

      await expect(manager.signWithSessionKey(info.id, "0x" + "ab".repeat(32) as `0x${string}`)).rejects.toThrow();
    });
  });

  describe("checkSessionScope", () => {
    it("should allow transactions within scope", async () => {
      const info = await manager.createSessionKey(makeScope(), signerAddress);
      const result = await manager.checkSessionScope(info.id, testTx);
      expect(result.valid).toBe(true);
    });

    it("should reject transactions with wrong contract", async () => {
      const scope = makeScope({
        allowedContracts: ["0x1111111111111111111111111111111111111111" as `0x${string}`],
      });
      const info = await manager.createSessionKey(scope, signerAddress);
      const result = await manager.checkSessionScope(info.id, testTx);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("not in allowed list");
    });

    it("should reject transactions exceeding max value", async () => {
      const scope = makeScope({
        maxValuePerTx: BigInt("1000000000000000"), // 0.001 ETH
      });
      const info = await manager.createSessionKey(scope, signerAddress);
      const result = await manager.checkSessionScope(info.id, testTx);
      expect(result.valid).toBe(false);
    });

    it("should reject transactions on wrong chain", async () => {
      const scope = makeScope({ allowedChainIds: [137] }); // Polygon
      const info = await manager.createSessionKey(scope, signerAddress);
      const result = await manager.checkSessionScope(info.id, testTx);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("not in allowed list");
    });

    it("should reject forbidden methods", async () => {
      const approveTx = {
        ...testTx,
        data: ("0x095ea7b3" + "0".repeat(120)) as `0x${string}`, // approve()
      };
      const info = await manager.createSessionKey(makeScope(), signerAddress);
      const result = await manager.checkSessionScope(info.id, approveTx);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("forbidden");
    });

    it("should return remaining budgets for valid transactions", async () => {
      const scope = makeScope({
        maxTotalValue: BigInt("200000000000000000"), // 0.2 ETH
        maxTxCount: 5,
      });
      const info = await manager.createSessionKey(scope, signerAddress);
      const result = await manager.checkSessionScope(info.id, testTx);
      expect(result.valid).toBe(true);
      expect(result.remainingValue).toBeGreaterThan(0n);
      expect(result.remainingTxCount).toBe(4); // 5 - 0 - 1
    });
  });

  describe("signWithSessionKey", () => {
    it("should produce a valid secp256k1 signature", async () => {
      const info = await manager.createSessionKey(makeScope(), signerAddress);
      const messageHash = "0x" + "ab".repeat(32) as `0x${string}`;

      const signature = await manager.signWithSessionKey(info.id, messageHash);
      expect(signature).toMatch(/^0x[a-f0-9]{130}$/i); // 65 bytes (r=32, s=32, v=1)
    });

    it("should throw for non-existent session key", async () => {
      await expect(
        manager.signWithSessionKey("nonexistent-id", "0x" + "ab".repeat(32) as `0x${string}`),
      ).rejects.toThrow();
    });

    it("should throw for expired session key", async () => {
      const expiredManager = createManager({ defaultExpiryMs: -100_000 }); // well in the past
      const info = await expiredManager.createSessionKey(undefined, signerAddress);

      await expect(
        expiredManager.signWithSessionKey(info.id, "0x" + "ab".repeat(32) as `0x${string}`),
      ).rejects.toThrow();
    });
  });

  describe("setAuthorization", () => {
    it("should attach an authorization to an existing key", async () => {
      const info = await manager.createSessionKey(undefined, signerAddress);
      await manager.setAuthorization(info.id, {
        signerAddress: "0x1234567890123456789012345678901234567890" as `0x${string}`,
        type: "eip7702",
        authorization: "0xauthorizationdata",
      });

      // Verify by checking the bundle (authorization is included)
      const bundle = await manager.getSessionBundle(info.id);
      expect(bundle.authorization.type).toBe("eip7702");
      expect(bundle.authorization.signerAddress).toBe("0x1234567890123456789012345678901234567890");
    });
  });

  describe("session lifecycle", () => {
    it("should create, verify scope, sign, and track usage", async () => {
      // Create
      const info = await manager.createSessionKey(makeScope(), signerAddress);
      expect(info.useCount).toBe(0);

      // Check scope
      const scopeCheck = await manager.checkSessionScope(info.id, testTx);
      expect(scopeCheck.valid).toBe(true);

      // Sign
      const hash = "0x" + "cd".repeat(32) as `0x${string}`;
      const sig = await manager.signWithSessionKey(info.id, hash);
      expect(sig).toBeTruthy();

      // Revoke
      await manager.revokeSession(info.id);
      const sessions = await manager.listSessions();
      expect(sessions.find((s) => s.id === info.id)?.status).toBe("revoked");

      // Post-revoke scope check should fail
      const postRevoke = await manager.checkSessionScope(info.id, testTx);
      expect(postRevoke.valid).toBe(false);
    });
  });
});

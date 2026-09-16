import { ADDRESSES } from "@naculus/test-utils/test-constants";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "../../storage";
import { SessionKeyManager } from "../SessionKeyManager";
import { decryptPrivateKey, SessionKeyStorage } from "../storage";
import type { SessionKeyInfo, SessionKeyScope } from "../types";

// ─── Helpers ───────────────────────────────────────────────────────────

function createManager(config?: Record<string, unknown>) {
  return new SessionKeyManager(
    {
      defaultExpiryMs: 60_000, // 1 minute for tests
      defaultMaxTxCount: 5,
      defaultMaxTotalValue: BigInt("1000000000000000000"), // 1 ETH
      requireAllowedContracts: false,
      pbkdf2Iterations: 10, // FAST for testing (default: 600_000)
      unsafeAllowWeakKdf: true,
      encryptionKey: "test-key",
      ...config,
    },
    new MemoryStorageAdapter(),
  );
}

function createManagerWithAdapter(
  adapter: MemoryStorageAdapter,
  config: Record<string, unknown> = {},
) {
  return new SessionKeyManager(
    {
      defaultExpiryMs: 60_000,
      defaultMaxTxCount: 5,
      defaultMaxTotalValue: BigInt("1000000000000000000"),
      requireAllowedContracts: false,
      pbkdf2Iterations: 10,
      unsafeAllowWeakKdf: true,
      encryptionKey: "test-key",
      ...config,
    },
    adapter,
  );
}

function makeScope(overrides?: Partial<SessionKeyScope>): SessionKeyScope {
  return {
    expiry: Math.floor(Date.now() / 1000) + 3600,
    mode: "offchain",
    maxTxCount: 10,
    maxTotalValue: BigInt("100000000000000000"), // 0.1 ETH
    allowedContracts: [
      "0xdAC17F958D2ee523a2206206994597C13D831ec7" as `0x${string}`,
    ],
    allowedMethods: ["0xa9059cbb"], // transfer(address,uint256)
    allowedChainIds: [1],
    ...overrides,
  };
}

const signerAddress =
  "0x742D35CC6634C0532925a3B844Bc9E7595F2bD18" as `0x${string}`;
const tokenAddress =
  "0xdAC17F958D2ee523a2206206994597C13D831ec7" as `0x${string}`;
const rawAuthorization = `0x${"12".repeat(65)}` as `0x${string}`;
const testTx = {
  to: tokenAddress,
  value: "0x2386f26fc10000", // 0.01 ETH in wei (10^16 = 0.01 * 10^18)
  data: "0xa9059cbb" + "0".repeat(120), // transfer(address,uint256)
  chainId: 1,
};

async function authorize(
  manager: SessionKeyManager,
  sessionId: string,
): Promise<void> {
  await manager.setAuthorization(sessionId, {
    signerAddress,
    type: "offchain",
    rawSignature: rawAuthorization,
    message: "test authorization",
  });
}

function erc20Transfer(amount: bigint) {
  return {
    ...testTx,
    value: "0x0",
    data: `0xa9059cbb${"0".repeat(24)}${"11".repeat(20)}${amount.toString(16).padStart(64, "0")}`,
  };
}

function erc20TransferFrom(amount: bigint) {
  return {
    ...testTx,
    value: "0x0",
    data: `0x23b872dd${"0".repeat(24)}${"22".repeat(20)}${"0".repeat(24)}${"11".repeat(20)}${amount.toString(16).padStart(64, "0")}`,
  };
}

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
      expect(info.authorized).toBe(false);
      expect(info.authorizationType).toBe("offchain");
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

    it("should reject non-canonical scope limits", async () => {
      await expect(
        manager.createSessionKey(
          makeScope({ allowedChainIds: [0] }),
          signerAddress,
        ),
      ).rejects.toMatchObject({ code: "session_key_invalid_input" });
      await expect(
        manager.createSessionKey(
          makeScope({ allowedMethods: ["0x1234"] }),
          signerAddress,
        ),
      ).rejects.toMatchObject({ code: "session_key_invalid_input" });
    });

    it("should reject sessions beyond the configured expiry ceiling", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      await expect(
        manager.createSessionKey(
          makeScope({ expiry: nowSec + 31 * 24 * 60 * 60 }),
          signerAddress,
        ),
      ).rejects.toMatchObject({ code: "session_key_invalid_input" });

      const shortLivedManager = createManager({ maxExpiryMs: 5 * 60_000 });
      await expect(
        shortLivedManager.createSessionKey(
          makeScope({ expiry: nowSec + 6 * 60 }),
          signerAddress,
        ),
      ).rejects.toMatchObject({ code: "session_key_invalid_input" });
      await shortLivedManager.clearAll();
    });

    it("should preserve the legacy fallback password when no encryption salt is set", async () => {
      const adapter = new MemoryStorageAdapter();
      const storagePrefix = "legacy-session-prefix";
      const legacyCompatibleManager = new SessionKeyManager(
        {
          storagePrefix,
          encryptionKey: "",
          encryptionSalt: "",
          defaultExpiryMs: 60_000,
          requireAllowedContracts: false,
          pbkdf2Iterations: 10,
          unsafeAllowWeakKdf: true,
        },
        adapter,
      );

      const info = await legacyCompatibleManager.createSessionKey(
        undefined,
        signerAddress,
      );
      const stored = await new SessionKeyStorage(adapter).get(info.id);
      const legacyPassword = bytesToHex(
        // @noble/hashes 2.x takes bytes only. 1.x UTF-8 encoded a string
        // internally, so this is the same digest — which is the point of the
        // test: the legacy password must not move, or records sealed with it
        // stop opening.
        sha256(
          new TextEncoder().encode(
            `${storagePrefix}::session_key_encryption_v1`,
          ),
        ),
      );

      expect(stored).not.toBeNull();
      expect(decryptPrivateKey(stored!.keyPair, legacyPassword, 10)).toMatch(
        /^0x[0-9a-f]+$/i,
      );
      await legacyCompatibleManager.clearAll();
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
      vi.useFakeTimers();
      try {
        const expiredManager = createManager({ defaultExpiryMs: 60_000 });
        const info = await expiredManager.createSessionKey(
          undefined,
          signerAddress,
        );
        vi.advanceTimersByTime(120_000);

        const sessions = await expiredManager.listSessions();
        expect(sessions.find((s) => s.id === info.id)?.status).toBe("expired");
      } finally {
        vi.useRealTimers();
      }
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

      await expect(
        manager.signWithSessionKey(
          info.id,
          ("0x" + "ab".repeat(32)) as `0x${string}`,
          testTx,
        ),
      ).rejects.toThrow();
    });

    it("should observe revocation performed by another manager", async () => {
      const adapter = new MemoryStorageAdapter();
      const first = createManagerWithAdapter(adapter);
      const second = createManagerWithAdapter(adapter);
      const info = await first.createSessionKey(makeScope(), signerAddress);

      await second.revokeSession(info.id);

      await expect(first.getSessionBundle(info.id)).rejects.toThrow("revoked");
      await first.clearAll();
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
        allowedContracts: [
          "0x1111111111111111111111111111111111111111" as `0x${string}`,
        ],
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

    it("should reject increaseAllowance even when explicitly allowed by scope", async () => {
      const increaseAllowanceTx = {
        ...testTx,
        data: ("0x39509351" + "0".repeat(128)) as `0x${string}`,
      };
      const info = await manager.createSessionKey(
        makeScope({ allowedMethods: ["0x39509351"] }),
        signerAddress,
      );
      const result = await manager.checkSessionScope(
        info.id,
        increaseAllowanceTx,
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("forbidden");
    });

    it("should enforce transfer and transferFrom token allowances", async () => {
      const info = await manager.createSessionKey(
        makeScope({
          allowedMethods: ["0xa9059cbb", "0x23b872dd"],
          tokenAllowances: { [tokenAddress]: 100n },
        }),
        signerAddress,
      );

      await expect(
        manager.checkSessionScope(info.id, erc20Transfer(100n)),
      ).resolves.toMatchObject({ valid: true });
      await expect(
        manager.checkSessionScope(info.id, erc20TransferFrom(100n)),
      ).resolves.toMatchObject({ valid: true });
      await expect(
        manager.checkSessionScope(info.id, erc20Transfer(101n)),
      ).resolves.toMatchObject({ valid: false });
    });

    it("should reject unknown or malformed calls to an allowance-scoped token", async () => {
      const info = await manager.createSessionKey(
        makeScope({
          allowedMethods: ["0x12345678", "0xa9059cbb"],
          tokenAllowances: { [tokenAddress]: 100n },
        }),
        signerAddress,
      );

      await expect(
        manager.checkSessionScope(info.id, {
          ...testTx,
          data: `0x12345678${"0".repeat(128)}`,
        }),
      ).resolves.toMatchObject({ valid: false });
      await expect(
        manager.checkSessionScope(info.id, {
          ...testTx,
          data: "0xa9059cbb00",
        }),
      ).resolves.toMatchObject({ valid: false });
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

    it("should require gas when a gas budget is configured", async () => {
      const info = await manager.createSessionKey(
        makeScope({ maxGasPerTx: 100n }),
        signerAddress,
      );
      const result = await manager.checkSessionScope(info.id, testTx);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("gas is required");
    });

    it("should reject malformed numeric transaction fields", async () => {
      const info = await manager.createSessionKey(makeScope(), signerAddress);
      const result = await manager.checkSessionScope(info.id, {
        ...testTx,
        value: "not-a-number",
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("valid integers");
    });

    it("should reject a non-positive transaction chain ID", async () => {
      const info = await manager.createSessionKey(makeScope(), signerAddress);
      const result = await manager.checkSessionScope(info.id, {
        ...testTx,
        chainId: 0,
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("positive safe integer");
    });
  });

  describe("signWithSessionKey", () => {
    it("should produce a valid secp256k1 signature", async () => {
      const info = await manager.createSessionKey(makeScope(), signerAddress);
      const messageHash = ("0x" + "ab".repeat(32)) as `0x${string}`;
      await authorize(manager, info.id);

      const signature = await manager.signWithSessionKey(
        info.id,
        messageHash,
        testTx,
      );
      expect(signature).toMatch(/^0x[a-f0-9]{130}$/i); // 65 bytes (r=32, s=32, v=1)
    });

    it("should reject direct signing before owner authorization", async () => {
      const info = await manager.createSessionKey(makeScope(), signerAddress);

      await expect(
        manager.signWithSessionKey(info.id, `0x${"ab".repeat(32)}`, testTx),
      ).rejects.toMatchObject({ code: "session_key_invalid_input" });
      expect(
        (await manager.listSessions()).find((item) => item.id === info.id)
          ?.useCount,
      ).toBe(0);
    });

    it("should allow explicitly opted-in legacy unauthorized signing", async () => {
      const unsafeManager = createManager({
        unsafeAllowUnauthorizedSigning: true,
      });
      const info = await unsafeManager.createSessionKey(
        makeScope(),
        signerAddress,
      );

      await expect(
        unsafeManager.signWithSessionKey(
          info.id,
          `0x${"ab".repeat(32)}`,
          testTx,
        ),
      ).resolves.toMatch(/^0x[a-f0-9]{130}$/i);
      await unsafeManager.clearAll();
    });

    it("should enforce cumulative token allowance across signatures", async () => {
      const info = await manager.createSessionKey(
        makeScope({
          allowedMethods: ["0xa9059cbb", "0x23b872dd"],
          tokenAllowances: { [tokenAddress]: 100n },
        }),
        signerAddress,
      );
      const messageHash = `0x${"ab".repeat(32)}` as `0x${string}`;
      await authorize(manager, info.id);

      await expect(
        manager.signWithSessionKey(info.id, messageHash, erc20Transfer(60n)),
      ).resolves.toMatch(/^0x[a-f0-9]{130}$/i);
      await expect(
        manager.signWithSessionKey(
          info.id,
          messageHash,
          erc20TransferFrom(41n),
        ),
      ).rejects.toMatchObject({ code: "session_key_scope_exceeded" });
      await expect(
        manager.signWithSessionKey(
          info.id,
          messageHash,
          erc20TransferFrom(40n),
        ),
      ).resolves.toMatch(/^0x[a-f0-9]{130}$/i);
    });

    it("should serialize token allowance consumption across managers", async () => {
      const adapter = new MemoryStorageAdapter();
      const first = createManagerWithAdapter(adapter);
      const second = createManagerWithAdapter(adapter);
      const info = await first.createSessionKey(
        makeScope({ tokenAllowances: { [tokenAddress]: 100n } }),
        signerAddress,
      );
      const messageHash = `0x${"ab".repeat(32)}` as `0x${string}`;
      await authorize(first, info.id);

      const results = await Promise.allSettled([
        first.signWithSessionKey(info.id, messageHash, erc20Transfer(60n)),
        second.signWithSessionKey(info.id, messageHash, erc20Transfer(60n)),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      await first.clearAll();
    });

    it("should withhold a signature when clearAll removes the key during accounting", async () => {
      const adapter = new MemoryStorageAdapter();
      const first = createManagerWithAdapter(adapter);
      const second = createManagerWithAdapter(adapter);
      const info = await first.createSessionKey(makeScope(), signerAddress);
      const messageHash = `0x${"ab".repeat(32)}` as `0x${string}`;
      await authorize(first, info.id);

      const incrementUsageUnlocked =
        SessionKeyStorage.prototype.incrementUsageUnlocked;
      vi.spyOn(
        SessionKeyStorage.prototype,
        "incrementUsageUnlocked",
      ).mockImplementationOnce(async function (
        this: SessionKeyStorage,
        id,
        tx,
        tokenSpend,
      ) {
        await second.clearAll();
        return incrementUsageUnlocked.call(this, id, tx, tokenSpend);
      });

      await expect(
        first.signWithSessionKey(info.id, messageHash, testTx),
      ).rejects.toMatchObject({ code: "session_key_not_found" });
      expect(await first.listSessions()).toEqual([]);
    });

    it("should enforce a transaction budget across managers", async () => {
      const adapter = new MemoryStorageAdapter();
      const first = createManagerWithAdapter(adapter, { defaultMaxTxCount: 1 });
      const second = createManagerWithAdapter(adapter, {
        defaultMaxTxCount: 1,
      });
      const info = await first.createSessionKey(
        makeScope({ maxTxCount: 1 }),
        signerAddress,
      );
      const hash = ("0x" + "ab".repeat(32)) as `0x${string}`;
      await authorize(first, info.id);

      const results = await Promise.allSettled([
        first.signWithSessionKey(info.id, hash, testTx),
        second.signWithSessionKey(info.id, hash, testTx),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      await first.clearAll();
    });

    it("should throw for non-existent session key", async () => {
      await expect(
        manager.signWithSessionKey(
          "nonexistent-id",
          ("0x" + "ab".repeat(32)) as `0x${string}`,
          testTx,
        ),
      ).rejects.toThrow();
    });

    it("should throw for expired session key", async () => {
      vi.useFakeTimers();
      try {
        const expiredManager = createManager({ defaultExpiryMs: 60_000 });
        const info = await expiredManager.createSessionKey(
          undefined,
          signerAddress,
        );
        vi.advanceTimersByTime(120_000);

        await expect(
          expiredManager.signWithSessionKey(
            info.id,
            ("0x" + "ab".repeat(32)) as `0x${string}`,
            testTx,
          ),
        ).rejects.toThrow();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("setAuthorization", () => {
    it("should attach an authorization to an existing key", async () => {
      const info = await manager.createSessionKey(
        { mode: "eip7702" },
        signerAddress,
      );
      await manager.setAuthorization(info.id, {
        signerAddress,
        type: "eip7702",
        authorization: "0xauthorizationdata",
      });

      // Verify by checking the bundle (authorization is included)
      const bundle = await manager.getSessionBundle(info.id);
      expect(bundle.authorization.type).toBe("eip7702");
      expect(bundle.authorization.signerAddress).toBe(signerAddress);
    });

    it("reports an attached off-chain authorization without exposing secrets", async () => {
      const info = await manager.createSessionKey(makeScope(), signerAddress);
      const message = "Naculus Session Policy v1\nSession: test";
      const rawSignature = `0x${"12".repeat(65)}` as `0x${string}`;

      await manager.setAuthorization(info.id, {
        signerAddress,
        type: "offchain",
        rawSignature,
        message,
      });

      const authorized = (await manager.listSessions()).find(
        (session) => session.id === info.id,
      );
      expect(authorized).toMatchObject({
        authorized: true,
        authorizationType: "offchain",
        authorizationMessage: message,
      });
      expect(authorized).not.toHaveProperty("rawSignature");
      expect(authorized).not.toHaveProperty("privateKey");
    });

    it("rejects a malformed off-chain authorization signature", async () => {
      const info = await manager.createSessionKey(makeScope(), signerAddress);
      await expect(
        manager.setAuthorization(info.id, {
          signerAddress,
          type: "offchain",
          rawSignature: "0x1234",
        }),
      ).rejects.toMatchObject({ code: "session_key_invalid_input" });
      expect(
        (await manager.listSessions()).find((item) => item.id === info.id)
          ?.authorized,
      ).toBe(false);
    });

    it("revalidates a persisted authorization against the exact message", async () => {
      const info = await manager.createSessionKey(makeScope(), signerAddress);
      const message = "Naculus Session Policy v1\nSession: test";
      const rawSignature = `0x${"12".repeat(65)}` as `0x${string}`;
      await manager.setAuthorization(info.id, {
        signerAddress,
        type: "offchain",
        rawSignature,
        message,
      });

      const verify = vi.fn().mockResolvedValue(true);
      await expect(
        manager.verifyOffchainAuthorization(info.id, message, verify),
      ).resolves.toBe(true);
      expect(verify).toHaveBeenCalledWith({
        message,
        signature: rawSignature,
        signerAddress,
      });

      await expect(
        manager.verifyOffchainAuthorization(
          info.id,
          `${message} altered`,
          verify,
        ),
      ).resolves.toBe(false);
      expect(verify).toHaveBeenCalledTimes(1);
    });

    it("fails closed when the chain-specific verifier rejects or throws", async () => {
      const info = await manager.createSessionKey(makeScope(), signerAddress);
      const message = "Naculus Session Policy v1\nSession: test";
      await manager.setAuthorization(info.id, {
        signerAddress,
        type: "offchain",
        rawSignature: `0x${"12".repeat(65)}`,
        message,
      });

      await expect(
        manager.verifyOffchainAuthorization(info.id, message, () => false),
      ).resolves.toBe(false);
      await expect(
        manager.verifyOffchainAuthorization(info.id, message, () => {
          throw new Error("invalid signature");
        }),
      ).resolves.toBe(false);
    });

    it("revalidates authorization inside the locked signing operation", async () => {
      const info = await manager.createSessionKey(makeScope(), signerAddress);
      const message = "Naculus Session Policy v1\nSession: test";
      const rawSignature = `0x${"12".repeat(65)}` as `0x${string}`;
      const hash = `0x${"ab".repeat(32)}` as `0x${string}`;
      await manager.setAuthorization(info.id, {
        signerAddress,
        type: "offchain",
        rawSignature,
        message,
      });

      const verify = vi.fn().mockResolvedValue(true);
      await expect(
        manager.signWithVerifiedOffchainAuthorization(
          info.id,
          () => message,
          verify,
          hash,
          testTx,
        ),
      ).resolves.toMatch(/^0x[a-f0-9]{130}$/i);
      expect(verify).toHaveBeenCalledOnce();
      expect(
        (await manager.listSessions()).find((item) => item.id === info.id)
          ?.useCount,
      ).toBe(1);
    });

    it("does not sign or consume budget when locked authorization verification fails", async () => {
      const info = await manager.createSessionKey(makeScope(), signerAddress);
      const message = "Naculus Session Policy v1\nSession: test";
      await manager.setAuthorization(info.id, {
        signerAddress,
        type: "offchain",
        rawSignature: `0x${"12".repeat(65)}`,
        message,
      });

      await expect(
        manager.signWithVerifiedOffchainAuthorization(
          info.id,
          () => `${message} altered`,
          () => true,
          `0x${"ab".repeat(32)}` as `0x${string}`,
          testTx,
        ),
      ).rejects.toMatchObject({ code: "session_key_invalid_input" });
      expect(
        (await manager.listSessions()).find((item) => item.id === info.id)
          ?.useCount,
      ).toBe(0);
    });
  });

  describe("session lifecycle", () => {
    it("should create, verify scope, sign, and track usage", async () => {
      // Create
      const info = await manager.createSessionKey(makeScope(), signerAddress);
      expect(info.useCount).toBe(0);
      await authorize(manager, info.id);

      // Check scope
      const scopeCheck = await manager.checkSessionScope(info.id, testTx);
      expect(scopeCheck.valid).toBe(true);

      // Sign
      const hash = ("0x" + "cd".repeat(32)) as `0x${string}`;
      const sig = await manager.signWithSessionKey(info.id, hash, testTx);
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

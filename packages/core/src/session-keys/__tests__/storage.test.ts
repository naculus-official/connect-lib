import { describe, it, expect } from "vitest";
import { encryptPrivateKey, decryptPrivateKey, SessionKeyStorage } from "../storage";
import { MemoryStorageAdapter } from "../../storage";

// Use minimal PBKDF2 iterations for fast tests (default is 600_000)
const TEST_ITERATIONS = 10;

describe("encryptPrivateKey / decryptPrivateKey", () => {
  const password = "test-encryption-password-123";
  const privateKey = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const;

  it("should encrypt and decrypt a private key correctly", () => {
    const encrypted = encryptPrivateKey(privateKey, password, undefined, TEST_ITERATIONS);
    expect(encrypted.encryptedPrivateKey).toBeTruthy();
    expect(encrypted.iv).toBeTruthy();
    expect(encrypted.salt).toBeTruthy();
    expect(typeof encrypted.encryptedPrivateKey).toBe("string");
    expect(encrypted.encryptedPrivateKey.length).toBeGreaterThan(0);
    const decrypted = decryptPrivateKey(encrypted, password, TEST_ITERATIONS);
    expect(decrypted).toBe(privateKey);
  });

  it("should produce different ciphertexts for the same key (different IV)", () => {
    const e1 = encryptPrivateKey(privateKey, password, undefined, TEST_ITERATIONS);
    const e2 = encryptPrivateKey(privateKey, password, undefined, TEST_ITERATIONS);
    expect(e1.iv).not.toBe(e2.iv);
    expect(e1.encryptedPrivateKey).not.toBe(e2.encryptedPrivateKey);
  });

  it("should throw on wrong password", () => {
    const encrypted = encryptPrivateKey(privateKey, password, undefined, TEST_ITERATIONS);
    expect(() => decryptPrivateKey(encrypted, "wrong-password", TEST_ITERATIONS)).toThrow();
  });

  it("should handle different key sizes", () => {
    const shortKey = "0xdeadbeef" as `0x${string}`;
    const encrypted = encryptPrivateKey(shortKey, password, undefined, TEST_ITERATIONS);
    const decrypted = decryptPrivateKey(encrypted, password, TEST_ITERATIONS);
    expect(decrypted).toBe(shortKey);
  });

  it("should accept a fixed salt for deterministic encryption", () => {
    const salt = new Uint8Array(16).fill(42);
    const e1 = encryptPrivateKey(privateKey, password, salt, TEST_ITERATIONS);
    const e2 = encryptPrivateKey(privateKey, password, salt, TEST_ITERATIONS);
    expect(e1.salt).toBe(e2.salt);
  });

  it("should fail when salt is tampered with", () => {
    const encrypted = encryptPrivateKey(privateKey, password, undefined, TEST_ITERATIONS);
    const tampered = { ...encrypted, salt: "deadbeef" + encrypted.salt.slice(8) };
    expect(() => decryptPrivateKey(tampered, password, TEST_ITERATIONS)).toThrow();
  });

  it("should fail when iv is tampered with", () => {
    const encrypted = encryptPrivateKey(privateKey, password, undefined, TEST_ITERATIONS);
    const tampered = { ...encrypted, iv: "deadbeef" + encrypted.iv.slice(8) };
    expect(() => decryptPrivateKey(tampered, password, TEST_ITERATIONS)).toThrow();
  });
});

describe("SessionKeyStorage", () => {
  it("should be available with MemoryStorageAdapter", () => {
    const storage = new SessionKeyStorage(new MemoryStorageAdapter());
    expect(storage.isAvailable()).toBe(true);
  });

  it("should save and load session keys", async () => {
    const storage = new SessionKeyStorage(new MemoryStorageAdapter());
    const key = createTestKey("test-1");
    await storage.save(key);
    const keys = await storage.loadAll();
    expect(keys).toHaveLength(1);
    expect(keys[0].id).toBe("test-1");
  });

  it("should update existing key on save", async () => {
    const storage = new SessionKeyStorage(new MemoryStorageAdapter());
    const key = createTestKey("test-1", "active");
    await storage.save(key);
    const updated = { ...key, status: "revoked" as const };
    await storage.save(updated);
    const keys = await storage.loadAll();
    expect(keys).toHaveLength(1);
    expect(keys[0].status).toBe("revoked");
  });

  it("should remove a key", async () => {
    const storage = new SessionKeyStorage(new MemoryStorageAdapter());
    await storage.save(createTestKey("k1"));
    await storage.save(createTestKey("k2"));
    await storage.remove("k1");
    const keys = await storage.loadAll();
    expect(keys).toHaveLength(1);
    expect(keys[0].id).toBe("k2");
  });

  it("should update status", async () => {
    const storage = new SessionKeyStorage(new MemoryStorageAdapter());
    await storage.save(createTestKey("k1"));
    await storage.updateStatus("k1", "revoked");
    const keys = await storage.loadAll();
    expect(keys[0].status).toBe("revoked");
  });

  it("should throw on updateStatus for non-existent key", async () => {
    const storage = new SessionKeyStorage(new MemoryStorageAdapter());
    await expect(storage.updateStatus("nonexistent", "revoked")).rejects.toThrow();
  });

  it("should increment usage count", async () => {
    const storage = new SessionKeyStorage(new MemoryStorageAdapter());
    await storage.save(createTestKey("k1"));
    await storage.incrementUsage("k1");
    const keys = await storage.loadAll();
    expect(keys[0].useCount).toBe(1);
    await storage.incrementUsage("k1");
    const keys2 = await storage.loadAll();
    expect(keys2[0].useCount).toBe(2);
  });

  it("should clear all keys", async () => {
    const storage = new SessionKeyStorage(new MemoryStorageAdapter());
    await storage.save(createTestKey("k1"));
    await storage.save(createTestKey("k2"));
    await storage.clear();
    const keys = await storage.loadAll();
    expect(keys).toHaveLength(0);
  });

  it("should handle empty storage", async () => {
    const storage = new SessionKeyStorage(new MemoryStorageAdapter());
    const keys = await storage.loadAll();
    expect(keys).toEqual([]);
  });

  it("should return null for non-existent get", async () => {
    const storage = new SessionKeyStorage(new MemoryStorageAdapter());
    const key = await storage.get("nonexistent");
    expect(key).toBeNull();
  });
});

// ─── Test Helpers ──────────────────────────────────────────────────────

function createTestKey(id: string, status: "active" | "revoked" | "expired" = "active") {
  const now = Date.now();
  return {
    id,
    keyPair: {
      publicKey: ("0x" + "a".repeat(66)) as `0x${string}`,
      encryptedPrivateKey: "deadbeef",
      iv: "cafebabe",
      salt: "11111111",
    },
    scope: {
      expiry: Math.floor(now / 1000) + 3600,
      mode: "offchain" as const,
      maxTxCount: 10,
      maxTotalValue: BigInt("100000000000000000"),
    },
    authorization: {
      signerAddress: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18" as `0x${string}`,
      type: "offchain" as const,
    },
    status,
    createdAt: now,
    lastUsedAt: now,
    useCount: 0,
  };
}

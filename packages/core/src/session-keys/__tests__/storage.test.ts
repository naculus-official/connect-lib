import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, it, expect } from "vitest";
import { SessionKeyManager } from "../SessionKeyManager";
import {
  encryptPrivateKey,
  decryptPrivateKey,
  SessionKeyStorage,
} from "../storage";
import { MemoryStorageAdapter } from "../../storage";

// Use minimal PBKDF2 iterations for fast tests (default is 600_000)
const TEST_ITERATIONS = 10;
// Explicit opt-in required by the enforced PBKDF2 floor in ../storage.
const WEAK_KDF = { unsafeAllowWeakKdf: true };

describe("PBKDF2 work factor floor", () => {
  const password = "test-encryption-password-123";
  const privateKey =
    "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const;

  it("rejects a work factor below the OWASP floor", () => {
    expect(() =>
      encryptPrivateKey(privateKey, password, undefined, 10),
    ).toThrow(/at least 600000/);
  });

  it("still requires the opt-in when the caller is a hair under the floor", () => {
    expect(() =>
      encryptPrivateKey(privateKey, password, undefined, 599_999),
    ).toThrow(/at least 600000/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 600_000.5, -1, 0])(
    "rejects a non-integer or out-of-range work factor (%s)",
    (bad) => {
      // NaN is the interesting one: `NaN < MIN` is false, so a bare comparison
      // would have let it through to the KDF.
      expect(() =>
        encryptPrivateKey(privateKey, password, undefined, bad as number),
      ).toThrow(/at least 600000/);
    },
  );

  it("accepts a weak factor only behind the explicit unsafe opt-in", () => {
    expect(() =>
      encryptPrivateKey(
        privateKey,
        password,
        undefined,
        10,
        undefined,
        WEAK_KDF,
      ),
    ).not.toThrow();
  });

  it("leaves decryption unrestricted so weak legacy records stay migratable", () => {
    const encrypted = encryptPrivateKey(
      privateKey,
      password,
      undefined,
      10,
      undefined,
      WEAK_KDF,
    );
    expect(decryptPrivateKey(encrypted, password, 10)).toBe(privateKey);
  });
});

describe("encryptPrivateKey / decryptPrivateKey", () => {
  const password = "test-encryption-password-123";
  const privateKey =
    "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const;

  it("should encrypt and decrypt a private key correctly", () => {
    const encrypted = encryptPrivateKey(
      privateKey,
      password,
      undefined,
      TEST_ITERATIONS,
      undefined,
      WEAK_KDF,
    );
    expect(encrypted.encryptedPrivateKey).toBeTruthy();
    expect(encrypted.iv).toBeTruthy();
    expect(encrypted.salt).toBeTruthy();
    expect(typeof encrypted.encryptedPrivateKey).toBe("string");
    expect(encrypted.encryptedPrivateKey.length).toBeGreaterThan(0);
    const decrypted = decryptPrivateKey(encrypted, password, TEST_ITERATIONS);
    expect(decrypted).toBe(privateKey);
  });

  it("should produce different ciphertexts for the same key (different IV)", () => {
    const e1 = encryptPrivateKey(
      privateKey,
      password,
      undefined,
      TEST_ITERATIONS,
      undefined,
      WEAK_KDF,
    );
    const e2 = encryptPrivateKey(
      privateKey,
      password,
      undefined,
      TEST_ITERATIONS,
      undefined,
      WEAK_KDF,
    );
    expect(e1.iv).not.toBe(e2.iv);
    expect(e1.encryptedPrivateKey).not.toBe(e2.encryptedPrivateKey);
  });

  it("should throw on wrong password", () => {
    const encrypted = encryptPrivateKey(
      privateKey,
      password,
      undefined,
      TEST_ITERATIONS,
      undefined,
      WEAK_KDF,
    );
    expect(() =>
      decryptPrivateKey(encrypted, "wrong-password", TEST_ITERATIONS),
    ).toThrow();
  });

  it("should handle different key sizes", () => {
    const shortKey = "0xdeadbeef" as `0x${string}`;
    // A 4-byte value has no secp256k1 public key, so the caller must supply
    // the public field (as the Solana and voucher managers do).
    const encrypted = encryptPrivateKey(
      shortKey,
      password,
      undefined,
      TEST_ITERATIONS,
      "0xc0ffee",
      WEAK_KDF,
    );
    const decrypted = decryptPrivateKey(encrypted, password, TEST_ITERATIONS);
    expect(decrypted).toBe(shortKey);
  });

  it("should accept a fixed salt for deterministic encryption", () => {
    const salt = new Uint8Array(16).fill(42);
    const e1 = encryptPrivateKey(
      privateKey,
      password,
      salt,
      TEST_ITERATIONS,
      undefined,
      WEAK_KDF,
    );
    const e2 = encryptPrivateKey(
      privateKey,
      password,
      salt,
      TEST_ITERATIONS,
      undefined,
      WEAK_KDF,
    );
    expect(e1.salt).toBe(e2.salt);
  });

  it("should fail when salt is tampered with", () => {
    const encrypted = encryptPrivateKey(
      privateKey,
      password,
      undefined,
      TEST_ITERATIONS,
      undefined,
      WEAK_KDF,
    );
    const tampered = {
      ...encrypted,
      salt: "deadbeef" + encrypted.salt.slice(8),
    };
    expect(() =>
      decryptPrivateKey(tampered, password, TEST_ITERATIONS),
    ).toThrow();
  });

  it("should fail when iv is tampered with", () => {
    const encrypted = encryptPrivateKey(
      privateKey,
      password,
      undefined,
      TEST_ITERATIONS,
      undefined,
      WEAK_KDF,
    );
    const tampered = { ...encrypted, iv: "deadbeef" + encrypted.iv.slice(8) };
    expect(() =>
      decryptPrivateKey(tampered, password, TEST_ITERATIONS),
    ).toThrow();
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
    await expect(
      storage.updateStatus("nonexistent", "revoked"),
    ).rejects.toThrow();
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

  it("should serialize concurrent usage updates", async () => {
    const storage = new SessionKeyStorage(new MemoryStorageAdapter());
    await storage.save(createTestKey("concurrent"));

    await Promise.all(
      Array.from({ length: 10 }, () => storage.incrementUsage("concurrent")),
    );

    const keys = await storage.loadAll();
    expect(keys[0].useCount).toBe(10);
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

function createTestKey(
  id: string,
  status: "active" | "revoked" | "expired" = "active",
) {
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
      rails: ["transfer" as const],
      expiry: Math.floor(now / 1000) + 3600,
      mode: "offchain" as const,
      maxTxCount: 10,
      maxTotalValue: BigInt("100000000000000000"),
    },
    authorization: {
      signerAddress:
        "0x742D35CC6634C0532925a3B844Bc9E7595F2bD18" as `0x${string}`,
      type: "offchain" as const,
    },
    status,
    createdAt: now,
    lastUsedAt: now,
    useCount: 0,
  };
}

describe("kdfIterations persisted per record", () => {
  it("decrypts with the record's own work factor after the configured one changes", async () => {
    const { decryptPrivateKey, encryptPrivateKey } = await import("../storage");
    const pk = `0x${"11".repeat(32)}` as const;
    const sealed = encryptPrivateKey(pk, "pw", undefined, 1_000, undefined, {
      unsafeAllowWeakKdf: true,
    });
    expect(sealed.kdfIterations).toBe(1_000);
    // Caller now configured 2_000: the record still opens.
    expect(decryptPrivateKey(sealed, "pw", 2_000)).toBe(pk);
    // A legacy record without the field uses the caller's value.
    const { kdfIterations: _omit, ...legacy } = sealed;
    expect(decryptPrivateKey(legacy, "pw", 1_000)).toBe(pk);
    expect(() => decryptPrivateKey(legacy, "pw", 2_000)).toThrow();
  });
});

// Fingerprint: core/session-keys/encryptPrivateKey/default-publicKey-plaintext-secret
describe("encryptPrivateKey never returns the private key as the public key", () => {
  const password = "public-validation-password";
  const privateKey =
    "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const;
  const derivedPublicKey = `0x${bytesToHex(
    secp256k1.getPublicKey(hexToBytes(privateKey.slice(2))),
  )}` as const;

  it("does not return the private key in the public field by default", () => {
    const encrypted = encryptPrivateKey(
      privateKey,
      password,
      undefined,
      TEST_ITERATIONS,
      undefined,
      WEAK_KDF,
    );

    expect(encrypted.publicKey).not.toBe(privateKey);
  });

  it("does not serialize the private key without decryption", () => {
    const encrypted = encryptPrivateKey(
      privateKey,
      password,
      undefined,
      TEST_ITERATIONS,
      undefined,
      WEAK_KDF,
    );

    expect(JSON.stringify(encrypted)).not.toContain(privateKey.slice(2));
  });

  it("derives the secp256k1 public key when none is supplied, and still decrypts", () => {
    const encrypted = encryptPrivateKey(
      privateKey,
      password,
      undefined,
      TEST_ITERATIONS,
      undefined,
      WEAK_KDF,
    );

    expect(encrypted.publicKey).toBe(derivedPublicKey);
    expect(decryptPrivateKey(encrypted, password)).toBe(privateKey);
  });

  it("fails closed instead of echoing a value that has no public key", () => {
    for (const bad of [`0x${"00".repeat(32)}`, "0xdeadbeef"] as const) {
      expect(() =>
        encryptPrivateKey(
          bad as `0x${string}`,
          password,
          undefined,
          TEST_ITERATIONS,
          undefined,
          WEAK_KDF,
        ),
      ).toThrow(/cannot derive a public key/);
    }
  });

  it("keeps a supplied public key unchanged", () => {
    const encrypted = encryptPrivateKey(
      privateKey,
      password,
      undefined,
      TEST_ITERATIONS,
      derivedPublicKey,
      WEAK_KDF,
    );

    expect(encrypted.publicKey).toBe(derivedPublicKey);
    expect(JSON.stringify(encrypted)).not.toContain(privateKey.slice(2));
  });

  it("uses a derived public key in built-in manager storage", async () => {
    const adapter = new MemoryStorageAdapter();
    const manager = new SessionKeyManager(
      {
        encryptionKey: password,
        pbkdf2Iterations: TEST_ITERATIONS,
        unsafeAllowWeakKdf: true,
        requireAllowedContracts: false,
      },
      adapter,
    );
    const info = await manager.createSessionKey(
      { mode: "offchain", rails: ["transfer"] },
      "0x742D35CC6634C0532925a3B844Bc9E7595F2bD18",
    );
    const stored = await new SessionKeyStorage(adapter).get(info.id);
    if (!stored) throw new Error("Expected the manager to persist its key");
    const decryptedPrivateKey = decryptPrivateKey(stored.keyPair, password);

    expect(stored.keyPair.publicKey).toBe(info.publicKey);
    expect(stored.keyPair.publicKey).not.toBe(decryptedPrivateKey);
    expect(JSON.stringify(stored.keyPair)).not.toContain(
      decryptedPrivateKey.slice(2),
    );
  });
});

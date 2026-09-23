import { describe, expect, it, vi } from "vitest";
import {
  decryptSessionKey,
  encryptSessionKey,
  generateSessionKeyPair,
  signTransactionWithSessionKey,
  signWithSessionKey,
} from "../crypto";
import type { SessionKeyPair } from "../types";

describe("session-keys / crypto", () => {
  describe("generateSessionKeyPair", () => {
    it("should generate a valid secp256k1 key pair", async () => {
      const pair = await generateSessionKeyPair();

      expect(pair.publicKey).toMatch(/^0x[0-9a-f]{66}$/); // compressed: 0x + 66 hex
      expect(pair.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("should generate different keys on each call", async () => {
      const [a, b] = await Promise.all([
        generateSessionKeyPair(),
        generateSessionKeyPair(),
      ]);

      expect(a.privateKey).not.toBe(b.privateKey);
      expect(a.publicKey).not.toBe(b.publicKey);
    });
  });

  describe("signWithSessionKey", () => {
    it("should produce a valid ECDSA signature", async () => {
      const pair = await generateSessionKeyPair();
      const data = new TextEncoder().encode("hello world");

      const result = await signWithSessionKey(pair.privateKey, data);

      expect(result.signature).toMatch(/^0x[0-9a-f]{129,131}$/); // r(64) + s(64) + v(1~2 hex chars)
      expect(result.r).toMatch(/^[0-9a-f]{64}$/);
      expect(result.s).toMatch(/^[0-9a-f]{64}$/);
      expect(result.v).toBeGreaterThanOrEqual(0);
      expect(result.v).toBeLessThanOrEqual(1);
    });

    it("should produce deterministic-like signatures (different hash → different sig)", async () => {
      const pair = await generateSessionKeyPair();

      const sig1 = await signWithSessionKey(
        pair.privateKey,
        new TextEncoder().encode("msg1"),
      );
      const sig2 = await signWithSessionKey(
        pair.privateKey,
        new TextEncoder().encode("msg2"),
      );

      expect(sig1.signature).not.toBe(sig2.signature);
    });
  });

  describe("encryptSessionKey / decryptSessionKey", () => {
    vi.setConfig({ testTimeout: 120000 });
    const testSeed = new Uint8Array(32).fill(0xab);

    it("should encrypt and decrypt successfully", async () => {
      const original = await generateSessionKeyPair();

      const encrypted = await encryptSessionKey(original, testSeed);
      expect(encrypted.publicKey).toBe(original.publicKey);
      expect(encrypted.encryptedPrivateKey).toMatch(/^[0-9a-f]+$/);
      expect(encrypted.iv).toMatch(/^[0-9a-f]+$/);
      expect(encrypted.salt).toMatch(/^[0-9a-f]+$/);

      const decrypted = await decryptSessionKey(encrypted, testSeed);
      expect(decrypted.privateKey).toBe(original.privateKey);
      expect(decrypted.publicKey).toBe(original.publicKey);
    });

    it("should fail to decrypt with a different seed", async () => {
      const original = await generateSessionKeyPair();
      const encrypted = await encryptSessionKey(original, testSeed);

      const wrongSeed = new Uint8Array(32).fill(0xcd);
      await expect(decryptSessionKey(encrypted, wrongSeed)).rejects.toThrow();
    });

    it("should produce different ciphertexts for the same key (different nonce)", async () => {
      const original = await generateSessionKeyPair();

      const enc1 = await encryptSessionKey(original, testSeed);
      const enc2 = await encryptSessionKey(original, testSeed);

      expect(enc1.encryptedPrivateKey).not.toBe(enc2.encryptedPrivateKey);
      expect(enc1.iv).not.toBe(enc2.iv);
    });
  });

  describe("signTransactionWithSessionKey", () => {
    const PK = `0x${"ab".repeat(32)}` as `0x${string}`;
    const TX = {
      to: "0x1111111111111111111111111111111111111111",
      chainId: 1,
      maxFeePerGas: "0x1",
    };
    const AUTH = {
      chainId: 1,
      address: "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B",
      nonce: "0x0",
      yParity: 1,
      r: `0x${"11".repeat(32)}`,
      s: `0x${"22".repeat(32)}`,
    };

    it("refuses a type-4 transaction or any authorizationList", async () => {
      for (const tx of [
        { ...TX, type: "eip7702", authorizationList: [AUTH] },
        { ...TX, authorizationList: [AUTH] },
        { ...TX, type: "eip7702" },
      ]) {
        await expect(
          signTransactionWithSessionKey(PK, tx as typeof TX),
        ).rejects.toMatchObject({ code: "session_scope_exceeded" });
      }
    });

    it("still signs an ordinary type-2 transaction", async () => {
      await expect(signTransactionWithSessionKey(PK, TX)).resolves.toMatch(
        /^0x02/,
      );
    });
  });
});

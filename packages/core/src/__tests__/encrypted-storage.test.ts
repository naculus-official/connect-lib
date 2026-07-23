import { describe, it, expect } from "vitest";
import { WebCryptoEncryptedStorageAdapter } from "../storage/encrypted-storage";

describe("WebCryptoEncryptedStorageAdapter", () => {
  const adapter = new WebCryptoEncryptedStorageAdapter();
  const testKey = new Uint8Array(32).fill(0x42);
  const testValue = "Hello, Secure World!";

  it("isAvailable returns true when Web Crypto is present", () => {
    expect(adapter.isAvailable()).toBe(true);
  });

  it("encrypt/decrypt roundtrip works correctly", async () => {
    const encrypted = await adapter.encrypt(testValue, testKey);
    expect(encrypted).toBeTruthy();
    expect(typeof encrypted).toBe("string");

    const decrypted = await adapter.decrypt(encrypted, testKey);
    expect(decrypted).toBe(testValue);
  });

  it("produces different ciphertext for same plaintext (random salt+IV)", async () => {
    const enc1 = await adapter.encrypt(testValue, testKey);
    const enc2 = await adapter.encrypt(testValue, testKey);
    expect(enc1).not.toBe(enc2);
  });

  it("fails to decrypt with a different key", async () => {
    const encrypted = await adapter.encrypt(testValue, testKey);
    const wrongKey = new Uint8Array(32).fill(0x99);
    await expect(adapter.decrypt(encrypted, wrongKey)).rejects.toThrow(/Decryption failed/);
  });

  it("fails to decrypt corrupted data", async () => {
    const encrypted = await adapter.encrypt(testValue, testKey);
    const corrupted = encrypted.replace(/[0-9a-f]/g, "0");
    await expect(adapter.decrypt(corrupted, testKey)).rejects.toThrow();
  });

  it("rejects empty key", async () => {
    const emptyKey = new Uint8Array(0);
    await expect(adapter.encrypt("test", emptyKey)).rejects.toThrow("must not be empty");
  });

  it("handles empty string", async () => {
    const encrypted = await adapter.encrypt("", testKey);
    const decrypted = await adapter.decrypt(encrypted, testKey);
    expect(decrypted).toBe("");
  });

  it("handles special characters and Unicode", async () => {
    const value = "hello world 🌍 \n\t\r\0\\\"'";
    const encrypted = await adapter.encrypt(value, testKey);
    const decrypted = await adapter.decrypt(encrypted, testKey);
    expect(decrypted).toBe(value);
  });

  it("handles large payload (10KB)", async () => {
    const value = "x".repeat(10_240);
    const encrypted = await adapter.encrypt(value, testKey);
    const decrypted = await adapter.decrypt(encrypted, testKey);
    expect(decrypted).toBe(value);
  });

  it("rejects invalid JSON payload", async () => {
    await expect(adapter.decrypt("not-json", testKey)).rejects.toThrow("not valid JSON");
  });

  it("rejects payload with missing fields", async () => {
    await expect(adapter.decrypt('{"salt":"00"}', testKey)).rejects.toThrow("missing salt, iv, or ciphertext");
  });
});

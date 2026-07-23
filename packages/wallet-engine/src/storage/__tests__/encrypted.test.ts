import { describe, it, expect, vi, beforeAll } from "vitest";
import { EncryptedStorageAdapter } from "../encrypted";
import { IndexedDbStorageAdapter } from "../indexed-db";
import type { StorageAdapter, WalletData } from "../../wallet";

const PASSPHRASE = "correct-horse-battery-stable-2026";

const mockData: WalletData = {
  mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  privateKey: "0x" + "ef".repeat(32),
  address: "0x" + "12".repeat(20),
  createdAt: Date.now(),
};

class MockStorage implements StorageAdapter {
  private d: any = null;
  isAvailable() { return true; }
  async load() { return this.d; }
  async save(data: any) { this.d = data; }
  async clear() { this.d = null; }
}

describe("EncryptedStorageAdapter", () => {
  beforeAll(async () => {
    vi.stubGlobal("crypto", crypto);
    const { indexedDB } = await import("fake-indexeddb");
    vi.stubGlobal("indexedDB", indexedDB);
  });

  it("isAvailable returns true when Web Crypto is available", () => {
    const inner = new MockStorage();
    const adapter = new EncryptedStorageAdapter(inner, () => Promise.resolve(PASSPHRASE));
    expect(adapter.isAvailable()).toBe(true);
  });

  it("encrypts data with AES-256-GCM (raw storage is not plaintext)", async () => {
    const inner = new MockStorage();
    const adapter = new EncryptedStorageAdapter(inner, () => Promise.resolve(PASSPHRASE));
    await adapter.save(mockData);
    const raw = await inner.load();
    expect(raw).not.toEqual(mockData);
    expect((raw as any)._encrypted).toBeDefined();
    expect((raw as any)._encrypted.ciphertext).toBeDefined();
  });

  it("round-trips data correctly", async () => {
    const inner = new MockStorage();
    const adapter = new EncryptedStorageAdapter(inner, () => Promise.resolve(PASSPHRASE));
    await adapter.save(mockData);
    const loaded = await adapter.load();
    expect(loaded).toEqual(mockData);
  });

  it("rejects wrong passphrase on load", async () => {
    const inner = new MockStorage();
    const adapter = new EncryptedStorageAdapter(inner, () => Promise.resolve("correct-passphrase"));
    await adapter.save(mockData);
    const wrong = new EncryptedStorageAdapter(inner, () => Promise.resolve("wrong-passphrase"));
    await expect(wrong.load()).rejects.toThrow("Invalid passphrase");
  });

  it("round-trips with IndexedDbStorageAdapter underneath", async () => {
    const key = "test_encrypted_idb_" + Date.now();
    const inner = new IndexedDbStorageAdapter(key);
    const adapter = new EncryptedStorageAdapter(inner, () => Promise.resolve(PASSPHRASE));
    await adapter.save(mockData);
    const loaded = await adapter.load();
    expect(loaded).toEqual(mockData);
  });

  it("clears underlying storage", async () => {
    const inner = new MockStorage();
    const adapter = new EncryptedStorageAdapter(inner, () => Promise.resolve(PASSPHRASE));
    await adapter.save(mockData);
    await adapter.clear();
    expect(await inner.load()).toBeNull();
  });
});

import { describe, it, expect, vi, beforeAll } from "vitest";
import { IndexedDbStorageAdapter } from "../indexed-db";
import type { WalletData } from "../../wallet";

const mockData: WalletData = {
  mnemonic: "test test test test test test test test test test test test",
  privateKey: "0x" + "ab".repeat(32),
  address: "0x" + "cd".repeat(20),
  createdAt: Date.now(),
};

beforeAll(async () => {
  const { indexedDB } = await import("fake-indexeddb");
  vi.stubGlobal("indexedDB", indexedDB);
});

describe("IndexedDbStorageAdapter", () => {
  it("isAvailable returns true after polyfill", () => {
    const adapter = new IndexedDbStorageAdapter("test_wallet");
    expect(adapter.isAvailable()).toBe(true);
  });

  it("saves and loads wallet data", async () => {
    const adapter = new IndexedDbStorageAdapter("test_wallet_" + Date.now());
    await adapter.save(mockData);
    const loaded = await adapter.load();
    expect(loaded).toEqual(mockData);
  });

  it("clears stored data", async () => {
    const key = "test_clear_" + Date.now();
    const adapter = new IndexedDbStorageAdapter(key);
    await adapter.save(mockData);
    await adapter.clear();
    const loaded = await adapter.load();
    expect(loaded).toBeNull();
  });

  it("returns null when no data stored", async () => {
    const adapter = new IndexedDbStorageAdapter("test_nonexistent_" + Date.now());
    const loaded = await adapter.load();
    expect(loaded).toBeNull();
  });

  it("handles multiple storage keys independently", async () => {
    const key1 = "test_multi_1_" + Date.now();
    const key2 = "test_multi_2_" + Date.now();
    const a1 = new IndexedDbStorageAdapter(key1);
    const a2 = new IndexedDbStorageAdapter(key2);
    const d1: WalletData = { ...mockData, address: "0xaa".repeat(20) };
    const d2: WalletData = { ...mockData, address: "0xbb".repeat(20) };
    await a1.save(d1);
    await a2.save(d2);
    expect(await a1.load()).toEqual(d1);
    expect(await a2.load()).toEqual(d2);
  });
});

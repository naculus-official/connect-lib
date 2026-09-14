import { beforeAll, describe, expect, it, vi } from "vitest";
import type { WalletAccount, WalletData } from "../../wallet";
import { IndexedDbStorageAdapter } from "../indexed-db";

// Version 2 holds an account list; `address` and `privateKey` are read-only
// views over it, so a fixture that sets them directly is not a WalletData and
// two fixtures that differ only in `address` are the same wallet twice.
const evmAccount = (address: string): WalletAccount => ({
  namespace: "eip155",
  address,
  privateKey: "0x" + "ab".repeat(32),
});

const mockData: WalletData = {
  mnemonic: "test test test test test test test test test test test test",
  accounts: [evmAccount("0x" + "cd".repeat(20))],
  activeNamespace: "eip155",
  createdAt: Date.now(),
  version: 2,
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

  it("repairs an empty v1 database created before the wallet engine", async () => {
    const { IDBFactory } = await import("fake-indexeddb");
    const isolatedIndexedDb = new IDBFactory();
    vi.stubGlobal("indexedDB", isolatedIndexedDb);
    await new Promise<void>((resolve, reject) => {
      const request = isolatedIndexedDb.open("naculus_wallet", 1);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });

    const adapter = new IndexedDbStorageAdapter("repaired_wallet");
    await expect(adapter.save(mockData)).resolves.toBeUndefined();
    await expect(adapter.load()).resolves.toEqual(mockData);
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
    const adapter = new IndexedDbStorageAdapter(
      "test_nonexistent_" + Date.now(),
    );
    const loaded = await adapter.load();
    expect(loaded).toBeNull();
  });

  it("handles multiple storage keys independently", async () => {
    const key1 = "test_multi_1_" + Date.now();
    const key2 = "test_multi_2_" + Date.now();
    const a1 = new IndexedDbStorageAdapter(key1);
    const a2 = new IndexedDbStorageAdapter(key2);
    const d1: WalletData = {
      ...mockData,
      accounts: [evmAccount("0x" + "aa".repeat(20))],
    };
    const d2: WalletData = {
      ...mockData,
      accounts: [evmAccount("0x" + "bb".repeat(20))],
    };
    await a1.save(d1);
    await a2.save(d2);
    expect(await a1.load()).toEqual(d1);
    expect(await a2.load()).toEqual(d2);
  });
});

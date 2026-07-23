import { describe, it, expect, beforeEach } from "vitest";
import { TxHistoryStore, MemoryHistoryStorage } from "../TxHistoryStore";
import type { TxStatusEntry } from "../types";

function makeEntry(overrides: Partial<TxStatusEntry> = {}): TxStatusEntry {
  const now = Date.now();
  return {
    hash: "0x" + "a".repeat(64),
    chainId: 1,
    from: "0x" + "b".repeat(40),
    to: "0x" + "c".repeat(40),
    value: "0xde0b6b3a7640000",
    status: "pending",
    createdAt: now,
    updatedAt: now,
    replacementCount: 0,
    ...overrides,
  };
}

describe("TxHistoryStore", () => {
  let store: TxHistoryStore;

  beforeEach(() => {
    store = new TxHistoryStore(new MemoryHistoryStorage());
  });

  it("stores and retrieves a single entry by hash", async () => {
    const entry = makeEntry();
    await store.upsert(entry);
    const retrieved = await store.get(entry.hash, entry.chainId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.hash).toBe(entry.hash);
    expect(retrieved!.from).toBe(entry.from);
  });

  it("updates existing entry on upsert", async () => {
    const entry = makeEntry({ status: "pending" });
    await store.upsert(entry);

    const updated = { ...entry, status: "confirmed" as const, confirmedAt: Date.now() };
    await store.upsert(updated);

    const retrieved = await store.get(entry.hash, entry.chainId);
    expect(retrieved!.status).toBe("confirmed");
    expect(retrieved!.confirmedAt).toBeDefined();
  });

  it("queries by address (from)", async () => {
    const entry = makeEntry({ from: "0xaaaabbbbccccddddeeeeffff0000111122223333" });
    await store.upsert(entry);

    const results = await store.query({ address: entry.from });
    expect(results.length).toBe(1);
    expect(results[0].hash).toBe(entry.hash);
  });

  it("queries by chainId", async () => {
    const entry1 = makeEntry({ hash: "0x" + "a".repeat(64), chainId: 1 });
    const entry2 = makeEntry({ hash: "0x" + "b".repeat(64), chainId: 137 });
    await store.upsert(entry1);
    await store.upsert(entry2);

    const results = await store.query({ chainId: 137 });
    expect(results.length).toBe(1);
    expect(results[0].chainId).toBe(137);
  });

  it("queries by status with limit and offset", async () => {
    for (let i = 0; i < 10; i++) {
      await store.upsert(makeEntry({
        hash: "0x" + i.toString(16).padStart(64, "0"),
        status: "confirmed",
        createdAt: Date.now() - i * 1000,
      }));
    }

    const results = await store.query({ status: "confirmed", limit: 3, offset: 0 });
    expect(results.length).toBe(3);
  });

  it("returns results sorted by createdAt desc", async () => {
    const old = makeEntry({ hash: "0x" + "a".repeat(64), createdAt: 1000 });
    const mid = makeEntry({ hash: "0x" + "b".repeat(64), createdAt: 2000 });
    const recent = makeEntry({ hash: "0x" + "c".repeat(64), createdAt: 3000 });

    // Insert out of order
    await store.upsert(mid);
    await store.upsert(recent);
    await store.upsert(old);

    const results = await store.query();
    expect(results.length).toBe(3);
    expect(results[0].createdAt).toBe(3000);
    expect(results[1].createdAt).toBe(2000);
    expect(results[2].createdAt).toBe(1000);
  });

  it("cleans up entries older than retentionDays", async () => {
    // Insert 100 entries to bypass MIN_CLEANUP_ENTRIES check
    for (let i = 0; i < 100; i++) {
      await store.upsert(makeEntry({
        hash: "0x" + i.toString(16).padStart(64, "0"),
        createdAt: Date.now() - 1 * 24 * 60 * 60 * 1000, // 1 day ago
      }));
    }

    // Add one very old entry
    const oldEntry = makeEntry({
      hash: "0x" + "f".repeat(64),
      createdAt: Date.now() - 40 * 24 * 60 * 60 * 1000, // 40 days ago
    });
    await store.upsert(oldEntry);

    const deleted = await store.cleanup(30); // 30 days retention
    expect(deleted).toBe(1);

    const oldRetrieved = await store.get(oldEntry.hash, oldEntry.chainId);
    expect(oldRetrieved).toBeNull();
  });

  it("handles concurrent upsert operations", async () => {
    const entry = makeEntry();
    await store.upsert(entry);

    const updated1 = { ...entry, status: "mined" as const, blockNumber: 100 };
    const updated2 = { ...entry, status: "confirmed" as const, blockNumber: 100, confirmedAt: Date.now() };

    await Promise.all([
      store.upsert(updated1),
      store.upsert(updated2),
    ]);

    const retrieved = await store.get(entry.hash, entry.chainId);
    // Should be either mined or confirmed (last write wins)
    expect(["mined", "confirmed"]).toContain(retrieved!.status);
  });

  it("returns null for non-existent hash with chainId", async () => {
    const result = await store.get("0xnonexistent", 1);
    expect(result).toBeNull();
  });

  it("gets entry without chainId by scanning", async () => {
    const entry = makeEntry();
    await store.upsert(entry);

    const retrieved = await store.get(entry.hash);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.hash).toBe(entry.hash);
  });

  it("scans and returns null for missing hash without chainId", async () => {
    const entry = makeEntry();
    await store.upsert(entry);

    const result = await store.get("0xunknown");
    expect(result).toBeNull();
  });

  it("queries with fromDate filter", async () => {
    const now = Date.now();
    const old = makeEntry({ hash: "0x" + "d".repeat(64), createdAt: now - 10_000 });
    const recent = makeEntry({ hash: "0x" + "e".repeat(64), createdAt: now });
    await store.upsert(old);
    await store.upsert(recent);

    const results = await store.query({ fromDate: now - 5_000 });
    expect(results).toHaveLength(1);
    expect(results[0].hash).toBe(recent.hash);
  });

  it("queries with toDate filter", async () => {
    const now = Date.now();
    const old = makeEntry({ hash: "0x" + "f".repeat(64), createdAt: now - 10_000 });
    const recent = makeEntry({ hash: "0x" + "g".repeat(64), createdAt: now });
    await store.upsert(old);
    await store.upsert(recent);

    const results = await store.query({ toDate: now - 5_000 });
    expect(results).toHaveLength(1);
    expect(results[0].hash).toBe(old.hash);
  });

  it("deletes entry without chainId by scanning", async () => {
    const entry = makeEntry();
    await store.upsert(entry);

    await store.delete(entry.hash);
    const retrieved = await store.get(entry.hash, entry.chainId);
    expect(retrieved).toBeNull();
  });

  it("delete non-existent entry does not throw", async () => {
    await expect(store.delete("0xnonexistent", 1)).resolves.toBeUndefined();
  });

  it("parseKey handles malformed keys", async () => {
    const entry = makeEntry();
    await store.upsert(entry);

    // Access internal parseKey behavior by inserting a raw storage entry
    const storage = new MemoryHistoryStorage();
    const customStore = new TxHistoryStore(storage);
    // Set a malformed key directly
    await storage.setItem("invalid:key", JSON.stringify(entry));
    // This shouldn't break anything — query just ignores entries it can't parse
    const results = await customStore.query();
    expect(results).toHaveLength(0); // parseKey returns null → skipped in getAllHashes
  });

  it("count returns number of entries", async () => {
    expect(await store.count()).toBe(0);
    await store.upsert(makeEntry({ hash: "0x" + "h".repeat(64) }));
    await store.upsert(makeEntry({ hash: "0x" + "i".repeat(64) }));
    expect(await store.count()).toBe(2);
  });

  it("getAllHashes filters by chainId", async () => {
    await store.upsert(makeEntry({ hash: "0x" + "j".repeat(64), chainId: 1 }));
    await store.upsert(makeEntry({ hash: "0x" + "k".repeat(64), chainId: 137 }));

    const hashes = await store.getAllHashes(137);
    expect(hashes).toHaveLength(1);
    expect(hashes[0].chainId).toBe(137);
  });

  it("skips cleanup when under MIN_CLEANUP_ENTRIES threshold and no entries are old", async () => {
    const entry = makeEntry({
      hash: "0x" + "l".repeat(64),
      createdAt: Date.now() - 1 * 24 * 60 * 60 * 1000, // 1 day old
    });
    await store.upsert(entry);

    // 30 day retention, entry is only 1 day old → 0 keys to delete → skip
    const deleted = await store.cleanup(30);
    expect(deleted).toBe(0);
    const retrieved = await store.get(entry.hash, entry.chainId);
    expect(retrieved).not.toBeNull();
  });

  it("handles corrupt entries during cleanup", async () => {
    const storage = new MemoryHistoryStorage();
    const customStore = new TxHistoryStore(storage);

    // Insert 100 valid entries so we bypass MIN_CLEANUP_ENTRIES
    for (let i = 0; i < 100; i++) {
      await customStore.upsert(makeEntry({
        hash: "0x" + i.toString(16).padStart(64, "0"),
      }));
    }

    // Corrupt one entry's raw data so it hits both catch blocks
    const corruptKey = "naculus_tx_history:1:0xcorrupt";
    // First upsert to get it into allKeys
    await customStore.upsert(makeEntry({ hash: "0xcorrupt" }));
    await storage.setItem(corruptKey, "not-valid-json"); // corrupt the data

    const deleted = await customStore.cleanup(0); // 0 days retention — deletes all
    expect(deleted).toBeGreaterThanOrEqual(1);

    // Corrupt entry should be gone from storage
    const raw = await storage.getItem(corruptKey);
    expect(raw).toBeNull();
  });
});

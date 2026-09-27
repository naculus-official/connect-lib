import { describe, expect, it } from "vitest";
import type { WalletData } from "../../wallet";
import { KeyStoreStorageAdapter } from "../key-store";

function cell() {
  let value: string | null = null;
  let writes = 0;
  return {
    get value() {
      return value;
    },
    set value(v: string | null) {
      value = v;
    },
    get writes() {
      return writes;
    },
    store: {
      load: async () => value,
      save: async (v: string) => {
        writes++;
        // Let concurrent callers interleave, as a real store would.
        await new Promise((r) => setTimeout(r, 0));
        value = v;
      },
      delete: async () => {
        value = null;
      },
      read: async () => value,
      write: async (v: string) => {
        value = v;
      },
      remove: async () => {
        value = null;
      },
    },
  };
}

const record = {
  mnemonic: "abandon abandon abandon",
  accounts: [],
  activeNamespace: "eip155",
  createdAt: 1,
  version: 2,
} as unknown as WalletData;

function adapter(slot?: string) {
  const key = cell();
  const blob = cell();
  const storage = new KeyStoreStorageAdapter({
    keyStore: key.store,
    blobStore: blob.store,
    ...(slot ? { slot } : {}),
  });
  return { storage, key, blob };
}

describe("KeyStoreStorageAdapter", () => {
  it("seals the record under a key-store key and opens it again", async () => {
    const { storage, key, blob } = adapter();
    expect(await storage.load()).toBeNull();
    await storage.save(record);
    expect(await storage.load()).toEqual(record);
    expect(key.value).toMatch(/^[0-9a-f]{64}$/);
    expect(blob.value).not.toMatch(/abandon/);
  });

  it("mints one key even when the first saves overlap", async () => {
    const { storage, key } = adapter();
    await Promise.all([storage.save(record), storage.save(record)]);
    expect(key.writes).toBe(1);
    expect(await storage.load()).toEqual(record);
  });

  it("refuses an altered record, and a record whose key is gone", async () => {
    const { storage, key, blob } = adapter();
    await storage.save(record);
    const bytes = Uint8Array.from(atob(blob.value as string), (c) =>
      c.charCodeAt(0),
    );
    bytes[20] = (bytes[20] as number) ^ 1;
    blob.value = btoa(String.fromCharCode(...bytes));
    await expect(storage.load()).rejects.toThrow(/does not open/);
    key.value = null;
    await expect(storage.load()).rejects.toThrow(/key is gone/);
  });

  it("binds the record to its slot", async () => {
    const a = adapter("a");
    await a.storage.save(record);
    const b = adapter("b");
    b.key.value = a.key.value;
    b.blob.value = a.blob.value;
    await expect(b.storage.load()).rejects.toThrow(/does not open/);
  });

  it("clears the record and the key", async () => {
    const { storage, key, blob } = adapter();
    await storage.save(record);
    await storage.clear();
    expect(key.value).toBeNull();
    expect(blob.value).toBeNull();
    expect(await storage.load()).toBeNull();
  });
});

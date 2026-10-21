/**
 * PocketWallet Storage Security Tier Tests
 *
 * Tier mapping:
 *   1 = IndexedDB + AES-GCM  (🔒 highest)
 *   2 = IndexedDB             (✅ default)
 *   3 = localStorage + AES-GCM(⚠️ encrypted, warn about backend)
 *   4 = localStorage          (🚫 XSS-vulnerable, switch browser)
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedDbStorageAdapter } from "../storage/indexed-db";
import { LocalStorageAdapter } from "../storage/local-storage";
import { EncryptedStorageAdapter } from "../storage/encrypted";
import type { StorageAdapter } from "../storage/types";
import { PocketWallet, type WalletData } from "../wallet";

describe("StorageAdapter.type property", () => {
  it("LocalStorageAdapter reports type 'localStorage'", () => {
    expect(new LocalStorageAdapter("t").type).toBe("localStorage");
  });
  it("IndexedDbStorageAdapter reports type 'indexedDb'", () => {
    expect(new IndexedDbStorageAdapter("t").type).toBe("indexedDb");
  });
});

/**
 * Runs `fn` with a browser-like global environment: a `window` global, and an
 * `indexedDB` global only when `idb` is true. Both are restored afterwards.
 */
function inBrowserEnv(idb: boolean, fn: () => void): void {
  const g = globalThis as any;
  const prevWindow = g.window;
  const prevDocument = g.document;
  const prevIdb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  g.window = {};
  g.document = {};
  if (idb) g.indexedDB = {};
  else delete g.indexedDB;
  try {
    fn();
  } finally {
    if (prevWindow === undefined) delete g.window;
    else g.window = prevWindow;
    if (prevDocument === undefined) delete g.document;
    else g.document = prevDocument;
    if (prevIdb) Object.defineProperty(globalThis, "indexedDB", prevIdb);
    else delete g.indexedDB;
  }
}

const passphrase = async () => "correct horse battery staple";

describe("PocketWallet — encrypted-by-default storage", () => {
  it("browser default without passphrase throws when IndexedDB is unavailable", () => {
    inBrowserEnv(false, () => {
      expect(() => new PocketWallet({ storageKey: "t" })).toThrow(
        "A storage passphrase is required",
      );
    });
  });

  it("browser default without passphrase throws when IndexedDB is available", () => {
    inBrowserEnv(true, () => {
      expect(() => new PocketWallet({ storageKey: "t" })).toThrow(
        "A storage passphrase is required",
      );
    });
  });

  it("browser default with passphrase on IndexedDB is tier 1", () => {
    inBrowserEnv(true, () => {
      const w = new PocketWallet({
        storageKey: "t",
        encryptionPassphrase: passphrase,
      });
      expect(w.getStorageSecurityLevel()).toBe(1);
      expect(w.isStorageDegraded()).toBe(false);
    });
  });

  it("explicit storageType 'indexedDb' without passphrase throws in a browser", () => {
    inBrowserEnv(true, () => {
      expect(
        () => new PocketWallet({ storageType: "indexedDb", storageKey: "t" }),
      ).toThrow("A storage passphrase is required");
    });
  });

  it("allowInsecureStorage has no effect", () => {
    inBrowserEnv(true, () => {
      expect(() => new PocketWallet({ storageKey: "t", allowInsecureStorage: true }))
        .toThrow("A storage passphrase is required");
    });
  });

  it("browser auto-detect rejects plaintext fallback even when insecure storage is allowed", () => {
    inBrowserEnv(false, () => {
      expect(
        () => new PocketWallet({ storageKey: "t", allowInsecureStorage: true }),
      ).toThrow("A storage passphrase is required");
    });
  });

  it("IndexedDB unavailable without passphrase throws", () => {
    inBrowserEnv(false, () => {
      expect(
        () =>
          new PocketWallet({
            storageKey: "t",
            allowInsecureStorage: false,
          }),
      ).toThrow("A storage passphrase is required");
    });
  });

  it("IndexedDB unavailable with passphrase uses encrypted fallback and marks degraded", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      inBrowserEnv(false, () => {
        const w = new PocketWallet({
          storageKey: "t",
          encryptionPassphrase: passphrase,
        });
        expect(w.getStorageType()).toBe("encrypted");
        expect(w.getStorageSecurityLevel()).toBe(3);
        expect(w.isStorageDegraded()).toBe(true);
        expect(w.isEncrypted()).toBe(true);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("IndexedDB is unavailable"),
        );
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("Node requires a passphrase for available backends", () => {
    expect(
      () => new PocketWallet({ storageType: "localStorage", storageKey: "t" }),
    ).toThrow("A storage passphrase is required");
  });
});

describe("IndexedDbStorageAdapter — writes never drop silently", () => {
  const data = {
    mnemonic: "test test test test test test test test test test test junk",
    accounts: [],
    activeNamespace: "eip155",
    createdAt: 0,
    version: 2,
  } as any;

  it("save() throws when IndexedDB is unavailable", async () => {
    const adapter = new IndexedDbStorageAdapter("t");
    await expect(adapter.save(data)).rejects.toThrow(
      "IndexedDB is unavailable",
    );
  });

  it("clear() throws when IndexedDB is unavailable", async () => {
    const adapter = new IndexedDbStorageAdapter("t");
    await expect(adapter.clear()).rejects.toThrow("IndexedDB is unavailable");
  });
});

describe("PocketWallet — storage security tier", () => {
  it("auto-detect in Node requires a passphrase", () => {
    expect(() => new PocketWallet({ storageKey: "t" })).toThrow(
      "A storage passphrase is required",
    );
  });

  it("storageType: 'localStorage' requires encryption", () => {
    const w = new PocketWallet({
      storageType: "localStorage",
      storageKey: "t",
      encryptionPassphrase: passphrase,
    });
    expect(w.getStorageSecurityLevel()).toBe(3);
  });

  it("rejects localStorage without a passphrase even when explicitly allowed", () => {
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = {};
    try {
      expect(
        () =>
          new PocketWallet({
            storageType: "localStorage",
            storageKey: "browser-secure",
          }),
      ).toThrow("A storage passphrase is required");
      expect(() => new PocketWallet({
          storageType: "localStorage",
          storageKey: "browser-dev",
          allowInsecureStorage: true,
        })).toThrow("A storage passphrase is required");
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
    }
  });

  it("localStorage + encryptionPassphrase → tier 3", () => {
    const w = new PocketWallet({
      storageType: "localStorage",
      storageKey: "t",
      encryptionPassphrase: async () => "p",
    });
    expect(w.getStorageSecurityLevel()).toBe(3);
  });

  it("storageType: 'indexedDb' throws in Node (IndexedDB unavailable)", () => {
    expect(
      () => new PocketWallet({ storageType: "indexedDb", storageKey: "t", encryptionPassphrase: passphrase }),
    ).toThrow("IndexedDB is unavailable");
  });

  it("custom adapter requires a passphrase", () => {
    const a: StorageAdapter = {
      type: "custom",
      isAvailable: () => true,
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    expect(() => new PocketWallet({ storage: a, storageKey: "t" })).toThrow(
      /passphrase.*custom storage/i,
    );
  });

  it("encrypts wallet records before passing them to custom storage", async () => {
    let stored: unknown = null;
    const a: StorageAdapter = {
      type: "custom",
      isAvailable: () => true,
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn(async (value) => { stored = value; }),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    const w = new PocketWallet({
      storage: a,
      storageKey: "t",
      encryptionPassphrase: async () => "custom-storage-passphrase",
    });
    await w.importMnemonic(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    expect(JSON.stringify(stored)).not.toContain(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    expect(stored).toEqual({
      _encrypted: expect.objectContaining({
        v: 2,
        ciphertext: expect.any(String),
      }),
    });
    expect(w.getStorageType()).toBe("custom");
    expect(w.getStorageSecurityLevel() <= 2).toBe(true);
  });

  it.each([
    {
      name: "unknown namespace",
      accounts: [
        { namespace: "unknown", address: "x", privateKey: "x" },
      ],
    },
    {
      name: "duplicate namespace",
      accounts: [
        { namespace: "eip155", address: "x", privateKey: "x" },
        { namespace: "eip155", address: "y", privateKey: "y" },
      ],
    },
  ])("rejects stored account records with $name", async ({ accounts }) => {
    let stored: unknown = null;
    const inner: StorageAdapter = {
      type: "custom",
      isAvailable: () => true,
      load: vi.fn(async () => stored as WalletData | null),
      save: vi.fn(async (value) => { stored = value; }),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    const passphrase = async () => "namespace-validation-passphrase";
    const writer = new EncryptedStorageAdapter(inner, passphrase);
    await writer.save({
      version: 2,
      mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      accounts,
      activeNamespace: "eip155",
      createdAt: Date.now(),
    } as unknown as WalletData);
    const wallet = new PocketWallet({ storage: inner, encryptionPassphrase: passphrase });
    await expect(wallet.load()).rejects.toMatchObject({
      code: "invalid_key",
    });
  });

  it("encryptionPassphrase with IndexedDB → tier 1", (ctx) => {
    const idb = new IndexedDbStorageAdapter("t");
    if (!idb.isAvailable()) ctx.skip();
    const w = new PocketWallet({
      storage: idb,
      storageKey: "t",
      encryptionPassphrase: async () => "p",
    });
    expect(w.getStorageSecurityLevel()).toBe(1);
  });

  it("deprecated APIs still work", () => {
    const w = new PocketWallet({
      storageType: "localStorage",
      storageKey: "t",
      encryptionPassphrase: passphrase,
    });
    expect(w.getStorageType()).toBe("encrypted");
    expect(w.isStorageDegraded()).toBe(true);
    expect(w.isEncrypted()).toBe(true);
    expect(w.isSecureStorage()).toBe(true);
  });
});

describe("PocketWallet — Web Worker and Node defaults", () => {
  const g = globalThis as any;
  const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
  const globalNames = ["window", "self", "document", "importScripts", "indexedDB"];

  afterEach(() => {
    for (const name of globalNames) {
      const original = originalGlobals.get(name);
      if (original) Object.defineProperty(g, name, original);
      else delete g[name];
    }
    originalGlobals.clear();
  });

  function inWorkerEnv(fn: () => void): void {
    for (const name of globalNames) {
      if (!originalGlobals.has(name)) originalGlobals.set(name, Object.getOwnPropertyDescriptor(g, name));
    }
    for (const name of globalNames) {
      Object.defineProperty(g, name, { configurable: true, writable: true, value: undefined });
    }
    Object.defineProperty(g, "self", { configurable: true, writable: true, value: g });
    Object.defineProperty(g, "document", { configurable: true, writable: true, value: {} });
    Object.defineProperty(g, "importScripts", { configurable: true, writable: true, value: () => {} });
    Object.defineProperty(g, "indexedDB", { configurable: true, writable: true, value: {} });
    fn();
  }

  it("worker (importScripts defined, no window) rejects plaintext by default", () => {
    inWorkerEnv(() => {
      expect(() => new PocketWallet({ storageKey: "t" })).toThrow(
        "A storage passphrase is required",
      );
    });
  });

  it("indexedDB-only non-Node runtime rejects plaintext by default", () => {
    const names = ["window", "importScripts", "indexedDB", "process"];
    const previous = new Map(
      names.map((name) => [name, Object.getOwnPropertyDescriptor(g, name)]),
    );
    try {
      for (const name of names) {
        Object.defineProperty(g, name, {
          configurable: true,
          writable: true,
          value: undefined,
        });
      }
      Object.defineProperty(g, "indexedDB", {
        configurable: true,
        writable: true,
        value: {},
      });
      Object.defineProperty(g, "process", {
        configurable: true,
        writable: true,
        value: { versions: {} },
      });

      expect(g.window).toBeUndefined();
      expect(g.importScripts).toBeUndefined();
      expect(g.process.versions.node).toBeUndefined();
      expect(() => new PocketWallet({ storageKey: "t" })).toThrow(
        "A storage passphrase is required",
      );
    } finally {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(g, name, descriptor);
        else delete g[name];
      }
    }
  });

  it("worker auto-detect requires encryption when IndexedDB is unavailable", () => {
    inWorkerEnv(() => {
      delete (globalThis as any).indexedDB;
      expect(
        () => new PocketWallet({ storageKey: "t", allowInsecureStorage: true }),
      ).toThrow("A storage passphrase is required");
    });
  });

  it("real Node (no window, no importScripts) requires a passphrase", () => {
    const g = globalThis as any;
    expect(g.window).toBeUndefined();
    expect(g.importScripts).toBeUndefined();
    expect(
      () => new PocketWallet({ storageKey: "t", storageType: "localStorage" }),
    ).toThrow("A storage passphrase is required");
  });
});

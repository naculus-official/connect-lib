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
import type { StorageAdapter } from "../storage/types";
import { PocketWallet } from "../wallet";

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
        "Provide encryptionPassphrase",
      );
    });
  });

  it("browser default without passphrase throws when IndexedDB is available", () => {
    inBrowserEnv(true, () => {
      expect(() => new PocketWallet({ storageKey: "t" })).toThrow(
        "Unencrypted IndexedDB storage is disabled",
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
      ).toThrow("Unencrypted IndexedDB storage is disabled");
    });
  });

  it("allowInsecureStorage: true permits plaintext IndexedDB", () => {
    inBrowserEnv(true, () => {
      const w = new PocketWallet({
        storageKey: "t",
        allowInsecureStorage: true,
      });
      expect(w.getStorageSecurityLevel()).toBe(2);
      expect(w.isStorageDegraded()).toBe(false);
    });
  });

  it("browser auto-detect rejects plaintext fallback even when insecure storage is allowed", () => {
    inBrowserEnv(false, () => {
      expect(
        () => new PocketWallet({ storageKey: "t", allowInsecureStorage: true }),
      ).toThrow("Provide encryptionPassphrase");
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
      ).toThrow("IndexedDB is unavailable");
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

  it("Node default remains plaintext-allowed for available backends", () => {
    expect(
      () => new PocketWallet({ storageType: "localStorage", storageKey: "t" }),
    ).not.toThrow();
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
  it("auto-detect in Node allows plaintext localStorage fallback", () => {
    const w = new PocketWallet({ storageKey: "t" });
    expect(w.getStorageType()).toBe("localStorage");
    expect(w.getStorageSecurityLevel()).toBe(4);
    expect(w.isStorageDegraded()).toBe(true);
  });

  it("storageType: 'localStorage' → tier 4", () => {
    const w = new PocketWallet({
      storageType: "localStorage",
      storageKey: "t",
    });
    expect(w.getStorageSecurityLevel()).toBe(4);
  });

  it("rejects unencrypted localStorage in a browser unless explicitly allowed", () => {
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = {};
    try {
      expect(
        () =>
          new PocketWallet({
            storageType: "localStorage",
            storageKey: "browser-secure",
          }),
      ).toThrow("Unencrypted localStorage is disabled");
      expect(
        new PocketWallet({
          storageType: "localStorage",
          storageKey: "browser-dev",
          allowInsecureStorage: true,
        }).getStorageSecurityLevel(),
      ).toBe(4);
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
      () => new PocketWallet({ storageType: "indexedDb", storageKey: "t" }),
    ).toThrow("IndexedDB is unavailable");
  });

  it("custom adapter takes precedence", () => {
    const a: StorageAdapter = {
      type: "custom",
      isAvailable: () => true,
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    const w = new PocketWallet({ storage: a, storageKey: "t" });
    expect(w.getStorageType()).toBe("custom");
    expect(w.getStorageSecurityLevel() <= 2).toBe(true);
  });

  it("encryptionPassphrase with IndexedDB (if available) → tier 1", () => {
    const idb = new IndexedDbStorageAdapter("t");
    if (!idb.isAvailable()) return; // skip in Node
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
    });
    expect(w.getStorageType()).toBe("localStorage");
    expect(w.isStorageDegraded()).toBe(true);
    expect(w.isEncrypted()).toBe(false);
    expect(w.isSecureStorage()).toBe(false);
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
        "Unencrypted IndexedDB storage is disabled",
      );
    });
  });

  it("worker auto-detect requires encryption when IndexedDB is unavailable", () => {
    inWorkerEnv(() => {
      delete (globalThis as any).indexedDB;
      expect(
        () => new PocketWallet({ storageKey: "t", allowInsecureStorage: true }),
      ).toThrow("Provide encryptionPassphrase");
    });
  });

  it("real Node (no window, no importScripts) still defaults to plaintext allowed", () => {
    const g = globalThis as any;
    expect(g.window).toBeUndefined();
    expect(g.importScripts).toBeUndefined();
    expect(
      () => new PocketWallet({ storageKey: "t", storageType: "localStorage" }),
    ).not.toThrow();
  });
});

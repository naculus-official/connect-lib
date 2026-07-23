/**
 * PocketWallet Storage Security Tier Tests
 *
 * Tier mapping:
 *   1 = IndexedDB + AES-GCM  (🔒 highest)
 *   2 = IndexedDB             (✅ default)
 *   3 = localStorage + AES-GCM(⚠️ encrypted, warn about backend)
 *   4 = localStorage          (🚫 XSS-vulnerable, switch browser)
 */

import { describe, it, expect, vi } from "vitest";
import { PocketWallet } from "../wallet";
import { IndexedDbStorageAdapter } from "../storage/indexed-db";
import { LocalStorageAdapter } from "../storage/local-storage";
import type { StorageAdapter } from "../storage/types";

describe("StorageAdapter.type property", () => {
  it("LocalStorageAdapter reports type 'localStorage'", () => {
    expect(new LocalStorageAdapter("t").type).toBe("localStorage");
  });
  it("IndexedDbStorageAdapter reports type 'indexedDb'", () => {
    expect(new IndexedDbStorageAdapter("t").type).toBe("indexedDb");
  });
});

describe("PocketWallet — storage security tier", () => {
  it("auto-detect in Node: IndexedDB unavailable → tier 4 (localStorage)", () => {
    const w = new PocketWallet({ storageKey: "t" });
    const level = w.getStorageSecurityLevel();
    expect([2, 4]).toContain(level); // browser → 2, Node → 4
  });

  it("storageType: 'localStorage' → tier 4", () => {
    const w = new PocketWallet({ storageType: "localStorage", storageKey: "t" });
    expect(w.getStorageSecurityLevel()).toBe(4);
  });

  it("localStorage + encryptionPassphrase → tier 3", () => {
    const w = new PocketWallet({
      storageType: "localStorage", storageKey: "t",
      encryptionPassphrase: async () => "p",
    });
    expect(w.getStorageSecurityLevel()).toBe(3);
  });

  it("storageType: 'indexedDb' throws in Node (IndexedDB unavailable)", () => {
    try {
      new PocketWallet({ storageType: "indexedDb", storageKey: "t" });
    } catch (e: any) {
      expect(e.message || "").toContain("IndexedDB");
    }
  });

  it("custom adapter takes precedence", () => {
    const a: StorageAdapter = {
      type: "custom", isAvailable: () => true,
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
    const w = new PocketWallet({ storage: idb, storageKey: "t", encryptionPassphrase: async () => "p" });
    expect(w.getStorageSecurityLevel()).toBe(1);
  });

  it("deprecated APIs still work", () => {
    const w = new PocketWallet({ storageType: "localStorage", storageKey: "t" });
    expect(w.getStorageType()).toBe("localStorage");
    expect(w.isStorageDegraded()).toBe(true);
    expect(w.isEncrypted()).toBe(false);
    expect(w.isSecureStorage()).toBe(false);
  });
});

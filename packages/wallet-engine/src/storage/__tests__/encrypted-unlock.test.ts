import { beforeAll, describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../../storage/types";
import type { WalletData } from "../../wallet";
import { EncryptedStorageAdapter } from "../encrypted";
import type { PrfUnlockProvider } from "../unlock";

const PASSPHRASE = "correct-horse-battery-stable-2026";

const walletData: WalletData = {
  mnemonic:
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  accounts: [
    {
      namespace: "eip155",
      privateKey: "0x" + "ef".repeat(32),
      address: "0x" + "12".repeat(20),
      derivationPath: "m/44'/60'/0'/0/0",
    },
  ],
  activeNamespace: "eip155",
  createdAt: 1_700_000_000_000,
  version: 2,
};

class MockStorage implements StorageAdapter {
  d: any = null;
  readonly type = "memory" as const;
  isAvailable() {
    return true;
  }
  async load() {
    return this.d;
  }
  async save(data: any) {
    this.d = data;
  }
  async clear() {
    this.d = null;
  }
}

/**
 * Stands in for an authenticator: same salt in, same bytes out, and a
 * different device produces different bytes for the same salt.
 */
function fakeAuthenticator(deviceSecret: string): PrfUnlockProvider & {
  calls: number;
} {
  const provider = {
    calls: 0,
    async derive(salt: Uint8Array): Promise<Uint8Array | null> {
      provider.calls++;
      const material = new Uint8Array(
        new TextEncoder().encode(deviceSecret).length + salt.length,
      );
      material.set(new TextEncoder().encode(deviceSecret), 0);
      material.set(salt, new TextEncoder().encode(deviceSecret).length);
      const digest = await crypto.subtle.digest("SHA-256", material as any);
      return new Uint8Array(digest);
    },
  };
  return provider;
}

const unavailableAuthenticator: PrfUnlockProvider = {
  async derive() {
    return null;
  },
};

function record(inner: MockStorage): any {
  return inner.d?._encrypted;
}

describe("EncryptedStorageAdapter — passkey unlock", () => {
  beforeAll(() => {
    vi.stubGlobal("crypto", crypto);
  });

  it("writes both wraps when the authenticator answers", async () => {
    const inner = new MockStorage();
    const adapter = new EncryptedStorageAdapter(
      inner,
      async () => PASSPHRASE,
      { prf: fakeAuthenticator("device-a") },
    );
    await adapter.save(walletData);

    expect(record(inner).v).toBe(2);
    expect(record(inner).wraps.prf).toBeDefined();
    expect(record(inner).wraps.passphrase).toBeDefined();
    expect(adapter.getUnlockState()).toEqual({
      prf: "available",
      sealedWith: ["prf", "passphrase"],
    });
  });

  it("round-trips through the passkey wrap", async () => {
    const inner = new MockStorage();
    const auth = fakeAuthenticator("device-a");
    const adapter = new EncryptedStorageAdapter(inner, async () => PASSPHRASE, {
      prf: auth,
    });
    await adapter.save(walletData);

    const reader = new EncryptedStorageAdapter(
      inner,
      async () => {
        throw new Error("passphrase must not be needed when PRF opens it");
      },
      { prf: fakeAuthenticator("device-a") },
    );
    expect(await reader.load()).toEqual(walletData);
  });

  // The reason the passphrase wrap is written at all. Sealing directly under
  // PRF would make this case a lost wallet.
  it("still opens with the passphrase when the authenticator is gone", async () => {
    const inner = new MockStorage();
    const sealed = new EncryptedStorageAdapter(
      inner,
      async () => PASSPHRASE,
      { prf: fakeAuthenticator("device-a") },
    );
    await sealed.save(walletData);
    expect(record(inner).wraps.prf).toBeDefined();

    // A different browser: no PRF provider configured at all.
    const elsewhere = new EncryptedStorageAdapter(inner, async () => PASSPHRASE);
    expect(await elsewhere.load()).toEqual(walletData);
  });

  it("falls through to the passphrase when a different authenticator answers", async () => {
    const inner = new MockStorage();
    const sealed = new EncryptedStorageAdapter(inner, async () => PASSPHRASE, {
      prf: fakeAuthenticator("device-a"),
    });
    await sealed.save(walletData);

    const otherDevice = new EncryptedStorageAdapter(
      inner,
      async () => PASSPHRASE,
      { prf: fakeAuthenticator("device-b") },
    );
    expect(await otherDevice.load()).toEqual(walletData);
  });

  it("writes passphrase-only when PRF is unavailable, without failing", async () => {
    const inner = new MockStorage();
    const adapter = new EncryptedStorageAdapter(inner, async () => PASSPHRASE, {
      prf: unavailableAuthenticator,
    });
    await adapter.save(walletData);

    expect(record(inner).wraps.prf).toBeUndefined();
    expect(record(inner).wraps.passphrase).toBeDefined();
    expect(adapter.getUnlockState()).toEqual({
      prf: "unavailable",
      sealedWith: ["passphrase"],
    });
    expect(await adapter.load()).toEqual(walletData);
  });

  it("survives an authenticator that throws", async () => {
    const inner = new MockStorage();
    const adapter = new EncryptedStorageAdapter(inner, async () => PASSPHRASE, {
      prf: {
        async derive() {
          throw new Error("NotAllowedError");
        },
      },
    });
    await adapter.save(walletData);
    expect(record(inner).wraps.prf).toBeUndefined();
    expect(await adapter.load()).toEqual(walletData);
  });

  it("keeps the PRF salt stable across saves", async () => {
    const inner = new MockStorage();
    const adapter = new EncryptedStorageAdapter(inner, async () => PASSPHRASE, {
      prf: fakeAuthenticator("device-a"),
    });
    await adapter.save(walletData);
    const first = record(inner).wraps.prf.salt;
    await adapter.save({ ...walletData, createdAt: 1 });
    expect(record(inner).wraps.prf.salt).toBe(first);
  });

  // A rotated salt is a discarded wallet: the old ciphertext can no longer be
  // opened by the authenticator that sealed it.
  it("reuses the stored salt in a fresh session rather than generating one", async () => {
    const inner = new MockStorage();
    const first = new EncryptedStorageAdapter(inner, async () => PASSPHRASE, {
      prf: fakeAuthenticator("device-a"),
    });
    await first.save(walletData);
    const salt = record(inner).wraps.prf.salt;

    const second = new EncryptedStorageAdapter(inner, async () => PASSPHRASE, {
      prf: fakeAuthenticator("device-a"),
    });
    await second.save(walletData);
    expect(record(inner).wraps.prf.salt).toBe(salt);
  });

  it("derives from the authenticator once per session, not once per save", async () => {
    const inner = new MockStorage();
    const auth = fakeAuthenticator("device-a");
    const adapter = new EncryptedStorageAdapter(inner, async () => PASSPHRASE, {
      prf: auth,
    });
    await adapter.save(walletData);
    await adapter.save(walletData);
    await adapter.save(walletData);
    expect(auth.calls).toBe(1);
  });

  it("reports unknown before any I/O rather than claiming no support", () => {
    const inner = new MockStorage();
    const configured = new EncryptedStorageAdapter(
      inner,
      async () => PASSPHRASE,
      { prf: fakeAuthenticator("device-a") },
    );
    expect(configured.getUnlockState()).toEqual({
      prf: "unknown",
      sealedWith: null,
    });

    const plain = new EncryptedStorageAdapter(inner, async () => PASSPHRASE);
    expect(plain.getUnlockState()).toEqual({ prf: "none", sealedWith: null });
  });

  it("rejects a wrong passphrase against a v2 record", async () => {
    const inner = new MockStorage();
    const adapter = new EncryptedStorageAdapter(inner, async () => PASSPHRASE);
    await adapter.save(walletData);
    const wrong = new EncryptedStorageAdapter(inner, async () => "nope");
    await expect(wrong.load()).rejects.toThrow("Invalid passphrase");
  });

  it("refuses a record whose only wrap is a passkey this device lacks", async () => {
    const inner = new MockStorage();
    const adapter = new EncryptedStorageAdapter(inner, async () => PASSPHRASE, {
      prf: fakeAuthenticator("device-a"),
    });
    await adapter.save(walletData);
    // Simulate a record written by a build that dropped the passphrase wrap.
    delete inner.d._encrypted.wraps.passphrase;

    const elsewhere = new EncryptedStorageAdapter(inner, async () => PASSPHRASE);
    await expect(elsewhere.load()).rejects.toThrow(
      "no passphrase fallback",
    );
  });
});

describe("EncryptedStorageAdapter — v1 records", () => {
  beforeAll(() => {
    vi.stubGlobal("crypto", crypto);
  });

  /** Seal a record the way the pre-envelope adapter did. */
  async function writeV1(inner: MockStorage, passphrase: string) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const base = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(passphrase) as any,
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: salt as any, iterations: 600_000, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as any },
      key,
      new TextEncoder().encode(JSON.stringify(walletData)) as any,
    );
    const hex = (b: ArrayBuffer | Uint8Array) =>
      Array.from(b instanceof Uint8Array ? b : new Uint8Array(b))
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
    await inner.save({
      _encrypted: {
        salt: hex(salt),
        iv: hex(iv),
        ciphertext: hex(ciphertext),
      },
    });
  }

  it("reads a record written before envelope wrapping", async () => {
    const inner = new MockStorage();
    await writeV1(inner, PASSPHRASE);
    const adapter = new EncryptedStorageAdapter(inner, async () => PASSPHRASE, {
      prf: fakeAuthenticator("device-a"),
    });
    expect(await adapter.load()).toEqual(walletData);
    expect(adapter.getUnlockState().sealedWith).toEqual(["passphrase"]);
  });

  it("upgrades to both wraps on the next save", async () => {
    const inner = new MockStorage();
    await writeV1(inner, PASSPHRASE);
    const adapter = new EncryptedStorageAdapter(inner, async () => PASSPHRASE, {
      prf: fakeAuthenticator("device-a"),
    });
    const loaded = await adapter.load();
    await adapter.save(loaded!);
    expect(record(inner).v).toBe(2);
    expect(record(inner).wraps.prf).toBeDefined();
    expect(record(inner).wraps.passphrase).toBeDefined();
  });

  it("still reports a wrong passphrase as such", async () => {
    const inner = new MockStorage();
    await writeV1(inner, PASSPHRASE);
    const adapter = new EncryptedStorageAdapter(inner, async () => "nope");
    await expect(adapter.load()).rejects.toThrow("Invalid passphrase");
  });
});

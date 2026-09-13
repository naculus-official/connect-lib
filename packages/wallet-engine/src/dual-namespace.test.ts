import { describe, expect, it } from "vitest";
import { migrateWalletData, PocketWallet } from "./wallet";

/**
 * WalletData version 2: one wallet, one account per namespace.
 *
 * The migration is the highest-risk part of this change — a mistake there
 * costs someone their wallet, not a render — so it is tested as its own pure
 * function before anything touches storage.
 */

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const EVM_ADDRESS = "0x9858eFFd232B4033E47d90003D41EC34EcaEda94";

function memoryStorage() {
  let held: unknown = null;
  return {
    adapter: {
      save: async (d: unknown) => {
        held = JSON.parse(JSON.stringify(d));
      },
      load: async () => held,
      clear: async () => {
        held = null;
      },
    },
    peek: () => held as Record<string, unknown> | null,
    seed: (record: unknown) => {
      held = record;
    },
  };
}

describe("migrateWalletData", () => {
  const v1 = {
    mnemonic: MNEMONIC,
    privateKey: `0x${"11".repeat(32)}`,
    address: EVM_ADDRESS,
    createdAt: 1_700_000_000_000,
    chainId: "eip155:137",
  };

  it("wraps a version 1 record without changing its key", () => {
    const migrated = migrateWalletData(v1);
    expect(migrated?.version).toBe(2);
    expect(migrated?.accounts).toHaveLength(1);
    expect(migrated?.accounts[0]).toMatchObject({
      namespace: "eip155",
      privateKey: v1.privateKey,
      address: v1.address,
    });
    expect(migrated?.activeNamespace).toBe("eip155");
  });

  it("keeps the mnemonic and chain", () => {
    const migrated = migrateWalletData(v1);
    expect(migrated?.mnemonic).toBe(MNEMONIC);
    expect(migrated?.chainId).toBe("eip155:137");
  });

  it("does not derive a Solana account during migration", () => {
    // Deriving needs async work. This has to stay pure and total: a migration
    // that can fail partway is a migration that can lose a wallet.
    const migrated = migrateWalletData(v1);
    expect(migrated?.accounts.some((a) => a.namespace === "solana")).toBe(
      false,
    );
  });

  it("passes a version 2 record through untouched", () => {
    const v2 = migrateWalletData(v1);
    expect(migrateWalletData(v2)).toBe(v2);
  });

  it.each([null, undefined, 42, "text", {}, { mnemonic: "x" }])(
    "refuses %o rather than inventing an account",
    (bad) => {
      expect(migrateWalletData(bad)).toBeNull();
    },
  );

  it("survives a version 1 record with no mnemonic", () => {
    // A raw-key import. It has no phrase and never will.
    const migrated = migrateWalletData({ ...v1, mnemonic: "" });
    expect(migrated?.mnemonic).toBe("");
    expect(migrated?.accounts).toHaveLength(1);
  });
});

describe("a wallet from a mnemonic holds both namespaces", () => {
  it("derives an account for each", async () => {
    const wallet = new PocketWallet({ autoSave: false });
    const data = await wallet.importMnemonic(MNEMONIC);
    expect(data.accounts.map((a) => a.namespace).sort()).toEqual([
      "eip155",
      "solana",
    ]);
  });

  it("gives the EVM account the address every other wallet derives", async () => {
    const wallet = new PocketWallet({ autoSave: false });
    await wallet.importMnemonic(MNEMONIC);
    expect(wallet.account("eip155")?.address.toLowerCase()).toBe(
      EVM_ADDRESS.toLowerCase(),
    );
  });

  it("keeps the two keys independent", async () => {
    // Not variants of one key. Holding one must not reveal the other.
    const wallet = new PocketWallet({ autoSave: false });
    await wallet.importMnemonic(MNEMONIC);
    expect(wallet.account("eip155")?.privateKey).not.toBe(
      wallet.account("solana")?.privateKey,
    );
  });

  it("records where each was derived", async () => {
    const wallet = new PocketWallet({ autoSave: false });
    await wallet.importMnemonic(MNEMONIC);
    expect(wallet.account("eip155")?.derivationPath).toBe("m/44'/60'/0'/0/0");
    expect(wallet.account("solana")?.derivationPath).toBe("m/44'/501'/0'/0'");
  });

  it("starts on EVM and can switch", async () => {
    const wallet = new PocketWallet({ autoSave: false });
    await wallet.importMnemonic(MNEMONIC);
    expect(wallet.address?.toLowerCase()).toBe(EVM_ADDRESS.toLowerCase());
    wallet.setActiveNamespace("solana");
    expect(wallet.address).toBe(wallet.account("solana")?.address);
  });

  it("refuses to activate a namespace it holds no account for", async () => {
    const wallet = new PocketWallet({ autoSave: false });
    await wallet.importPrivateKey(`0x${"11".repeat(32)}`);
    expect(() => wallet.setActiveNamespace("solana")).toThrow(
      /holds no solana account/,
    );
  });
});

describe("a wallet from a raw key holds only that namespace", () => {
  it("does not invent a Solana account", async () => {
    // A raw key is on one curve. Showing a Solana account would show an
    // address the key cannot control and the user cannot recover.
    const wallet = new PocketWallet({ autoSave: false });
    const data = await wallet.importPrivateKey(`0x${"11".repeat(32)}`);
    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0].namespace).toBe("eip155");
  });

  it("records no derivation path, because there is none", async () => {
    const wallet = new PocketWallet({ autoSave: false });
    await wallet.importPrivateKey(`0x${"11".repeat(32)}`);
    expect(wallet.account("eip155")?.derivationPath).toBeUndefined();
  });

  it("backfills nothing, and says so", async () => {
    const wallet = new PocketWallet({ autoSave: false });
    await wallet.importPrivateKey(`0x${"11".repeat(32)}`);
    expect(await wallet.backfillAccounts()).toEqual([]);
  });
});

describe("loading a version 1 record", () => {
  const legacy = {
    mnemonic: MNEMONIC,
    privateKey:
      "0x1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727",
    address: EVM_ADDRESS.toLowerCase(),
    createdAt: 1_700_000_000_000,
  };

  it("opens without rewriting storage", async () => {
    // A read that writes is a read that can fail. The migrated shape is
    // persisted on the next explicit save instead.
    const storage = memoryStorage();
    storage.seed(legacy);
    const wallet = new PocketWallet({
      storage: storage.adapter as never,
      autoSave: false,
    });

    expect(await wallet.load()).toBe(true);
    expect(wallet.address?.toLowerCase()).toBe(EVM_ADDRESS.toLowerCase());
    expect(storage.peek()).toEqual(legacy);
  });

  it("gains its Solana account only when asked", async () => {
    // The account already exists — the same phrase in Phantom shows it — so
    // hiding it would mean the balance is visible everywhere except here.
    const storage = memoryStorage();
    storage.seed(legacy);
    const wallet = new PocketWallet({
      storage: storage.adapter as never,
      autoSave: false,
    });
    await wallet.load();
    expect(wallet.account("solana")).toBeNull();

    const added = await wallet.backfillAccounts();
    expect(added.map((a) => a.namespace)).toEqual(["solana"]);
    expect(wallet.account("solana")?.address).toBeTruthy();
  });

  it("leaves the active namespace alone when backfilling", async () => {
    // Shown, not switched to. A user who had an Ethereum wallet yesterday
    // should not find themselves on Solana today.
    const storage = memoryStorage();
    storage.seed(legacy);
    const wallet = new PocketWallet({
      storage: storage.adapter as never,
      autoSave: false,
    });
    await wallet.load();
    await wallet.backfillAccounts();
    expect(wallet.address?.toLowerCase()).toBe(EVM_ADDRESS.toLowerCase());
  });

  it("backfills at most once", async () => {
    const storage = memoryStorage();
    storage.seed(legacy);
    const wallet = new PocketWallet({
      storage: storage.adapter as never,
      autoSave: false,
    });
    await wallet.load();
    await wallet.backfillAccounts();
    expect(await wallet.backfillAccounts()).toEqual([]);
    expect(wallet.accounts()).toHaveLength(2);
  });

  it("still rejects a record whose address does not match its key", async () => {
    // The integrity check predates this change and must survive it: signing
    // with a mismatched pair means transactions from an account the user does
    // not control.
    const storage = memoryStorage();
    storage.seed({ ...legacy, address: `0x${"22".repeat(20)}` });
    const wallet = new PocketWallet({
      storage: storage.adapter as never,
      autoSave: false,
    });
    await expect(wallet.load()).rejects.toThrow(
      /does not match its private key/,
    );
  });
});

describe("secure wipe covers every account", () => {
  it("overwrites all keys, not just the active one", async () => {
    const wallet = new PocketWallet({ autoSave: false });
    await wallet.importMnemonic(MNEMONIC);
    const before = wallet.accounts().map((a) => a.privateKey);
    const held = wallet.getWalletData();

    wallet.destroySession();

    expect(held?.accounts.every((a, i) => a.privateKey !== before[i])).toBe(
      true,
    );
  });

  it("does not corrupt what was already persisted", async () => {
    // The saved record shared its accounts array with the live one, so wiping
    // in place reached through and replaced the stored key too — measured, and
    // the next load could not open the wallet.
    const storage = memoryStorage();
    const wallet = new PocketWallet({
      storage: storage.adapter as never,
      autoSave: true,
    });
    await wallet.generate();
    const readStoredKey = () => {
      const record = storage.peek();
      if (!record) throw new Error("nothing was persisted");
      return (record.accounts as { privateKey: string }[])[0].privateKey;
    };
    const savedKey = readStoredKey();

    wallet.destroySession();

    expect(readStoredKey()).toBe(savedKey);
  });

  it("leaves a wallet loadable again after destroySession", async () => {
    const storage = memoryStorage();
    const first = new PocketWallet({
      storage: storage.adapter as never,
      autoSave: true,
    });
    await first.generate();
    const address = first.address;
    first.destroySession();

    const second = new PocketWallet({
      storage: storage.adapter as never,
      autoSave: false,
    });
    expect(await second.load()).toBe(true);
    expect(second.address).toBe(address);
  });
});

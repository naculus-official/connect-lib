import type { StorageAdapter, WalletData } from "@naculus/wallet-engine";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPocketConnector } from "./index";

/**
 * What the session says, and who is told when it changes.
 *
 * Both failures guarded here are silent. A session that files a Solana address
 * under `eip155` is a CAIP-10 string asserting the address exists on a chain
 * it never has; a namespace switch nobody is told about leaves the interface
 * showing one address while a different key signs. Neither throws, and a user
 * acts on both.
 */

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

class MemoryStorage implements StorageAdapter {
  private d: WalletData | null = null;
  readonly type = "memory" as const;
  isAvailable() {
    return true;
  }
  async load() {
    return this.d;
  }
  async save(x: WalletData) {
    this.d = x;
  }
  async clear() {
    this.d = null;
  }
}

async function connected() {
  const connector = createPocketConnector({ storage: new MemoryStorage() });
  const session = await connector.connect();
  await connector.importFromMnemonic(MNEMONIC);
  return { connector, session };
}

beforeEach(() => vi.restoreAllMocks());

describe("session namespaces", () => {
  it("files each account under the namespace it belongs to", async () => {
    const { connector } = await connected();
    const session = await connector.connect();

    const evm = session.namespaces.eip155?.accounts ?? [];
    const solana = session.namespaces.solana?.accounts ?? [];
    expect(evm).toHaveLength(1);
    expect(solana).toHaveLength(1);
    expect(evm[0]).toMatch(/^eip155:\d+:0x[0-9a-fA-F]{40}$/);
    expect(solana[0]).toMatch(
      /^solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    );
  });

  // The regression: whichever namespace was active became "the" eip155
  // account, so a Solana address was published as an Ethereum one.
  it("does not publish a Solana address as an EVM account", async () => {
    const { connector } = await connected();
    connector.setActiveNamespace("solana");
    const session = await connector.connect();

    for (const account of session.namespaces.eip155?.accounts ?? []) {
      expect(account).toMatch(/^eip155:\d+:0x[0-9a-fA-F]{40}$/);
    }
  });

  it("omits a namespace the wallet holds no account for", async () => {
    const connector = createPocketConnector({ storage: new MemoryStorage() });
    await connector.connect();
    const solanaKey = createPocketConnector({ storage: new MemoryStorage() });
    await solanaKey.connect();
    await solanaKey.importFromMnemonic(MNEMONIC);
    // A raw EVM key: one curve, one account.
    await connector.importFromPrivateKey(`0x${"11".repeat(32)}`);
    const session = await connector.connect();
    expect(session.namespaces.solana).toBeUndefined();
    expect(session.namespaces.eip155).toBeDefined();
  });
});

describe("accountsChanged", () => {
  it("reports a namespace switch", async () => {
    const { connector, session } = await connected();
    const seen: string[][] = [];
    connector.onAccountsChanged(session, (accounts) => seen.push(accounts));

    connector.setActiveNamespace("solana");
    expect(seen).toHaveLength(1);
    expect(seen[0].some((a) => a.startsWith("solana:"))).toBe(true);
  });

  it("stops reporting after unsubscribe", async () => {
    const { connector, session } = await connected();
    const seen: string[][] = [];
    const off = connector.onAccountsChanged(session, (a) => seen.push(a));
    off();
    connector.setActiveNamespace("solana");
    expect(seen).toHaveLength(0);
  });

  // One listener throwing must not leave the wallet mid-switch or silence
  // the others.
  it("still notifies the rest when one listener throws", async () => {
    const { connector, session } = await connected();
    const seen: string[][] = [];
    connector.onAccountsChanged(session, () => {
      throw new Error("consumer bug");
    });
    connector.onAccountsChanged(session, (a) => seen.push(a));
    expect(() => connector.setActiveNamespace("solana")).not.toThrow();
    expect(seen).toHaveLength(1);
  });
});

describe("signMessage account check", () => {
  it("refuses to sign as an account that is not the active one", async () => {
    const { connector, session } = await connected();
    const evmAddress = connector.account("eip155")!.address;
    connector.setActiveNamespace("solana");

    // The bomb: an app asks for a signature "as 0x9858…" and, without this
    // check, receives an ed25519 signature that verifies against nothing.
    await expect(
      connector.signMessage(session, {
        message: "hello",
        address: evmAddress,
      }),
    ).rejects.toThrow(/signing as/);
  });

  it("signs when the requested account is the active one", async () => {
    const { connector, session } = await connected();
    const address = connector.account("eip155")!.address;
    await expect(
      connector.signMessage(session, { message: "hello", address }),
    ).resolves.toBeTruthy();
  });

  it("accepts a CAIP-10 form of the same account", async () => {
    const { connector, session } = await connected();
    const address = connector.account("eip155")!.address;
    await expect(
      connector.signMessage(session, {
        message: "hello",
        address: `eip155:1:${address}`,
      }),
    ).resolves.toBeTruthy();
  });

  it("still signs when no account is named", async () => {
    const { connector, session } = await connected();
    await expect(
      connector.signMessage(session, { message: "hello" }),
    ).resolves.toBeTruthy();
  });
});

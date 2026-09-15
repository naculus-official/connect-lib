import { ed25519 } from "@noble/curves/ed25519.js";
import type { StorageAdapter } from "@naculus/wallet-engine";
import type { WalletData } from "@naculus/wallet-engine";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPocketConnector } from "./index";

/**
 * Signing routed on the active namespace.
 *
 * The failure this guards is not a crash. An EIP-155 signature over Solana
 * bytes — or an ed25519 signature over EVM-shaped fields — is a well-formed
 * signature that verifies against nothing, and the only place it fails is on
 * a cluster, after the user has already agreed to it.
 */

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

class MemoryStorage implements StorageAdapter {
  private data: WalletData | null = null;
  readonly type = "memory" as const;
  isAvailable() {
    return true;
  }
  async load() {
    return this.data;
  }
  async save(d: WalletData) {
    this.data = d;
  }
  async clear() {
    this.data = null;
  }
}

async function solanaWallet() {
  const connector = createPocketConnector({
    storage: new MemoryStorage(),
    solanaRpcUrl: "https://rpc.invalid",
  });
  const session = await connector.connect();
  await connector.importFromMnemonic(MNEMONIC);
  await connector.backfillAccounts();
  connector.setActiveNamespace("solana");
  const account = connector.account("solana");
  if (!account) throw new Error("no solana account");
  const seed = account.privateKey.replace(/^0x/, "");
  const secret = new Uint8Array(
    seed.match(/../g)!.map((b) => parseInt(b, 16)),
  );
  return { connector, session, secret, publicKey: ed25519.getPublicKey(secret) };
}

/** Smallest structurally valid v0 message with one required signer. */
function unsignedTransaction(publicKey: Uint8Array) {
  const message = new Uint8Array([
    0x80, // version 0
    1, // numRequiredSignatures
    0,
    0,
    1, // one account key
    ...publicKey,
    ...new Uint8Array(32), // recent blockhash
    0, // no instructions
  ]);
  const wire = new Uint8Array([1, ...new Uint8Array(64), ...message]);
  return { wire, message };
}

beforeEach(() => vi.restoreAllMocks());

describe("embedded connector — Solana routing", () => {
  it("signs with ed25519 when the active account is Solana", async () => {
    const { connector, session, publicKey } = await solanaWallet();
    const { wire, message } = unsignedTransaction(publicKey);

    const signed = (await connector.signTransaction(session, {
      transaction: wire,
    })) as Uint8Array;

    expect(signed).toBeInstanceOf(Uint8Array);
    expect(ed25519.verify(signed.subarray(1, 65), message, publicKey)).toBe(
      true,
    );
  });

  it("accepts base64, which is how an RPC hands one over", async () => {
    const { connector, session, publicKey } = await solanaWallet();
    const { wire, message } = unsignedTransaction(publicKey);
    const base64 = btoa(String.fromCharCode(...wire));

    const signed = (await connector.signTransaction(session, {
      transaction: base64,
    })) as Uint8Array;
    expect(ed25519.verify(signed.subarray(1, 65), message, publicKey)).toBe(
      true,
    );
  });

  it("accepts raw bytes passed directly", async () => {
    const { connector, session, publicKey } = await solanaWallet();
    const { wire } = unsignedTransaction(publicKey);
    await expect(
      connector.signTransaction(session, wire),
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  it("says what to do when handed an EVM-shaped request", async () => {
    const { connector, session } = await solanaWallet();
    await expect(
      connector.signTransaction(session, { to: "0x00", value: "0" }),
    ).rejects.toThrow(/base64 or bytes/);
  });

  // The key is on one curve. Signing someone else's transaction and putting
  // the result nowhere in particular returns something that looks signed.
  it("refuses a transaction this account does not sign", async () => {
    const { connector, session } = await solanaWallet();
    const stranger = ed25519.getPublicKey(new Uint8Array(32).fill(9));
    const { wire } = unsignedTransaction(stranger);
    await expect(
      connector.signTransaction(session, { transaction: wire }),
    ).rejects.toThrow(/not a required signer/);
  });

  it("still takes the EVM path when the active account is EVM", async () => {
    const { connector, session, publicKey } = await solanaWallet();
    connector.setActiveNamespace("eip155");
    const { wire } = unsignedTransaction(publicKey);
    // Bytes are not an EVM transaction, and the EVM path must say so rather
    // than quietly signing them.
    await expect(
      connector.signTransaction(session, { transaction: wire }),
    ).rejects.toThrow();
  });

  it("submits over the Solana RPC, not the EVM one", async () => {
    const { connector, session, publicKey } = await solanaWallet();
    const { wire } = unsignedTransaction(publicKey);
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ jsonrpc: "2.0", id: 1, result: "5xSig" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const signature = await connector.sendTransaction(session, {
      transaction: wire,
    });

    expect(signature).toBe("5xSig");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(url).toBe("https://rpc.invalid");
    const body = JSON.parse(init.body);
    expect(body.method).toBe("sendTransaction");
    expect(body.params[1]).toEqual({ encoding: "base64" });
  });

  it("refuses to submit a transaction still missing a signature", async () => {
    const { connector, session, publicKey } = await solanaWallet();
    const stranger = ed25519.getPublicKey(new Uint8Array(32).fill(9));
    // Two signers, only ours available.
    const message = new Uint8Array([
      0x80, 2, 0, 0, 2, ...publicKey, ...stranger,
      ...new Uint8Array(32), 0,
    ]);
    const wire = new Uint8Array([
      2,
      ...new Uint8Array(128),
      ...message,
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("must not reach the network");
      }),
    );
    await expect(
      connector.sendTransaction(session, { transaction: wire }),
    ).rejects.toThrow(/needs another signature/);
  });
});

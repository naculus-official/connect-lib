/**
 * Validation for wallet-engine/sendTransaction/active-account-lifecycle-binding
 * (NEEDS-VALIDATION.md run2, line 449). Run without OS sandbox: in-process,
 * fetch fully stubbed (no network), dummy keys only, the "broadcast" is a
 * stub that records the raw transaction and returns a fixed hash.
 *
 * Exercised at the PocketWallet level (the sink). The connector-level
 * admission check (connector-embedded validateRequestFrom / session id) is
 * not exercised here: connector-embedded is not a dependency of
 * wallet-engine and only this one file may be added.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeRlpList, hexToBytes } from "./signers/rlp";
import type { StorageAdapter } from "./storage/types";
import { PocketWallet, type WalletData } from "./wallet";

// Public dummy keys, test-only.
const KEY_A = `0x${"11".repeat(32)}`;
const KEY_B = `0x${"22".repeat(32)}`;
const RPC = "https://fixture.invalid";
const HASH = `0x${"ab".repeat(32)}`;

function addressOf(key: string): string {
  const pub = secp256k1.getPublicKey(hexToBytes(key), false);
  return `0x${bytesToHex(keccak_256(pub.slice(1)).slice(-20))}`;
}
const ADDRESS_A = addressOf(KEY_A);
const ADDRESS_B = addressOf(KEY_B);

class MemoryStorage implements StorageAdapter {
  private data: WalletData | null = null;
  readonly type = "memory" as const;
  isAvailable(): boolean {
    return true;
  }
  async load(): Promise<WalletData | null> {
    return this.data;
  }
  async save(data: WalletData): Promise<void> {
    this.data = data;
  }
  async clear(): Promise<void> {
    this.data = null;
  }
}

/** Minimal RLP decoder for a flat list of byte strings. */
function decodeFlatList(bytes: Uint8Array): Uint8Array[] {
  const readLength = (at: number, n: number) => {
    let len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + (bytes[at + i] as number);
    return len;
  };
  const head = bytes[0] as number;
  let pos: number;
  let end: number;
  if (head >= 0xf8) {
    const n = head - 0xf7;
    pos = 1 + n;
    end = pos + readLength(1, n);
  } else if (head >= 0xc0) {
    pos = 1;
    end = 1 + head - 0xc0;
  } else {
    throw new Error("fixture: not an RLP list");
  }
  const out: Uint8Array[] = [];
  while (pos < end) {
    const b = bytes[pos] as number;
    if (b < 0x80) {
      out.push(bytes.slice(pos, pos + 1));
      pos += 1;
    } else if (b < 0xb8) {
      const len = b - 0x80;
      out.push(bytes.slice(pos + 1, pos + 1 + len));
      pos += 1 + len;
    } else if (b < 0xc0) {
      const n = b - 0xb7;
      const len = readLength(pos + 1, n);
      out.push(bytes.slice(pos + 1 + n, pos + 1 + n + len));
      pos += 1 + n + len;
    } else {
      throw new Error("fixture: nested list in legacy transaction");
    }
  }
  return out;
}

function rlpString(b: Uint8Array): Uint8Array {
  if (b.length === 1 && (b[0] as number) < 0x80) return b;
  if (b.length >= 56) throw new Error("fixture: long string");
  return new Uint8Array([0x80 + b.length, ...b]);
}

const toBig = (b: Uint8Array) => (b.length ? BigInt(`0x${bytesToHex(b)}`) : 0n);

/** Recover the sender of a signed legacy EIP-155 transaction. */
function recoverLegacySender(raw: string): string {
  const items = decodeFlatList(hexToBytes(raw));
  expect(items).toHaveLength(9);
  const v = toBig(items[6] as Uint8Array);
  const chainId = (v - 35n) / 2n;
  const recovery = Number(v - 35n - chainId * 2n);
  const chainHex = chainId.toString(16);
  const chainBytes = hexToBytes(
    chainHex.length % 2 ? `0${chainHex}` : chainHex,
  );
  const unsigned = encodeRlpList([
    ...items.slice(0, 6).map(rlpString),
    rlpString(chainBytes),
    rlpString(new Uint8Array()),
    rlpString(new Uint8Array()),
  ]);
  const sig = new secp256k1.Signature(
    toBig(items[7] as Uint8Array),
    toBig(items[8] as Uint8Array),
  ).addRecoveryBit(recovery);
  const pub = sig.recoverPublicKey(keccak_256(unsigned)).toBytes(false);
  return `0x${bytesToHex(keccak_256(pub.slice(1)).slice(-20))}`;
}

interface Rpc {
  nonceAccounts: string[];
  raw: string[];
  unexpected: string[];
  /** Resolves when eth_getTransactionCount is entered, if held. */
  nonceEntered: Promise<void>;
  releaseNonce: () => void;
}

function stubRpc(holdNonce: boolean): Rpc {
  let entered!: () => void;
  let release!: () => void;
  const nonceEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const rpc: Rpc = {
    nonceAccounts: [],
    raw: [],
    unexpected: [],
    nonceEntered,
    releaseNonce: release,
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, opts) => {
    if (String(url) !== RPC) throw new Error(`fixture: unexpected URL ${url}`);
    const body = JSON.parse((opts as RequestInit).body as string) as {
      id: number;
      method: string;
      params: unknown[];
    };
    let result: unknown;
    if (body.method === "eth_getTransactionCount") {
      rpc.nonceAccounts.push(String(body.params[0]).toLowerCase());
      if (holdNonce) {
        entered();
        await released;
      }
      result = "0x0";
    } else if (body.method === "eth_sendRawTransaction") {
      rpc.raw.push(String(body.params[0]));
      result = HASH;
    } else {
      rpc.unexpected.push(body.method);
      throw new Error(`fixture: unexpected method ${body.method}`);
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  return rpc;
}

function makeWallet() {
  return new PocketWallet({
  encryptionPassphrase: async () => "test-passphrase-only",
    rpcUrl: RPC,
    chainId: "eip155:1",
    storage: new MemoryStorage(),
    autoSave: true,
    autoSimulate: false,
  });
}

const TX = {
  to: "0x0000000000000000000000000000000000000001",
  value: "0x1",
  gas: "0x5208",
  gasPrice: "0x1",
  chainId: 1,
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validation: wallet-engine/sendTransaction/active-account-lifecycle-binding", () => {
  it("control: no replacement — the broadcast recovers to A", async () => {
    const rpc = stubRpc(false);
    const wallet = makeWallet();
    await wallet.importPrivateKey(KEY_A);
    expect(wallet.address?.toLowerCase()).toBe(ADDRESS_A);
    await wallet.sendTransaction({ ...TX });
    expect(rpc.nonceAccounts).toEqual([ADDRESS_A]);
    expect(rpc.raw).toHaveLength(1);
    expect(recoverLegacySender(rpc.raw[0] as string)).toBe(ADDRESS_A);
    expect(rpc.unexpected).toEqual([]);
  });

  it("control: replacement completed before admission — the broadcast recovers to B", async () => {
    const rpc = stubRpc(false);
    const wallet = makeWallet();
    await wallet.importPrivateKey(KEY_A);
    await wallet.importPrivateKey(KEY_B);
    await wallet.sendTransaction({ ...TX });
    expect(rpc.nonceAccounts).toEqual([ADDRESS_B]);
    expect(recoverLegacySender(rpc.raw[0] as string)).toBe(ADDRESS_B);
  });

  // wallet-engine/sendTransaction/active-account-lifecycle-binding: the
  // send binds account, signer and signerEpoch before its first await and
  // re-checks them before signing and before broadcast.
  it("a send admitted for A and held at nonce is not signed by B after importPrivateKey(B)", async () => {
    const rpc = stubRpc(true);
    const wallet = makeWallet();
    await wallet.importPrivateKey(KEY_A);
    const sending = wallet.sendTransaction({ ...TX });
    await rpc.nonceEntered;
    expect(rpc.nonceAccounts).toEqual([ADDRESS_A]);
    await wallet.importPrivateKey(KEY_B);
    expect(wallet.address?.toLowerCase()).toBe(ADDRESS_B);
    rpc.releaseNonce();
    const [outcome] = await Promise.allSettled([sending]);

    // Safe: no broadcast at all, or a broadcast still signed by A.
    const senders = rpc.raw.map(recoverLegacySender);
    expect(senders.filter((s) => s !== ADDRESS_A)).toEqual([]);
    expect(senders).not.toContain(ADDRESS_B);
    // The fix chooses "no broadcast": the send fails closed.
    expect(rpc.raw).toEqual([]);
    expect(outcome.status).toBe("rejected");
    expect((outcome as PromiseRejectedResult).reason).toMatchObject({
      code: "tx_failed",
    });
  });

  // The window only the second check (right before eth_sendRawTransaction)
  // covers: the re-key lands while the bound signer is still signing for A.
  // Seam: the signer instance the send captured (PocketWallet.activeSigner),
  // whose signTransaction is held until importPrivateKey(B) has completed.
  it("a send whose signing is in flight when importPrivateKey(B) lands is not broadcast", async () => {
    const rpc = stubRpc(false);
    const wallet = makeWallet();
    await wallet.importPrivateKey(KEY_A);

    type SignFn = (...args: unknown[]) => Promise<unknown>;
    const signer = (
      wallet as unknown as {
        activeSigner(): { signTransaction: SignFn };
      }
    ).activeSigner();
    const original = signer.signTransaction.bind(signer);
    let signEntered!: () => void;
    let releaseSign!: () => void;
    const entered = new Promise<void>((resolve) => {
      signEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseSign = resolve;
    });
    vi.spyOn(signer, "signTransaction").mockImplementation(async (...args) => {
      signEntered();
      await released;
      return original(...args);
    });

    const sending = wallet.sendTransaction({ ...TX });
    await entered;
    expect(rpc.nonceAccounts).toEqual([ADDRESS_A]);
    await wallet.importPrivateKey(KEY_B);
    expect(wallet.address?.toLowerCase()).toBe(ADDRESS_B);
    releaseSign();
    const [outcome] = await Promise.allSettled([sending]);

    expect(rpc.raw).toEqual([]);
    expect(outcome.status).toBe("rejected");
    expect((outcome as PromiseRejectedResult).reason).toMatchObject({
      code: "tx_failed",
    });
    expect(rpc.unexpected).toEqual([]);
  });
});

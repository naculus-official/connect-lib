import { afterEach, describe, expect, it, vi } from "vitest";
import { EVMSigner } from "../signers/evm";
import type { StorageAdapter } from "../storage/types";
import type { WalletData } from "../wallet";
import { PocketWallet } from "../wallet";

/**
 * Worker isolation across a reload, driven through the real crypto-worker
 * module.
 *
 * The worker was started with the *active* account's key. A wallet saved
 * while Solana was active therefore reloaded with the Solana seed inside the
 * EVM worker, and every EVM signature afterwards recovered to an address the
 * wallet does not hold. The mock workers in isolation.test.ts return a canned
 * signature, so they could not see which key signed.
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
  async save(data: WalletData) {
    this.d = data;
  }
  async clear() {
    this.d = null;
  }
}

async function installRealWorker(): Promise<void> {
  let current: { onmessage: ((e: { data: unknown }) => void) | null } | null =
    null;
  vi.stubGlobal("self", {
    onmessage: null,
    postMessage: (data: unknown) => current?.onmessage?.({ data }),
  });
  vi.resetModules();
  await import("../signers/crypto-worker");
  const workerOnMessage = (
    globalThis as unknown as {
      self: { onmessage: (e: { data: unknown }) => Promise<void> };
    }
  ).self.onmessage;

  class RealWorker {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onmessageerror: ((e: unknown) => void) | null = null;
    constructor() {
      current = this;
    }
    postMessage(msg: unknown): void {
      void workerOnMessage({ data: msg });
    }
    terminate(): void {}
  }
  vi.stubGlobal("Worker", RealWorker);
}

describe("worker isolation across a reload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs EVM with the EVM key after reloading a wallet saved with Solana active", async () => {
    await installRealWorker();
    const storage = new MemoryStorage();

    const first = new PocketWallet({
      storage,
      isolation: "worker",
      autoSave: false,
    });
    await first.importMnemonic(MNEMONIC);
    first.setActiveNamespace("solana");
    await first.save();

    // Leave an unrelated EVM key in the (shared) worker module, so the test
    // also fails if load() stops starting the worker at all.
    const other = new PocketWallet({
      storage: new MemoryStorage(),
      isolation: "worker",
      autoSave: false,
    });
    await other.importPrivateKey(`0x${"cd".repeat(32)}`);

    const reloaded = new PocketWallet({
      storage,
      isolation: "worker",
      autoSave: false,
    });
    expect(await reloaded.load()).toBe(true);
    reloaded.setActiveNamespace("eip155");

    const evm = reloaded.account("eip155");
    expect(evm).not.toBeNull();
    // RFC 6979 signatures are deterministic: the worker's output equals the
    // in-process signer's only if it holds the EVM account's key.
    const expected = await new EVMSigner().signMessage(
      { message: "which key?" },
      evm?.privateKey as `0x${string}`,
    );
    const actual = await reloaded.signMessage("which key?");
    expect(actual.signature).toBe(expected.signature);
  });
});

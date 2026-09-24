import {
  type StorageAdapter as CoreStorageAdapter,
  estimateFees,
  MemoryStorageAdapter,
  sessionKeyAddress,
} from "@naculus/connect-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEGACY_SESSION_KEYS_STORAGE_KEY } from "../session-keys/embedded";
import { EVMSigner } from "../signers/evm";
import type { StorageAdapter } from "../storage/types";
import type { WalletData } from "../wallet";
import { PocketWallet } from "../wallet";

/**
 * The embedded wallet's session keys run on connect-core's engine. Each
 * control below was missing from wallet-engine's old copy
 * (docs/design/session-keys-convergence.md).
 */

vi.mock("@naculus/connect-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@naculus/connect-core")>()),
  estimateFees: vi.fn(),
}));

class MemoryWalletStorage implements StorageAdapter {
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

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as const;
const PAYEE = "0x2222222222222222222222222222222222222222" as const;
const TX_HASH = `0x${"ff".repeat(32)}`;

function transferData(to: string, amount: bigint): string {
  return `0xa9059cbb${to.slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
}

async function wallet(
  storage: CoreStorageAdapter = new MemoryStorageAdapter(),
) {
  const w = new PocketWallet({
    storage: new MemoryWalletStorage(),
    autoSave: false,
    chainId: "eip155:1",
    rpcUrl: "https://rpc.invalid",
    sessionKeys: {
      storage,
      config: { pbkdf2Iterations: 1_000, unsafeAllowWeakKdf: true },
    },
  });
  await w.importMnemonic(MNEMONIC);
  return w;
}

function mockRpc() {
  vi.mocked(estimateFees).mockResolvedValue({
    type: "eip1559",
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  const calls: { method: string; params: unknown[] }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, opts) => {
    const body = JSON.parse((opts as RequestInit).body as string);
    calls.push({ method: body.method, params: body.params });
    const result =
      body.method === "eth_getTransactionCount"
        ? "0x3"
        : body.method === "eth_estimateGas"
          ? "0xea60"
          : body.method === "eth_sendRawTransaction"
            ? TX_HASH
            : null;
    return {
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: body.id, result }),
    } as Response;
  });
  return calls;
}

describe("PocketWallet session keys on the core engine", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("authorizes a new key with the wallet's EVM account", async () => {
    const w = await wallet();
    const info = await w.createSessionKey({
      allowedContracts: [USDC],
    } as never);
    expect(info.authorized).toBe(true);
    expect(info.signerAddress.toLowerCase()).toBe(
      w.account("eip155")?.address.toLowerCase(),
    );
    expect(await w.listSessions()).toHaveLength(1);
  });

  it("sends from the session key's own address, signing the transaction it checked", async () => {
    const storage = new MemoryStorageAdapter();
    const w = await wallet(storage);
    const info = await w.createSessionKey({
      allowedContracts: [USDC],
      tokenAllowances: { [USDC]: 1_000n },
    } as never);
    const calls = mockRpc();
    const data = transferData(PAYEE, 400n);

    const result = await w.sendWithSession(info.id, { to: USDC, data });
    const self = sessionKeyAddress(info.publicKey);
    expect(result.hash).toBe(TX_HASH);
    expect(result.from).toBe(self);
    expect(
      calls.find((c) => c.method === "eth_getTransactionCount")?.params,
    ).toEqual([self, "pending"]);
    const estimate = calls.find((c) => c.method === "eth_estimateGas");
    expect(estimate?.params[0]).toMatchObject({ from: self });

    // Byte-identical to signing the same transaction with the session key
    // directly: core signed exactly the hash of what was built here.
    const { createEmbeddedSessionKeyManager } = await import(
      "../session-keys/embedded"
    );
    const bip39 = await import("@scure/bip39");
    const mgr = createEmbeddedSessionKeyManager(
      await bip39.mnemonicToSeed(MNEMONIC),
      {
        storage,
        config: { pbkdf2Iterations: 1_000, unsafeAllowWeakKdf: true },
      },
    );
    const { privateKey } = await mgr.getSessionBundle(info.id);
    const { signature: expected } = await new EVMSigner().signTransaction(
      {
        to: USDC,
        data,
        nonce: "0x3",
        gas: "0xea60",
        chainId: 1,
        maxFeePerGas: "0x6fc23ac00",
        maxPriorityFeePerGas: "0x3b9aca00",
      },
      privateKey,
    );
    expect(
      calls.find((c) => c.method === "eth_sendRawTransaction")?.params,
    ).toEqual([expected]);
  });

  it("enforces token allowances", async () => {
    const w = await wallet();
    const info = await w.createSessionKey({
      allowedContracts: [USDC],
      tokenAllowances: { [USDC]: 1_000n },
    } as never);
    const calls = mockRpc();
    await expect(
      w.sendWithSession(info.id, {
        to: USDC,
        data: transferData(PAYEE, 1_001n),
      }),
    ).rejects.toMatchObject({ code: "session_key_scope_exceeded" });
    expect(calls.map((c) => c.method)).not.toContain("eth_sendRawTransaction");
  });

  it("refuses forbidden selectors such as approve", async () => {
    const w = await wallet();
    const info = await w.createSessionKey({
      allowedContracts: [USDC],
    } as never);
    const calls = mockRpc();
    const approve = `0x095ea7b3${PAYEE.slice(2).padStart(64, "0")}${"f".repeat(64)}`;
    await expect(
      w.sendWithSession(info.id, { to: USDC, data: approve }),
    ).rejects.toMatchObject({ code: "session_key_scope_exceeded" });
    expect(calls.map((c) => c.method)).not.toContain("eth_sendRawTransaction");
  });

  it("withholds the signature when usage cannot be recorded", async () => {
    const backing = new MemoryStorageAdapter();
    let failWrites = false;
    const flaky: CoreStorageAdapter = {
      get: (key) => backing.get(key),
      set: async (key, value) => {
        if (failWrites) throw new Error("quota exceeded");
        return backing.set(key, value);
      },
      remove: (key) => backing.remove(key),
      clear: () => backing.clear(),
      has: (key) => backing.has(key),
      isAvailable: () => true,
    };
    const w = await wallet(flaky);
    const info = await w.createSessionKey({
      allowedContracts: [USDC],
    } as never);
    const calls = mockRpc();
    failWrites = true;
    await expect(
      w.sendWithSession(info.id, { to: USDC, data: transferData(PAYEE, 1n) }),
    ).rejects.toThrow();
    expect(calls.map((c) => c.method)).not.toContain("eth_sendRawTransaction");
  });

  it("refuses a transaction for another chain before any RPC call", async () => {
    const w = await wallet();
    const info = await w.createSessionKey({
      allowedContracts: [USDC],
    } as never);
    const calls = mockRpc();
    await expect(
      w.sendWithSession(info.id, { to: USDC, chainId: 10, data: "0x" }),
    ).rejects.toMatchObject({ code: "chain_mismatch" });
    expect(calls).toEqual([]);
  });

  it("refuses an unknown session before any RPC call", async () => {
    const w = await wallet();
    const calls = mockRpc();
    await expect(
      w.sendWithSession("sk_missing", { to: USDC, data: "0x" }),
    ).rejects.toMatchObject({ code: "session_not_found" });
    expect(calls).toEqual([]);
  });

  it("leaves 0.2.x records in place: they are the only copy of funded keys", async () => {
    const legacy = JSON.stringify([{ id: "old" }]);
    const items = new Map<string, string>([
      [LEGACY_SESSION_KEYS_STORAGE_KEY, legacy],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => items.set(k, v),
      removeItem: (k: string) => items.delete(k),
    });
    const w = await wallet();
    await w.createSessionKey({ allowedContracts: [USDC] } as never);
    await w.listSessions();
    expect(items.get(LEGACY_SESSION_KEYS_STORAGE_KEY)).toBe(legacy);
  });

  it("signs the authorization with the wallet's EVM key", async () => {
    const storage = new MemoryStorageAdapter();
    const w = await wallet(storage);
    const info = await w.createSessionKey({
      allowedContracts: [USDC],
    } as never);
    const { createEmbeddedSessionKeyManager } = await import(
      "../session-keys/embedded"
    );
    const bip39 = await import("@scure/bip39");
    const mgr = createEmbeddedSessionKeyManager(
      await bip39.mnemonicToSeed(MNEMONIC),
      {
        storage,
        config: { pbkdf2Iterations: 1_000, unsafeAllowWeakKdf: true },
      },
    );
    const { authorization } = await mgr.getSessionBundle(info.id);
    const expected = await new EVMSigner().signMessage(
      { message: authorization.message as string },
      w.account("eip155")?.privateKey as `0x${string}`,
    );
    expect(authorization.rawSignature).toBe(expected.signature);
    expect(authorization.message).toContain(sessionKeyAddress(info.publicKey));
  });

  it("revokes a key whose authorization cannot be signed", async () => {
    const storage = new MemoryStorageAdapter();
    const refusing = new EVMSigner();
    refusing.signMessage = async () => {
      throw new Error("user rejected");
    };
    const w = new PocketWallet({
      storage: new MemoryWalletStorage(),
      autoSave: false,
      signer: refusing,
      sessionKeys: {
        storage,
        config: { pbkdf2Iterations: 1_000, unsafeAllowWeakKdf: true },
      },
    });
    await w.importMnemonic(MNEMONIC);
    await expect(
      w.createSessionKey({ allowedContracts: [USDC] } as never),
    ).rejects.toThrow("user rejected");
    const sessions = await w.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe("revoked");
  });

  it("creates offchain keys only", async () => {
    const w = await wallet();
    await expect(
      w.createSessionKey({
        allowedContracts: [USDC],
        mode: "eip7702",
      } as never),
    ).rejects.toMatchObject({ code: "method_not_allowed" });
  });

  it("previews another chain as invalid, as the send would refuse it", async () => {
    const w = await wallet();
    const info = await w.createSessionKey({
      allowedContracts: [USDC],
    } as never);
    await expect(
      w.checkSessionScope(info.id, { to: USDC, chainId: 10, data: "0x" }),
    ).resolves.toMatchObject({ valid: false });
  });

  it("rebuilds the manager for another wallet and drops it on destroySession", async () => {
    const storage = new MemoryStorageAdapter();
    const w = await wallet(storage);
    const info = await w.createSessionKey({
      allowedContracts: [USDC],
    } as never);
    // Another wallet on the same storage cannot use the first one's key.
    await w.importMnemonic(
      "legal winner thank year wave sausage worth useful legal winner thank yellow",
    );
    mockRpc();
    await expect(
      w.sendWithSession(info.id, { to: USDC, data: transferData(PAYEE, 1n) }),
    ).rejects.toThrow();
    w.destroySession();
    expect((w as unknown as { _sessionMgr: unknown })._sessionMgr).toBeNull();
    expect(
      (w as unknown as { _sessionMgrWallet: unknown })._sessionMgrWallet,
    ).toBeNull();
  });

  it("requires a mnemonic", async () => {
    const w = new PocketWallet({
      storage: new MemoryWalletStorage(),
      autoSave: false,
      sessionKeys: { storage: new MemoryStorageAdapter() },
    });
    await w.importPrivateKey(`0x${"ab".repeat(32)}`);
    await expect(
      w.createSessionKey({ allowedContracts: [USDC] } as never),
    ).rejects.toMatchObject({ code: "no_wallet" });
    expect(await w.listSessions()).toEqual([]);
  });
});

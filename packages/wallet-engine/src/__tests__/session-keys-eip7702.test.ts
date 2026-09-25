import {
  DELEGATION_FRAMEWORK,
  estimateFees,
  MemoryStorageAdapter,
  type SessionKeyManager,
  sessionKeyAddress,
} from "@naculus/connect-core";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  serializeSignedTransaction,
  transactionSigningHash,
} from "../signers/evm-tx";
import { IsolatedSigner } from "../signers/isolated-signer";
import type { StorageAdapter } from "../storage/types";
import type { WalletData } from "../wallet";
import { PocketWallet } from "../wallet";

/**
 * Thread 17 package 3: eip7702 session keys in the embedded wallet
 * (in-process signer). The wallet's own account must already delegate to
 * EIP7702StatelessDeleGatorImpl; the session key then sends redemptions.
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
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const PAYEE = "0x2222222222222222222222222222222222222222" as const;
const OTHER = "0x3333333333333333333333333333333333333333" as const;
const TX_HASH = `0x${"ff".repeat(32)}`;
const DELEGATED_CODE = `0xef0100${DELEGATION_FRAMEWORK.eip7702StatelessDeleGator.slice(2).toLowerCase()}`;

const scope = {
  mode: "eip7702",
  allowedContracts: [USDC],
  allowedMethods: ["0xa9059cbb"],
  tokenAllowances: { [USDC]: 1_000n },
  allowedRecipients: [PAYEE],
} as never;

function transferData(to: string, amount: bigint): `0x${string}` {
  return `0xa9059cbb${to.slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
}

function mockRpc(code: string | null = DELEGATED_CODE) {
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
      body.method === "eth_getCode"
        ? code
        : body.method === "eth_getTransactionCount"
          ? "0x3"
          : body.method === "eth_estimateGas"
            ? "0x30d40"
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

async function wallet(options: { isolation?: "worker" } = {}) {
  const w = new PocketWallet({
    storage: new MemoryWalletStorage(),
    autoSave: false,
    chainId: "eip155:8453",
    rpcUrl: "https://rpc.invalid",
    ...options,
    sessionKeys: {
      storage: new MemoryStorageAdapter(),
      config: { pbkdf2Iterations: 1_000, unsafeAllowWeakKdf: true },
    },
  });
  await w.importMnemonic(MNEMONIC);
  return w;
}

const manager = (w: PocketWallet) =>
  (w as unknown as { _sessionMgr: SessionKeyManager })._sessionMgr;

describe("PocketWallet eip7702 session keys", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // The worker test stubs self/Worker; never let a failure leak them.
    vi.unstubAllGlobals();
  });

  it("creates a key authorized by the wallet's signed delegation", async () => {
    const w = await wallet();
    mockRpc();
    const info = await w.createSessionKey(scope);
    expect(info.authorized).toBe(true);
    expect(info.scope.mode).toBe("eip7702");
  });

  it("refuses when the account is not delegated to the stateless DeleGator", async () => {
    const w = await wallet();
    // No code, another delegate, and an unreadable answer all refuse.
    for (const code of ["0x", `0xef0100${"11".repeat(20)}`, null]) {
      mockRpc(code);
      await expect(w.createSessionKey(scope)).rejects.toMatchObject({
        code: "method_not_allowed",
      });
      vi.restoreAllMocks();
    }
    expect(await w.listSessions()).toEqual([]);
  });

  it("works with worker isolation: the worker signs the delegation", async () => {
    // Drive the real crypto-worker module (as isolation-reload.test.ts does).
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

    const w = await wallet({ isolation: "worker" });
    expect((w as unknown as { _signer: unknown })._signer).toBeInstanceOf(
      IsolatedSigner,
    );
    mockRpc();
    const info = await w.createSessionKey(scope);
    // attachDelegation verified the worker's signature against the owner.
    expect(info.authorized).toBe(true);
    vi.unstubAllGlobals();
  });

  it("sends the redemption from the session key, signed over exactly that transaction", async () => {
    const w = await wallet();
    mockRpc();
    const info = await w.createSessionKey(scope);
    const calls = mockRpc();
    const spy = vi.spyOn(manager(w), "signDelegationRedemption");
    const data = transferData(PAYEE, 400n);

    const result = await w.sendWithSession(info.id, { to: USDC, data });
    const self = sessionKeyAddress(info.publicKey);
    expect(result.from).toBe(self);
    expect(result.hash).toBe(TX_HASH);
    expect(
      calls.find((c) => c.method === "eth_getTransactionCount")?.params,
    ).toEqual([self, "pending"]);

    const [, digest, outer, execution] = spy.mock.calls[0]!;
    expect(execution).toEqual({ target: USDC, value: 0n, callData: data });
    expect(outer.to).toBe(DELEGATION_FRAMEWORK.delegationManager);
    const expectedTx = {
      to: DELEGATION_FRAMEWORK.delegationManager,
      value: "0x0",
      data: outer.data,
      nonce: "0x3",
      gas: "0x30d40",
      chainId: 8453,
      maxFeePerGas: "0x6fc23ac00",
      maxPriorityFeePerGas: "0x3b9aca00",
    };
    // The digest core signed is the hash of the transaction that was sent.
    expect(digest).toBe(`0x${bytesToHex(transactionSigningHash(expectedTx))}`);
    const signature = (await spy.mock.results[0]!.value) as string;
    const sig = hexToBytes(signature.slice(2));
    const recovered = secp256k1.Signature.fromBytes(sig.slice(0, 64), "compact")
      .addRecoveryBit(sig[64]! - 27)
      .recoverPublicKey(hexToBytes(digest.slice(2)));
    expect(sessionKeyAddress(`0x${recovered.toHex(true)}`)).toBe(self);
    expect(
      calls.find((c) => c.method === "eth_sendRawTransaction")?.params,
    ).toEqual([
      serializeSignedTransaction(expectedTx, {
        r: `0x${signature.slice(2, 66)}`,
        s: `0x${signature.slice(66, 130)}`,
        yParity: (sig[64]! - 27) as 0 | 1,
      }),
    ]);
  });

  it("refuses an execution outside the scope before broadcasting", async () => {
    const w = await wallet();
    mockRpc();
    const info = await w.createSessionKey(scope);
    const calls = mockRpc();
    await expect(
      w.sendWithSession(info.id, { to: USDC, data: transferData(OTHER, 1n) }),
    ).rejects.toMatchObject({ code: "session_key_scope_exceeded" });
    expect(calls.map((c) => c.method)).not.toContain("eth_sendRawTransaction");
  });

  it("refuses when the configured chain is not the delegation's", async () => {
    const w = await wallet();
    mockRpc();
    const info = await w.createSessionKey(scope);
    w.setChain("eip155:1");
    const calls = mockRpc();
    await expect(
      w.sendWithSession(info.id, { to: USDC, data: transferData(PAYEE, 1n) }),
    ).rejects.toMatchObject({ code: "chain_mismatch" });
    expect(calls.map((c) => c.method)).not.toContain("eth_sendRawTransaction");
  });

  it("checks a gas-limited scope against the redemption's gas", async () => {
    const w = await wallet();
    mockRpc();
    const info = await w.createSessionKey({
      ...(scope as object),
      maxGasPerTx: 100_000n,
    } as never);
    // The mocked estimate is 200_000 gas: over the limit, refused before
    // broadcasting (previously every send failed for lack of a gas figure).
    const calls = mockRpc();
    await expect(
      w.sendWithSession(info.id, { to: USDC, data: transferData(PAYEE, 1n) }),
    ).rejects.toMatchObject({ code: "session_key_scope_exceeded" });
    expect(calls.map((c) => c.method)).not.toContain("eth_sendRawTransaction");

    const roomy = await w.createSessionKey({
      ...(scope as object),
      maxGasPerTx: 300_000n,
    } as never);
    mockRpc();
    await expect(
      w.sendWithSession(roomy.id, { to: USDC, data: transferData(PAYEE, 1n) }),
    ).resolves.toMatchObject({ hash: TX_HASH });
  });
});

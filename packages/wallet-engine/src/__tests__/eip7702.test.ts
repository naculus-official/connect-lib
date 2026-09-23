import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateFees } from "@naculus/connect-core";
import type { StorageAdapter } from "../storage/types";
import type { WalletData } from "../wallet";
import { PocketWallet } from "../wallet";

vi.mock("@naculus/connect-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@naculus/connect-core")>()),
  estimateFees: vi.fn(),
}));

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

const PK = `0x${"ab".repeat(32)}`;
const DELEGATE = "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
// viem 2.56.5 signature for this key and authorization; see
// signers/evm-tx.test.ts.
const SIGNED_AUTH = {
  chainId: 1,
  address: DELEGATE,
  nonce: "0x7",
  yParity: 1 as const,
  r: "0x8590d30e098d3e27cd8e83b30b6965999605a2129f77b170dec7af1762a9e1c5" as const,
  s: "0x41f93e1aa5100e4ff37f1cf8c61d39d289b93cb994cbd27bc62db429919c149b" as const,
};

async function wallet(): Promise<PocketWallet> {
  const w = new PocketWallet({
    storage: new MemoryStorage(),
    autoSave: false,
    chainId: "eip155:1",
    rpcUrl: "https://rpc.invalid",
  });
  await w.importPrivateKey(PK);
  return w;
}

describe("PocketWallet EIP-7702", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("signs an authorization for the configured chain", async () => {
    const w = await wallet();
    await expect(
      w.signAuthorization({ chainId: 1, address: DELEGATE, nonce: "0x7" }),
    ).resolves.toEqual(SIGNED_AUTH);
  });

  it("refuses an authorization for another chain", async () => {
    const w = await wallet();
    await expect(
      w.signAuthorization({ chainId: 10, address: DELEGATE, nonce: "0x7" }),
    ).rejects.toMatchObject({ code: "chain_mismatch" });
  });

  it("refuses an any-chain authorization unless explicitly allowed", async () => {
    const w = await wallet();
    const anyChain = { chainId: 0, address: DELEGATE, nonce: "0x1" };
    await expect(w.signAuthorization(anyChain)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      w.signAuthorization(anyChain, { unsafeAllowAnyChainAuthorization: true }),
    ).resolves.toMatchObject({ chainId: 0 });
  });

  it("signs a type-4 transaction through signTransaction", async () => {
    const w = await wallet();
    const { signature } = await w.signTransaction({
      type: "eip7702",
      chainId: 1,
      nonce: "0x6",
      maxPriorityFeePerGas: "0x3b9aca00",
      maxFeePerGas: "0x6fc23ac00",
      gas: "0x186a0",
      to: w.address as string,
      value: "0x0",
      data: "0xdeadbeef",
      authorizationList: [SIGNED_AUTH],
    });
    expect(signature.startsWith("0x04")).toBe(true);
  });

  /**
   * These paths rebuild the request field by field and would drop `type` and
   * `authorizationList`, broadcasting a type-2 transaction with no
   * delegation. They must refuse before any RPC call.
   */
  describe("send paths refuse a type-4 transaction", () => {
    const setCode = {
      type: "eip7702" as const,
      to: DELEGATE,
      maxFeePerGas: "0x1",
      authorizationList: [SIGNED_AUTH],
    };

    it.each([
      ["sendTransaction", (w: PocketWallet) => w.sendTransaction(setCode)],
      ["bumpFee", (w: PocketWallet) => w.bumpFee(setCode)],
      [
        "sendWithSession",
        (w: PocketWallet) => w.sendWithSession("any-session", setCode),
      ],
      [
        "sendTransaction with only an authorizationList",
        (w: PocketWallet) =>
          w.sendTransaction({
            to: DELEGATE,
            authorizationList: [SIGNED_AUTH],
          }),
      ],
    ])("%s", async (_name, send) => {
      const w = await wallet();
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      await expect(send(w)).rejects.toMatchObject({
        code: "method_unsupported",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("sendDelegation", () => {
    const TX_HASH = `0x${"ff".repeat(32)}`;

    function mockRpc() {
      const calls: { method: string; params: unknown[] }[] = [];
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (_url, opts) => {
          const body = JSON.parse((opts as RequestInit).body as string);
          calls.push({ method: body.method, params: body.params });
          const result =
            body.method === "eth_estimateGas"
              ? "0xb3b0"
              : body.method === "eth_sendRawTransaction"
                ? TX_HASH
                : null;
          return {
            ok: true,
            json: async () => ({ jsonrpc: "2.0", id: body.id, result }),
          } as Response;
        });
      return { calls, spy };
    }

    function eip1559Fees() {
      vi.mocked(estimateFees).mockResolvedValue({
        type: "eip1559",
        maxFeePerGas: 30_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      });
    }

    it("sends its own authorization in a type-4 transaction to itself", async () => {
      const w = await wallet();
      eip1559Fees();
      const { calls } = mockRpc();

      const result = await w.sendDelegation(
        { chainId: 1, address: DELEGATE, nonce: "0x7" },
        { transactionNonce: "0x6" },
      );

      expect(result.hash).toBe(TX_HASH);
      expect(result.to).toBe(w.address);
      expect(result.authorization).toEqual(SIGNED_AUTH);

      const estimate = calls.find((c) => c.method === "eth_estimateGas");
      expect(estimate?.params[0]).toEqual({
        from: w.address,
        to: w.address,
        value: "0x0",
        data: "0x",
        authorizationList: [{ ...SIGNED_AUTH, chainId: "0x1", yParity: "0x1" }],
      });

      // The broadcast bytes are exactly what signTransaction produces for
      // the intended fields: nonce 6, self-call, the one authorization.
      const { signature: expected } = await w.signTransaction({
        type: "eip7702",
        chainId: 1,
        nonce: "0x6",
        maxPriorityFeePerGas: "0x3b9aca00",
        maxFeePerGas: "0x6fc23ac00",
        gas: "0xb3b0",
        to: w.address as string,
        value: "0x0",
        data: "0x",
        authorizationList: [SIGNED_AUTH],
      });
      const sent = calls.find((c) => c.method === "eth_sendRawTransaction");
      expect(sent?.params).toEqual([expected]);
    });

    it("estimates with r and s as quantities (geth rejects leading zeros)", async () => {
      const w = await wallet();
      eip1559Fees();
      const { calls } = mockRpc();
      // This key's signature at nonce 0x16 has a leading zero in both r and s.
      await w.sendDelegation(
        { chainId: 1, address: DELEGATE, nonce: "0x16" },
        { transactionNonce: "0x15" },
      );
      const estimate = calls.find((c) => c.method === "eth_estimateGas");
      expect(estimate?.params[0]).toMatchObject({
        authorizationList: [
          {
            r: "0x8216fa55e15aa54f5b9d490abd814c4d2782e0427cb5c964d12180a449ae9eb",
            s: "0xcfb83cc789645dc0a2bb00e321f7927034ae02d28806320c6de277e0f5405c9",
          },
        ],
      });
    });

    it("sends nothing when the wallet is re-keyed mid-flow", async () => {
      const w = await wallet();
      eip1559Fees();
      const { calls } = mockRpc();
      const fetchMock = vi.mocked(globalThis.fetch);
      const answer = fetchMock.getMockImplementation();
      // An import lands while the gas estimate is in flight. With worker
      // isolation the worker would then sign with the new key.
      fetchMock.mockImplementation(async (url, opts) => {
        const body = JSON.parse((opts as RequestInit).body as string);
        if (body.method === "eth_estimateGas") {
          await w.importPrivateKey(`0x${"cd".repeat(32)}`);
        }
        return answer!(url, opts);
      });
      await expect(
        w.sendDelegation(
          { chainId: 1, address: DELEGATE, nonce: "0x7" },
          { transactionNonce: "0x6" },
        ),
      ).rejects.toMatchObject({ code: "tx_failed" });
      expect(calls.map((c) => c.method)).not.toContain(
        "eth_sendRawTransaction",
      );
    });

    it.each([
      ["authorization nonce equal to the transaction's", "0x6", "0x6"],
      ["non-canonical authorization nonce", "0x07", "0x6"],
      ["authorization nonce two above", "0x8", "0x6"],
      ["non-canonical transaction nonce", "0x7", "0x06"],
    ])("refuses %s before any RPC call", async (_name, nonce, txNonce) => {
      const w = await wallet();
      const { spy } = mockRpc();
      await expect(
        w.sendDelegation(
          { chainId: 1, address: DELEGATE, nonce },
          { transactionNonce: txNonce },
        ),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(spy).not.toHaveBeenCalled();
    });

    it.each([
      ["another chain", 5],
      ["any chain", 0],
    ])("refuses an authorization for %s", async (_name, chainId) => {
      const w = await wallet();
      const { spy } = mockRpc();
      await expect(
        w.sendDelegation(
          { chainId, address: DELEGATE, nonce: "0x7" },
          { transactionNonce: "0x6" },
        ),
      ).rejects.toMatchObject({ code: "chain_mismatch" });
      expect(spy).not.toHaveBeenCalled();
    });

    it("refuses legacy fees", async () => {
      const w = await wallet();
      const { spy } = mockRpc();
      await expect(
        w.sendDelegation(
          { chainId: 1, address: DELEGATE, nonce: "0x7" },
          { transactionNonce: "0x6" },
          { type: "legacy" },
        ),
      ).rejects.toMatchObject({ code: "invalid_fee" });
      expect(spy).not.toHaveBeenCalled();
    });

    it("does not downgrade to legacy fees when estimation fails", async () => {
      const w = await wallet();
      vi.mocked(estimateFees).mockRejectedValue(new Error("no feeHistory"));
      const { calls } = mockRpc();
      await expect(
        w.sendDelegation(
          { chainId: 1, address: DELEGATE, nonce: "0x7" },
          { transactionNonce: "0x6" },
        ),
      ).rejects.toMatchObject({ code: "fee_estimation_failed" });
      expect(calls.map((c) => c.method)).not.toContain(
        "eth_sendRawTransaction",
      );
    });
  });
});

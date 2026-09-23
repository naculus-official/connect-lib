import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../storage/types";
import type { WalletData } from "../wallet";
import { PocketWallet } from "../wallet";

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
});

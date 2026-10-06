import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../storage/types";
import type { WalletData } from "../wallet";
import { PocketWallet } from "../wallet";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TOKEN = `0x${"11".repeat(20)}` as `0x${string}`;
const RECIPIENT = `0x${"22".repeat(20)}` as `0x${string}`;

class MemoryStorage implements StorageAdapter {
  readonly type = "memory" as const;
  private data: WalletData | null = null;
  isAvailable() {
    return true;
  }
  async load() {
    return this.data;
  }
  async save(data: WalletData) {
    this.data = data;
  }
  async clear() {
    this.data = null;
  }
}

describe("PocketWallet ERC-20 chain context", () => {
  let wallet: PocketWallet;

  beforeEach(async () => {
    wallet = new PocketWallet({
      chainId: "eip155:1",
      rpcUrl: "http://rpc.test",
      storage: new MemoryStorage(),
      autoSave: false,
    });
    await wallet.importMnemonic(MNEMONIC);
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(["transfer", "approve"] as const)(
    "rejects a mismatched %s before RPC without changing wallet chain state",
    async (operation) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const dataChainId = wallet.getWalletData()!.chainId;

      const promise =
        operation === "transfer"
          ? wallet.sendERC20Transfer(137, TOKEN, RECIPIENT, "1")
          : wallet.sendERC20Approve(137, TOKEN, RECIPIENT, "1");

      await expect(promise).rejects.toMatchObject({ code: "chain_mismatch" });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(wallet.state.chainId).toBe("eip155:1");
      expect(wallet.getWalletData()!.chainId).toBe(dataChainId);
    },
  );

  it.each(["transfer", "approve"] as const)(
    "keeps matching-chain %s behavior and chain state unchanged",
    async (operation) => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (_url, init) => {
          const request = JSON.parse(String(init?.body));
          const result =
            request.method === "eth_call"
              ? "0x06"
              : request.method === "eth_getTransactionCount"
                ? "0x1"
                : request.method === "eth_estimateGas"
                  ? "0x10000"
                  : request.method === "eth_gasPrice"
                    ? "0x3b9aca00"
                    : request.method === "eth_sendRawTransaction"
                      ? `0x${"ab".repeat(32)}`
                      : null;
          return {
            ok: true,
            json: async () => ({ jsonrpc: "2.0", id: request.id, result }),
          } as Response;
        });
      const dataChainId = wallet.getWalletData()!.chainId;

      const result =
        operation === "transfer"
          ? await wallet.sendERC20Transfer(1, TOKEN, RECIPIENT, "1")
          : await wallet.sendERC20Approve(1, TOKEN, RECIPIENT, "1");

      expect(result.hash).toBe(`0x${"ab".repeat(32)}`);
      expect(fetchSpy).toHaveBeenCalled();
      expect(wallet.state.chainId).toBe("eip155:1");
      expect(wallet.getWalletData()!.chainId).toBe(dataChainId);
    },
  );
});

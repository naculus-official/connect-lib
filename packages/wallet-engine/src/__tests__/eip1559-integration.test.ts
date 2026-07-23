import { describe, it, expect, vi, beforeEach } from "vitest";
import { PocketWallet } from "../wallet";
import type { WalletData } from "../wallet";
import { WalletError } from "../errors";
import type { StorageAdapter } from "../storage/types";

// Mock the core fee estimation module
vi.mock("@naculus/connect-core", () => ({
  estimateFees: vi.fn(),
}));

import { estimateFees } from "@naculus/connect-core";

// Mock storage
class MockStorage implements StorageAdapter {
  private data: WalletData | null = null;
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

const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function mockRpc(handler: (method: string, params: unknown[]) => unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, opts) => {
    const body = JSON.parse((opts as RequestInit).body as string);
    const result = handler(body.method, body.params);
    return {
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: body.id, result }),
    } as Response;
  });
}

describe("EIP-1559 Integration", () => {
  let wallet: PocketWallet;

  beforeEach(async () => {
    vi.clearAllMocks();
    wallet = new PocketWallet({
      rpcUrl: "https://eth.llamarpc.com",
      storage: new MockStorage(),
      autoSave: false,
    });
    await wallet.importMnemonic(TEST_MNEMONIC);
  });

  describe("sendTransaction with EIP-1559 (auto estimation)", () => {
    it("should use estimated fees when no fee fields provided", async () => {
      (estimateFees as ReturnType<typeof vi.fn>).mockResolvedValue({
        type: "eip1559",
        maxFeePerGas: 15000000000n,
        maxPriorityFeePerGas: 1000000000n,
      });

      const rpcMock = mockRpc((method) => {
        switch (method) {
          case "eth_getTransactionCount": return "0x5";
          case "eth_estimateGas": return "0x5208";
          case "eth_sendRawTransaction": return "0x" + "ff".repeat(32);
          default: return null;
        }
      });

      const result = await wallet.sendTransaction({
        to: "0x" + "ab".repeat(20),
        value: "0xde0b6b3a7640000", // 0.1 ETH
      });

      expect(result.hash).toBe("0x" + "ff".repeat(32));
      expect(result.maxFeePerGas).toBe("0x" + 15000000000n.toString(16));
      expect(result.maxPriorityFeePerGas).toBe("0x" + 1000000000n.toString(16));
      // Should not have gasPrice in result for EIP-1559
      expect(result.gasPrice).toBeUndefined();
      expect(estimateFees).toHaveBeenCalledOnce();

      rpcMock.mockRestore();
    });
  });

  describe("sendTransaction with EIP-1559 (user override)", () => {
    it("should use user-provided maxFeePerGas and maxPriorityFeePerGas", async () => {
      const rpcMock = mockRpc((method) => {
        switch (method) {
          case "eth_getTransactionCount": return "0x5";
          case "eth_estimateGas": return "0x5208";
          case "eth_sendRawTransaction": return "0x" + "ee".repeat(32);
          default: return null;
        }
      });

      const result = await wallet.sendTransaction({
        to: "0x" + "cd".repeat(20),
        value: "0x0",
        maxFeePerGas: "0x59682f00",
        maxPriorityFeePerGas: "0x3b9aca00",
      });

      expect(result.hash).toBe("0x" + "ee".repeat(32));
      expect(result.maxFeePerGas).toBe("0x59682f00");
      expect(result.maxPriorityFeePerGas).toBe("0x3b9aca00");
      // Should NOT call estimateFees since user provided values
      expect(estimateFees).not.toHaveBeenCalled();

      rpcMock.mockRestore();
    });

    it("should use user-provided gasPrice for legacy", async () => {
      const rpcMock = mockRpc((method) => {
        switch (method) {
          case "eth_getTransactionCount": return "0x5";
          case "eth_estimateGas": return "0x5208";
          case "eth_sendRawTransaction": return "0x" + "dd".repeat(32);
          default: return null;
        }
      });

      const result = await wallet.sendTransaction({
        to: "0x" + "cd".repeat(20),
        value: "0x0",
        gasPrice: "0x4a817c800",
        type: "legacy",
      });

      expect(result.hash).toBe("0x" + "dd".repeat(32));
      expect(result.gasPrice).toBe("0x4a817c800");
      expect(result.maxFeePerGas).toBeUndefined();
      expect(estimateFees).not.toHaveBeenCalled();

      rpcMock.mockRestore();
    });
  });

  describe("sendTransaction with feeOptions override", () => {
    it("should pass feeOptions to estimation module", async () => {
      (estimateFees as ReturnType<typeof vi.fn>).mockResolvedValue({
        type: "eip1559",
        maxFeePerGas: 30000000000n,
        maxPriorityFeePerGas: 2000000000n,
      });

      const rpcMock = mockRpc((method) => {
        switch (method) {
          case "eth_getTransactionCount": return "0x5";
          case "eth_estimateGas": return "0x5208";
          case "eth_sendRawTransaction": return "0x" + "cc".repeat(32);
          default: return null;
        }
      });

      await wallet.sendTransaction(
        { to: "0x" + "ab".repeat(20), value: "0x0" },
        {
          maxPriorityFeePerGas: "0x77359400", // 2 gwei
          baseFeeMultiplier: 3n,
        },
      );

      expect(estimateFees).toHaveBeenCalledWith(
        expect.objectContaining({
          maxPriorityFeePerGas: 2000000000n,
          baseFeeMultiplier: 3n,
        }),
      );

      rpcMock.mockRestore();
    });
  });

  describe("sendTransaction fallback to legacy", () => {
    it("should fall back to legacy when fee estimation throws and eth_gasPrice works", async () => {
      (estimateFees as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("RPC timeout"),
      );

      let gasPriceCalled = false;
      const rpcMock = mockRpc((method, params) => {
        switch (method) {
          case "eth_getTransactionCount": return "0x5";
          case "eth_estimateGas": return "0x5208";
          case "eth_gasPrice":
            gasPriceCalled = true;
            return "0x4a817c800";
          case "eth_sendRawTransaction": return "0x" + "bb".repeat(32);
          default: return null;
        }
      });

      const result = await wallet.sendTransaction({
        to: "0x" + "ab".repeat(20),
        value: "0x0",
      });

      expect(result.hash).toBe("0x" + "bb".repeat(32));
      expect(result.gasPrice).toBe("0x4a817c800");
      expect(gasPriceCalled).toBe(true);

      rpcMock.mockRestore();
    });
  });

  describe("sendTransaction validation errors", () => {
    it("should throw when no wallet loaded", async () => {
      const empty = new PocketWallet({ storage: new MockStorage() });
      await expect(
        empty.sendTransaction({ to: "0xabcd" }),
      ).rejects.toThrow("No wallet loaded");
    });

    it("should throw when 'to' is missing", async () => {
      await expect(
        wallet.sendTransaction({} as any),
      ).rejects.toThrow("Missing 'to' address");
    });
  });

  describe("sendTransaction overload with legacy-only params (backward compat)", () => {
    it("should still work with legacy-style sendTransaction call", async () => {
      // Simulate an RPC that returns gasPrice (old behavior)
      const rpcMock = mockRpc((method) => {
        switch (method) {
          case "eth_getTransactionCount": return "0x5";
          case "eth_estimateGas": return "0x5208";
          case "eth_sendRawTransaction": return "0x" + "aa".repeat(32);
          case "eth_gasPrice": return "0x4a817c800";
          default: return null;
        }
      });

      const result = await wallet.sendTransaction({
        to: "0x" + "ab".repeat(20),
        value: "0x0",
      });

      expect(result.hash).toBe("0x" + "aa".repeat(32));
      expect(estimateFees).toHaveBeenCalled(); // auto-estimation still runs

      rpcMock.mockRestore();
    });
  });

  describe("bumpFee", () => {
    it("should throw WalletError when no wallet loaded", async () => {
      const empty = new PocketWallet({ storage: new MockStorage() });
      await expect(
        empty.bumpFee({ to: "0xabcd" }),
      ).rejects.toThrow("No wallet loaded");
    });

    it("should throw on invalid multiplier", async () => {
      await expect(
        wallet.bumpFee(
          { to: "0xa", gasPrice: "0x100" },
          { strategy: "percentage", multiplier: 0 },
        ),
      ).rejects.toThrow("multiplier must be greater than zero");
    });
  });

  describe("estimateFee", () => {
    it("should return estimated fee values", async () => {
      (estimateFees as ReturnType<typeof vi.fn>).mockResolvedValue({
        type: "eip1559",
        maxFeePerGas: 15000000000n,
        maxPriorityFeePerGas: 1000000000n,
      });

      const result = await wallet.estimateFee();
      expect(result.type).toBe("eip1559");
      expect(result.maxFeePerGas).toBe("0x" + 15000000000n.toString(16));
      expect(result.maxPriorityFeePerGas).toBe("0x" + 1000000000n.toString(16));
      expect(result.raw.maxFeePerGas).toBe(15000000000n);
      expect(result.raw.maxPriorityFeePerGas).toBe(1000000000n);
    });

    it("should throw when no RPC URL configured", async () => {
      const w = new PocketWallet({ storage: new MockStorage() });
      await expect(w.estimateFee()).rejects.toThrow("RPC URL not configured");
    });
  });
});

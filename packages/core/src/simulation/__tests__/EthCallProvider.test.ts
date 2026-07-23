/**
 * EthCallProvider Tests
 *
 * Tests for the basic eth_call simulation provider.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EthCallProvider } from "../providers/EthCallProvider";
import type { TransactionDescriptor } from "../types";

// ── Mock RPC Response ─────────────────────────────────────────────

function mockFetch(response: any, ok = true) {
  return vi.mocked(fetch).mockResolvedValueOnce({
    ok,
    json: async () => response,
  } as Response);
}

describe("EthCallProvider", () => {
  let provider: EthCallProvider;

  beforeEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = vi.fn();
    provider = new EthCallProvider("https://eth.llamarpc.com");
  });

  describe("simulate", () => {
    it("returns 'success' when eth_call succeeds", async () => {
      mockFetch({ jsonrpc: "2.0", id: 1, result: "0x0000000000000000000000000000000000000000000000000000000000000001" });

      const result = await provider.simulate(
        { to: "0x1234", data: "0xabcd", value: "0x0" },
        "0xuser",
      );

      expect(result.status).toBe("success");
      expect(result.balanceChanges).toEqual([]);
      expect(result.approvalChanges).toEqual([]);
      expect(result.changesDetected).toBe(true);
      expect(result.provider).toBe("eth_call");
    });

    it("returns 'reverted' when eth_call returns an error", async () => {
      mockFetch({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32000,
          message: "execution reverted",
          data: "0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000f496e73756666696369656e742058580000000000000000000000000000000000",
        },
      });

      const result = await provider.simulate(
        { to: "0x1234", data: "0xabcd", value: "0x0" },
        "0xuser",
      );

      expect(result.status).toBe("reverted");
      expect(result.revertReason).toBe("Insufficient XX");
    });

    it("returns 'unavailable' when no RPC URL is configured", async () => {
      const providerNoRpc = new EthCallProvider();
      const result = await providerNoRpc.simulate(
        { to: "0x1234", data: "0xabcd", value: "0x0" },
        "0xuser",
      );

      expect(result.status).toBe("unavailable");
      expect(result.summary).toContain("no RPC URL");
    });

    it("returns 'unavailable' on network error", async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error("Network failure"));

      const result = await provider.simulate(
        { to: "0x1234", data: "0xabcd", value: "0x0" },
        "0xuser",
      );

      expect(result.status).toBe("unavailable");
      expect(result.riskAssessment.warnings.length).toBeGreaterThan(0);
    });

    it("correctly uses options.rpcUrl override", async () => {
      mockFetch({ jsonrpc: "2.0", id: 1, result: "0x01" });

      await provider.simulate(
        { to: "0x1234", data: "0xabcd", value: "0x0" },
        "0xuser",
        { rpcUrl: "https://custom-rpc.example.com" },
      );

      const callUrl = vi.mocked(fetch).mock.calls[0][0];
      expect(callUrl).toBe("https://custom-rpc.example.com");
    });

    it("includes gas in eth_call params when provided in tx", async () => {
      mockFetch({ jsonrpc: "2.0", id: 1, result: "0x01" });

      await provider.simulate(
        {
          to: "0x1234",
          data: "0xabcd",
          value: "0x0",
          gas: "0x5208",
        },
        "0xuser",
      );

      // fetch(rpcUrl, init) — init.body contains the JSON-RPC string
      const initBody = (vi.mocked(fetch).mock.calls[0][1] as any).body;
      const parsed = JSON.parse(initBody);
      expect(parsed.params[0].gas).toBe("0x5208");
    });

    it("decodes Panic(uint256) errors", async () => {
      mockFetch({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32000,
          message: "execution reverted",
          data: "0x4e487b710000000000000000000000000000000000000000000000000000000000000011",
        },
      });

      const result = await provider.simulate(
        { to: "0x1234", data: "0xabcd", value: "0x0" },
        "0xuser",
      );

      expect(result.status).toBe("reverted");
      expect(result.revertReason).toBe("Arithmetic overflow/underflow");
    });
  });

  describe("isAvailable", () => {
    it("returns true for any chain", () => {
      expect(provider.isAvailable(1)).toBe(true);
      expect(provider.isAvailable(137)).toBe(true);
      expect(provider.isAvailable(999999)).toBe(true);
    });
  });
});

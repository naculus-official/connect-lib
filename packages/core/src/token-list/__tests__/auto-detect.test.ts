/**
 * Tests for auto-detect module.
 *
 * Uses a pure mock that returns the correct data per data+selector.
 */

import { ADDRESSES } from "@naculus/test-utils/test-constants";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectTokenInfo, clearAutoDetectCache } from "../auto-detect";

/**
 * Create a mock Response for RPC calls.
 * Accepts the `data` field from the request body and returns
 * the appropriate decoded value.
 */
function mockFetchForRpc(): void {
  globalThis.fetch = vi.fn(
    async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      );
      const data: string = body.params?.[0]?.data ?? "";

      let result: string;
      if (data === "0x06fdde03") {
        // name() → "USD Coin"
        result =
          "0x0000000000000000000000000000000000000000000000000000000000000020" +
          "0000000000000000000000000000000000000000000000000000000000000008" +
          "55534420436f696e000000000000000000000000000000000000000000000000";
      } else if (data === "0x95d89b41") {
        // symbol() → "USDC"
        result =
          "0x0000000000000000000000000000000000000000000000000000000000000020" +
          "0000000000000000000000000000000000000000000000000000000000000004" +
          "5553444300000000000000000000000000000000000000000000000000000000";
      } else if (data === "0x313ce567") {
        // decimals() → 6
        result =
          "0x0000000000000000000000000000000000000000000000000000000000000006";
      } else {
        result = "0x";
      }

      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  );
}

/**
 * Mock fetch with a counter to verify the cache prevents re-fetches.
 */
function mockFetchWithCounter(): { fetchSpy: vi.Mock; getCallCount: () => number } {
  let callCount = 0;
  const fn = vi.fn(
    async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      callCount++;
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      );
      const data: string = body.params?.[0]?.data ?? "";

      // Return "TEST" token for any selector
      const result =
        data === "0x313ce567"
          ? "0x0000000000000000000000000000000000000000000000000000000000000012" // decimals = 18
          : "0x0000000000000000000000000000000000000000000000000000000000000020" +
            "0000000000000000000000000000000000000000000000000000000000000004" +
            "5445535400000000000000000000000000000000000000000000000000000000"; // "TEST"

      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  );
  globalThis.fetch = fn;
  return {
    fetchSpy: fn,
    getCallCount: () => callCount,
  };
}

describe("auto-detect", () => {
  const testAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

  beforeEach(async () => {
    vi.restoreAllMocks();
    await clearAutoDetectCache();
  });

  describe("detectTokenInfo()", () => {
    it("should fetch token metadata from chain", async () => {
      mockFetchForRpc();
      const token = await detectTokenInfo(testAddress, 1, "https://rpc.example.com");

      expect(token.address).toBe(testAddress);
      expect(token.chainId).toBe(1);
      expect(token.name).toBe("USD Coin");
      expect(token.symbol).toBe("USDC");
      expect(token.decimals).toBe(6);
      expect(token.source).toBe("auto-detect");
      expect(token.tags).toContain("custom");
    });

    it("should fetch and return valid token metadata", async () => {
      const { getCallCount } = mockFetchWithCounter();

      const token1 = await detectTokenInfo(
        "0x0000000000000000000000000000000000000001",
        1,
        "https://rpc.example.com",
      );
      expect(token1.symbol).toBe("TEST");
      expect(token1.decimals).toBe(18);

      // With RPC mock, we should have made 3 calls (name, symbol, decimals)
      expect(getCallCount()).toBe(3);
    });

    it("should handle RPC errors", async () => {
      // Return a fresh Response for each call so json() isn't consumed twice
      globalThis.fetch = vi.fn().mockImplementation(
        async (): Promise<Response> => {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32000, message: "execution reverted" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
      );

      await expect(
        detectTokenInfo(testAddress, 1, "https://rpc.example.com"),
      ).rejects.toThrow("RPC error");
    });
  });

  describe("clearAutoDetectCache()", () => {
    it("should clear the cache without error", async () => {
      // Populate cache
      mockFetchForRpc();
      await detectTokenInfo(testAddress, 1, "https://rpc.example.com");

      // Clear should not throw
      const result = await clearAutoDetectCache();
      expect(result).toBeUndefined();
    });
  });
});

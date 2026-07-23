import { describe, it, expect, beforeEach, vi } from "vitest";
import { ADDRESSES } from "@naculus/test-utils/test-constants";
import { NameResolver, ResolutionError } from "..";

// ── Mock fetch for RPC calls ────────────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = vi.fn();

  // Default mock: return empty/zero results for RPC calls
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        jsonrpc: "2.0",
        id: 1,
        result: "0x0000000000000000000000000000000000000000000000000000000000000000",
      }),
  } as Response);
});

// ── Tests ──────────────────────────────────────────────────────

describe("NameResolver", () => {
  describe("constructor", () => {
    it("should create a resolver with default providers", () => {
      const resolver = new NameResolver();
      expect(resolver).toBeInstanceOf(NameResolver);
    });
  });

  describe("resolveName", () => {
    it("should throw ResolutionError for empty name", async () => {
      const resolver = new NameResolver();
      await expect(resolver.resolveName("")).rejects.toThrow(ResolutionError);
      await expect(resolver.resolveName("")).rejects.toMatchObject({
        code: "INVALID_NAME",
      });
    });

    it("should throw ResolutionError for unsupported name service", async () => {
      const resolver = new NameResolver();
      await expect(resolver.resolveName("test.xyz")).rejects.toThrow(ResolutionError);
      await expect(resolver.resolveName("test.xyz")).rejects.toMatchObject({
        code: "UNSUPPORTED_NAME_SERVICE",
      });
    });

    it("should throw ResolutionError for name with no suffix at all", async () => {
      const resolver = new NameResolver();
      await expect(resolver.resolveName("vitalik")).rejects.toThrow(ResolutionError);
      await expect(resolver.resolveName("vitalik")).rejects.toMatchObject({
        code: "UNSUPPORTED_NAME_SERVICE",
      });
    });

    it("should throw ResolutionError for invalid name format", async () => {
      const resolver = new NameResolver();
      await expect(resolver.resolveName("-test.eth")).rejects.toThrow(ResolutionError);
      await expect(resolver.resolveName("-test.eth")).rejects.toMatchObject({
        code: "INVALID_NAME",
      });
    });

    it("should return null when ENS provider returns null", async () => {
      const resolver = new NameResolver({
        providers: {
          ens: { rpcUrl: "https://eth.llamarpc.com" },
        },
        timeoutMs: 5000,
      });

      // Mock fetch returns zero address for resolver lookup
      const result = await resolver.resolveName("vitalik.eth");
      expect(result).toBeNull();
    });

    it("should respect the RPC URL configuration", async () => {
      const resolver = new NameResolver({
        providers: {
          ens: { rpcUrl: "https://custom-rpc.example.com" },
          sns: { rpcUrl: "https://custom-solana.example.com" },
        },
      });

      // Fetch for vitalik.eth should go to the custom ENS RPC
      await resolver.resolveName("vitalik.eth");

      expect(fetch).toHaveBeenCalledWith(
        "https://custom-rpc.example.com",
        expect.any(Object),
      );
    });

    it("should cache resolved names", async () => {
      const resolver = new NameResolver({
        providers: {
          ens: { rpcUrl: "https://eth.llamarpc.com" },
        },
      });

      // Reset and set up mocks
      vi.mocked(fetch).mockClear();

      // First call updates the mock to effectively return a real result
      // Subsequent calls should use cache

      // Mock resolver lookup
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              jsonrpc: "2.0",
              id: 1,
              result: "0x0000000000000000000000004976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41",
            }),
        } as Response)
        // Mock addr lookup
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              jsonrpc: "2.0",
              id: 1,
              result: "0x000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045",
            }),
        } as Response);

      // First call hits RPC
      const firstResult = await resolver.resolveName("vitalik.eth");
      expect(firstResult).not.toBeNull();
      expect(fetch).toHaveBeenCalledTimes(2);

      // Reset fetch call count
      vi.mocked(fetch).mockClear();

      // Second call should use cache (no fetches)
      const secondResult = await resolver.resolveName("vitalik.eth");
      expect(secondResult).not.toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("should clear cache on clearCache()", async () => {
      const resolver = new NameResolver({
        providers: {
          ens: { rpcUrl: "https://eth.llamarpc.com" },
        },
      });

      // Mock a resolution
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              jsonrpc: "2.0",
              id: 1,
              result: "0x0000000000000000000000004976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41",
            }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              jsonrpc: "2.0",
              id: 1,
              result: "0x000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045",
            }),
        } as Response);

      await resolver.resolveName("vitalik.eth");

      // Clear cache
      resolver.clearCache();
      vi.mocked(fetch).mockClear();

      // Re-mock for second fetch
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              jsonrpc: "2.0",
              id: 1,
              result: "0x0000000000000000000000004976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41",
            }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              jsonrpc: "2.0",
              id: 1,
              result: "0x000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045",
            }),
        } as Response);

      // Should fetch again
      const result = await resolver.resolveName("vitalik.eth");
      expect(result).not.toBeNull();
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("should handle batch resolveNames", async () => {
      const resolver = new NameResolver({
        providers: {
          ens: { rpcUrl: "https://eth.llamarpc.com" },
        },
        timeoutMs: 5000,
      });

      const results = await resolver.resolveNames([
        "vitalik.eth",
        "vitalik.sol",
      ]);

      expect(results.size).toBe(2);
      expect(results.has("vitalik.eth")).toBe(true);
      expect(results.has("vitalik.sol")).toBe(true);
      // Both resolve to null (no real RPC returns)
      expect(results.get("vitalik.eth")).toBeNull();
      expect(results.get("vitalik.sol")).toBeNull();
    });

    it("should timeout on slow resolution", async () => {
      const resolver = new NameResolver({
        providers: {
          ens: { rpcUrl: "https://eth.llamarpc.com" },
        },
        timeoutMs: 20, // Very short timeout for testing
      });

      // Ensure no default mock interferes: clear all mocks
      vi.mocked(fetch).mockReset();

      // Slow response — never resolves
      vi.mocked(fetch).mockImplementation(
        () =>
          new Promise<Response>(() => {}), // Never resolves
      );

      await expect(resolver.resolveName("test.eth")).rejects.toThrow(ResolutionError);
      await expect(resolver.resolveName("test.eth")).rejects.toMatchObject({
        code: "RESOLUTION_TIMEOUT",
      });
    });
  });

  describe("lookupAddress", () => {
    it("should throw for empty address", async () => {
      const resolver = new NameResolver();
      await expect(resolver.lookupAddress("")).rejects.toThrow(ResolutionError);
    });

    it("should pass chainId hint to provider selection", async () => {
      const resolver = new NameResolver({
        providers: {
          ens: { rpcUrl: "https://eth.llamarpc.com" },
        },
      });

      // EVM address with eip155 chain → uses ENS
      const result = await resolver.lookupAddress(
        "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        "eip155:1",
      );
      expect(result).toBeNull(); // Not found, but didn't throw
    });

    it("should auto-detect EVM address format", async () => {
      const resolver = new NameResolver({
        providers: {
          ens: { rpcUrl: "https://eth.llamarpc.com" },
        },
      });

      // 0x address should auto-detect as eip155
      const result = await resolver.lookupAddress(
        "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
      );
      expect(result).toBeNull();
    });
  });
});

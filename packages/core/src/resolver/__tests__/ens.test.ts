import { describe, it, expect, beforeEach, vi } from "vitest";
import { ADDRESSES } from "@naculus/test-utils/test-constants";
import { ENSProvider, ENS_REGISTRY_ADDRESS, ENS_REVERSE_REGISTRAR } from "../providers/ens";

// ── Mock fetch ──────────────────────────────────────────────────

const mockEthCall = vi.fn();

function mockFetch(response: unknown) {
  return vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(response),
  } as Response);
}

beforeEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = vi.fn();
});

// ── Provider Creation ───────────────────────────────────────────

function createProvider(rpcUrl = "https://eth.llamarpc.com"): ENSProvider {
  return new ENSProvider(rpcUrl);
}

// ── Tests ──────────────────────────────────────────────────────

describe("ENSProvider", () => {
  describe("supportsName", () => {
    it("should return true for .eth names", () => {
      const provider = createProvider();
      expect(provider.supportsName("vitalik.eth")).toBe(true);
      expect(provider.supportsName("VITALIK.ETH")).toBe(true);
      expect(provider.supportsName("test.eth")).toBe(true);
    });

    it("should return false for non-.eth names", () => {
      const provider = createProvider();
      expect(provider.supportsName("vitalik.sol")).toBe(false);
      expect(provider.supportsName("test.xrp")).toBe(false);
      expect(provider.supportsName("plainname")).toBe(false);
    });
  });

  describe("resolveName", () => {
    it("should return null for non-.eth names", async () => {
      const provider = createProvider();
      const result = await provider.resolveName("test.sol");
      expect(result).toBeNull();
    });

    it("should resolve a .eth name to an address", async () => {
      const provider = createProvider();

      // Mock resolver lookup → returns resolver address
      const resolverAddr = "0x0000000000000000000000004976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41";
      const addrResult = `0x000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045`;

      // First call: ENS Registry.resolver(namehash)
      mockFetch({
        jsonrpc: "2.0",
        id: 1,
        result: `0x000000000000000000000000${resolverAddr.slice(2)}`,
      });

      // Second call: Resolver.addr(namehash)
      mockFetch({
        jsonrpc: "2.0",
        id: 1,
        result: addrResult,
      });

      const result = await provider.resolveName("vitalik.eth");

      expect(result).not.toBeNull();
      expect(result!.address).toBe("0xd8da6bf26964af9d7eed9e03e53415d37aa96045");
      expect(result!.chainType).toBe("eip155");
      expect(result!.name).toBe("vitalik.eth");
    });

    it("should return null when resolver address is zero", async () => {
      const provider = createProvider();

      // Resolver is zero address
      mockFetch({
        jsonrpc: "2.0",
        id: 1,
        result: "0x0000000000000000000000000000000000000000000000000000000000000000",
      });

      const result = await provider.resolveName("nonexistent.eth");
      expect(result).toBeNull();
    });

    it("should return null when addr returns zero", async () => {
      const provider = createProvider();

      const resolverAddr = "0x0000000000000000000000004976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41";

      // Resolver found
      mockFetch({
        jsonrpc: "2.0",
        id: 1,
        result: `0x000000000000000000000000${resolverAddr.slice(2)}`,
      });

      // addr returns zero
      mockFetch({
        jsonrpc: "2.0",
        id: 1,
        result: "0x0000000000000000000000000000000000000000000000000000000000000000",
      });

      const result = await provider.resolveName("unclaimed.eth");
      expect(result).toBeNull();
    });

    it("should return null on RPC failure (graceful degradation)", async () => {
      const provider = createProvider();

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      } as Response);

      const result = await provider.resolveName("test.eth");
      expect(result).toBeNull();
    });

    it("should return null on RPC error response (graceful degradation)", async () => {
      const provider = createProvider();

      mockFetch({
        jsonrpc: "2.0",
        id: 1,
        error: { message: "execution reverted" },
      });

      const result = await provider.resolveName("test.eth");
      expect(result).toBeNull();
    });
  });

  describe("lookupAddress", () => {
    it("should lookup a name from an address", async () => {
      const provider = createProvider();
      const address = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

      const resolverAddr = "0x000000000000000000000000a2c122beec4a08e26c3fd65ab3bf32b0c0d0c7b2";

      // First call: resolver for reverse node
      mockFetch({
        jsonrpc: "2.0",
        id: 1,
        result: `0x000000000000000000000000${resolverAddr.slice(2)}`,
      });

      // Second call: resolver.name() returning encoded string
      const nameHex = "766974616c696b2e657468"; // "vitalik.eth" in hex
      const lengthHex = "000000000000000000000000000000000000000000000000000000000000000b"; // 11 bytes
      const offsetHex = "0000000000000000000000000000000000000000000000000000000000000020";
      mockFetch({
        jsonrpc: "2.0",
        id: 1,
        result: `0x${offsetHex}${lengthHex}${nameHex}${"0".repeat(42)}`, // padded to 32 bytes
      });

      const result = await provider.lookupAddress(address);

      expect(result).not.toBeNull();
      expect(result!.name).toBe("vitalik.eth");
      expect(result!.chainType).toBe("eip155");
      expect(result!.isPrimary).toBe(true);
    });

    it("should return null when no reverse record exists", async () => {
      const provider = createProvider();

      // Resolver is zero → no reverse record
      mockFetch({
        jsonrpc: "2.0",
        id: 1,
        result: "0x0000000000000000000000000000000000000000000000000000000000000000",
      });

      const result = await provider.lookupAddress(ADDRESSES.ZERO);
      expect(result).toBeNull();
    });
  });
});

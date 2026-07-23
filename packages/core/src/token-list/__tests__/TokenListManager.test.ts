/**
 * Tests for TokenListManager.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { TokenListManager } from "../TokenListManager";
import type { TokenListEntry, TokenListSource } from "../types";
import { ETHEREUM_MAINNET_TOKENS, POLYGON_TOKENS } from "../lists";

// Built-in sources for testing
const TEST_SOURCES: TokenListSource[] = [
  {
    name: "built-in",
    tokens: [...ETHEREUM_MAINNET_TOKENS, ...POLYGON_TOKENS],
    enabled: true,
  },
];

describe("TokenListManager", () => {
  let manager: TokenListManager;

  beforeEach(() => {
    manager = new TokenListManager({
      sources: TEST_SOURCES,
      cacheKey: "test_token_list_cache",
      cacheTtl: 0, // Expire immediately so we always reload
    });
  });

  describe("load()", () => {
    it("should load built-in tokens without network fetch", async () => {
      const tokens = await manager.load();
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens.length).toBe(
        ETHEREUM_MAINNET_TOKENS.length + POLYGON_TOKENS.length,
      );
    });

    it("should tag tokens with their source name", async () => {
      const tokens = await manager.load();
      for (const t of tokens) {
        expect(t.source).toBe("built-in");
      }
    });
  });

  describe("getTokens()", () => {
    beforeEach(async () => {
      await manager.load();
    });

    it("should return all tokens", () => {
      const tokens = manager.getTokens();
      expect(tokens.length).toBeGreaterThan(0);
    });

    it("should filter by chainId", () => {
      const ethTokens = manager.getTokens({ chainId: 1 });
      expect(ethTokens.length).toBe(ETHEREUM_MAINNET_TOKENS.length);
      for (const t of ethTokens) {
        expect(t.chainId).toBe(1);
      }
    });

    it("should filter by source", () => {
      const builtinTokens = manager.getTokens({ source: "built-in" });
      expect(builtinTokens.length).toBeGreaterThan(0);
    });

    it("should return empty array for non-existent chain", () => {
      const tokens = manager.getTokens({ chainId: 999 });
      expect(tokens.length).toBe(0);
    });
  });

  describe("search()", () => {
    beforeEach(async () => {
      await manager.load();
    });

    it("should find exact symbol match", () => {
      const result = manager.search("USDC");
      expect(result.exact.length).toBeGreaterThan(0);
      const match = result.exact.find((m) => m.matchField === "symbol");
      expect(match).toBeDefined();
      expect(match!.token.symbol).toBe("USDC");
    });

    it("should be case-insensitive", () => {
      const result = manager.search("usdc");
      expect(result.exact.length).toBeGreaterThan(0);
    });

    it("should find exact name match", () => {
      const result = manager.search("USD Coin");
      expect(result.exact.length).toBeGreaterThan(0);
    });

    it("should find fuzzy matches by prefix", () => {
      const result = manager.search("USD");
      // Should find USDC, USDT, etc.
      expect(result.exact.length + result.fuzzy.length).toBeGreaterThan(0);
    });

    it("should find address match", () => {
      const usdc = ETHEREUM_MAINNET_TOKENS.find((t) => t.symbol === "USDC")!;
      const result = manager.search(usdc.address);
      expect(result.exact.length).toBe(1);
      expect(result.exact[0].matchField).toBe("address");
    });

    it("should filter by chainId", () => {
      const result = manager.search("USDC", { chainId: 137 });
      expect(result.exact.length).toBeGreaterThan(0);
      for (const m of [...result.exact, ...result.fuzzy]) {
        expect(m.token.chainId).toBe(137);
      }
    });

    it("should limit results", () => {
      const result = manager.search("a", { limit: 3 });
      expect(result.exact.length + result.fuzzy.length).toBeLessThanOrEqual(
        3,
      );
    });

    it("should return empty on blank query", () => {
      const result = manager.search("");
      expect(result.exact.length).toBe(0);
      expect(result.fuzzy.length).toBe(0);
    });

    it("should sort exact matches before fuzzy", () => {
      const result = manager.search("USDC");
      if (result.exact.length > 0 && result.fuzzy.length > 0) {
        expect(result.exact[0].score >= result.fuzzy[0].score);
      }
    });
  });

  describe("getToken()", () => {
    beforeEach(async () => {
      await manager.load();
    });

    it("should find token by address and chainId", () => {
      const usdc = ETHEREUM_MAINNET_TOKENS.find((t) => t.symbol === "USDC")!;
      const found = manager.getToken(usdc.address, 1);
      expect(found).toBeDefined();
      expect(found!.symbol).toBe("USDC");
    });

    it("should be case-insensitive for address", () => {
      const usdc = ETHEREUM_MAINNET_TOKENS.find((t) => t.symbol === "USDC")!;
      const mixedCase = `0x${usdc.address.slice(2).toUpperCase()}`;
      const found = manager.getToken(mixedCase, 1);
      expect(found).toBeDefined();
    });

    it("should return undefined for unknown address", () => {
      const found = manager.getToken(
        "0x0000000000000000000000000000000000000000",
        1,
      );
      expect(found).toBeUndefined();
    });

    it("should return undefined for wrong chainId", () => {
      const usdc = ETHEREUM_MAINNET_TOKENS.find((t) => t.symbol === "USDC")!;
      const found = manager.getToken(usdc.address, 999);
      expect(found).toBeUndefined();
    });
  });

  describe("deduplication", () => {
    it("should deduplicate by (chainId, address)", async () => {
      const duplicateSource: TokenListSource[] = [
        {
          name: "source-a",
          tokens: [ETHEREUM_MAINNET_TOKENS[0]],
          enabled: true,
        },
        {
          name: "source-b",
          tokens: [ETHEREUM_MAINNET_TOKENS[0]],
          enabled: true,
        },
      ];
      const m = new TokenListManager({
        sources: duplicateSource,
        sourcePriority: ["source-a", "source-b"],
      });
      const tokens = await m.load();
      const usdc = tokens.filter(
        (t) =>
          t.address.toLowerCase() ===
          ETHEREUM_MAINNET_TOKENS[0].address.toLowerCase(),
      );
      expect(usdc.length).toBe(1);
    });

    it("should respect source priority", async () => {
      const weth = ETHEREUM_MAINNET_TOKENS.find((t) => t.symbol === "WETH")!;
      const modified = { ...weth, decimals: 99 };
      const sources: TokenListSource[] = [
        {
          name: "lower",
          tokens: [modified],
          enabled: true,
        },
        {
          name: "higher",
          tokens: [weth],
          enabled: true,
        },
      ];
      const m = new TokenListManager({
        sources,
        sourcePriority: ["higher", "lower"],
      });
      const tokens = await m.load();
      const found = tokens.find(
        (t) =>
          t.address.toLowerCase() === weth.address.toLowerCase() &&
          t.chainId === 1,
      );
      expect(found).toBeDefined();
      // Higher priority should win (decimals = 18, not 99)
      expect(found!.decimals).toBe(18);
    });
  });

  describe("getSourcesStatus()", () => {
    it("should return initial status", () => {
      const status = manager.getSourcesStatus();
      expect(status.length).toBe(TEST_SOURCES.length);
      expect(status[0].name).toBe("built-in");
      expect(status[0].state).toBe("loading");
    });

    it("should update status after load", async () => {
      await manager.load();
      const status = manager.getSourcesStatus();
      expect(status[0].state).toBe("loaded");
      expect(status[0].tokenCount).toBeGreaterThan(0);
      expect(status[0].lastUpdated).toBeGreaterThan(0);
    });
  });

  describe("clearCache()", () => {
    it("should clear all tokens", async () => {
      await manager.load();
      expect(manager.getTokens().length).toBeGreaterThan(0);
      manager.clearCache();
      expect(manager.getTokens().length).toBe(0);
    });
  });
});

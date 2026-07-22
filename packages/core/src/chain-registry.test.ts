/**
 * chain-registry Tests
 *
 * Validates the canonical chain registry:
 * - All chain IDs present
 * - Correct addresses and metadata
 * - Consistency across entries
 */

import { ADDRESSES } from "@naculus/test-utils/test-constants";

import { describe, expect, it } from "vitest";
import { CHAINS, getChainInfo } from "./chain-registry";

describe("chain-registry", () => {
  describe("CHAINS", () => {
    it("contains all expected chains", () => {
      const expectedChainIds = [
        1, 10, 56, 100, 137, 250, 324, 1101, 8453, 42161, 43114, 59144, 534352,
        11155111,
      ];
      for (const id of expectedChainIds) {
        expect(CHAINS[id]).toBeDefined();
        expect(CHAINS[id].name).toBeDefined();
        expect(CHAINS[id].caip2Id).toBeDefined();
        expect(CHAINS[id].nativeCurrency).toBeDefined();
      }
    });

    it("each chain has a valid caip2Id format", () => {
      for (const chainInfo of Object.values(CHAINS)) {
        expect(chainInfo.caip2Id).toMatch(/^eip155:\d+$/);
      }
    });

    it("each chain has a non-empty name", () => {
      for (const chainInfo of Object.values(CHAINS)) {
        expect(chainInfo.name.length).toBeGreaterThan(0);
      }
    });

    it("Ethereum mainnet registry entry is correct", () => {
      const eth = CHAINS[1];
      expect(eth.name).toBe("Ethereum");
      expect(eth.caip2Id).toBe("eip155:1");
      expect(eth.nativeCurrency).toEqual({ symbol: "ETH", decimals: 18 });
      expect(eth.usdcAddress).toBe(
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      );
      expect(eth.usdtAddress).toBe(
        "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      );
    });

    it("all usdcAddress entries are valid 42-char hex addresses", () => {
      for (const chainInfo of Object.values(CHAINS)) {
        if (chainInfo.usdcAddress) {
          expect(chainInfo.usdcAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
        }
      }
    });

    it("all usdtAddress entries are valid 42-char hex addresses", () => {
      for (const chainInfo of Object.values(CHAINS)) {
        if (chainInfo.usdtAddress) {
          expect(chainInfo.usdtAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
        }
      }
    });

    it("all entryPoint addresses are valid 42-char hex addresses where present", () => {
      for (const chainInfo of Object.values(CHAINS)) {
        if (chainInfo.entryPoint) {
          expect(chainInfo.entryPoint).toMatch(/^0x[a-fA-F0-9]{40}$/);
        }
      }
    });

    it("all factoryAddress addresses are valid 42-char hex addresses where present", () => {
      for (const chainInfo of Object.values(CHAINS)) {
        if (chainInfo.factoryAddress) {
          expect(chainInfo.factoryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
        }
      }
    });

    it("all chains with a factoryAddress also have an entryPoint", () => {
      for (const chainInfo of Object.values(CHAINS)) {
        if (chainInfo.factoryAddress) {
          expect(chainInfo.entryPoint).toBeDefined();
        }
      }
    });
  });

  describe("getChainInfo", () => {
    it("returns ChainInfo for known chain IDs", () => {
      const info = getChainInfo(1);
      expect(info.name).toBe("Ethereum");
    });

    it("returns ChainInfo for Base", () => {
      const info = getChainInfo(8453);
      expect(info.name).toBe("Base");
    });

    it("throws for unknown chain IDs", () => {
      expect(() => getChainInfo(999999)).toThrow(
        "Chain 999999 not found in registry",
      );
    });

    it("returns ChainInfo for zkSync Era (no optional fields)", () => {
      const info = getChainInfo(324);
      expect(info.name).toBe("zkSync Era");
      expect(info.nativeCurrency).toEqual({ symbol: "ETH", decimals: 18 });
      // No axelarName, usdcAddress, usdtAddress, entryPoint, or factoryAddress
      expect(info.axelarName).toBeUndefined();
      expect(info.usdcAddress).toBeUndefined();
      expect(info.usdtAddress).toBeUndefined();
      expect(info.entryPoint).toBeUndefined();
      expect(info.factoryAddress).toBeUndefined();
    });

    it("returns ChainInfo with axelar for supported chains", () => {
      const polygon = getChainInfo(137);
      expect(polygon.axelarName).toBe("polygon");

      const avalanche = getChainInfo(43114);
      expect(avalanche.axelarName).toBe("avalanche");

      const bnb = getChainInfo(56);
      expect(bnb.axelarName).toBe("binance");
    });

    it("works for every chain in CHAINS", () => {
      for (const chainIdStr of Object.keys(CHAINS)) {
        const chainId = Number(chainIdStr);
        const info = getChainInfo(chainId);
        expect(info).toBeDefined();
        expect(info.caip2Id).toBe(`eip155:${chainId}`);
      }
    });
  });

  describe("specific chain entries", () => {
    it("BNB Chain has correct metadata", () => {
      const bnb = CHAINS[56];
      expect(bnb.name).toBe("BNB Chain");
      expect(bnb.nativeCurrency).toEqual({ symbol: "BNB", decimals: 18 });
      expect(bnb.axelarName).toBe("binance");
      expect(bnb.usdcAddress).toBe(
        "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      );
      expect(bnb.usdtAddress).toBe(
        "0x55d398326f99059fF775485246999027B3197955",
      );
      // No entryPoint/factory for BNB Chain (AA not supported in registry)
      expect(bnb.entryPoint).toBeUndefined();
      expect(bnb.factoryAddress).toBeUndefined();
    });

    it("Gnosis has correct metadata", () => {
      const gnosis = CHAINS[100];
      expect(gnosis.name).toBe("Gnosis");
      expect(gnosis.nativeCurrency.symbol).toBe("xDAI");
      expect(gnosis.axelarName).toBe("gnosis");
    });

    it("Fantom has correct metadata", () => {
      const fantom = CHAINS[250];
      expect(fantom.name).toBe("Fantom");
      expect(fantom.nativeCurrency.symbol).toBe("FTM");
      expect(fantom.axelarName).toBe("fantom");
      expect(fantom.usdcAddress).toBe(
        "0x04068DA6C83AFCFA0e13ba15A6696662335D5B75",
      );
      // No USDT on Fantom
      expect(fantom.usdtAddress).toBeUndefined();
    });

    it("Sepolia (testnet) has correct metadata", () => {
      const sepolia = CHAINS[11155111];
      expect(sepolia.name).toBe("Sepolia");
      expect(sepolia.nativeCurrency).toEqual({ symbol: "ETH", decimals: 18 });
      expect(sepolia.entryPoint).toBeDefined();
      expect(sepolia.factoryAddress).toBeDefined();
      // No Axelar, USDC, or USDT on Sepolia
      expect(sepolia.axelarName).toBeUndefined();
      expect(sepolia.usdcAddress).toBeUndefined();
      expect(sepolia.usdtAddress).toBeUndefined();
    });

    it("all chains with native ETH have symbol ETH", () => {
      for (const chainInfo of Object.values(CHAINS)) {
        if (chainInfo.nativeCurrency.symbol === "ETH") {
          expect(chainInfo.nativeCurrency.decimals).toBe(18);
        }
      }
    });

    it("all chains with an axelarName have a unique value", () => {
      const axelarNames = Object.values(CHAINS)
        .filter((c) => c.axelarName)
        .map((c) => c.axelarName);
      const uniqueNames = new Set(axelarNames);
      expect(uniqueNames.size).toBe(axelarNames.length);
    });

    it("nativeCurrency always has 18 decimals", () => {
      for (const chainInfo of Object.values(CHAINS)) {
        expect(chainInfo.nativeCurrency.decimals).toBe(18);
      }
    });

    it("no duplicate chain names", () => {
      const names = Object.values(CHAINS).map((c) => c.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });

    it("all USDC addresses are unique across chains", () => {
      const usdcAddresses = Object.values(CHAINS)
        .filter((c) => c.usdcAddress)
        .map((c) => c.usdcAddress!.toLowerCase());
      const uniqueAddresses = new Set(usdcAddresses);
      expect(uniqueAddresses.size).toBe(usdcAddresses.length);
    });
  });
});

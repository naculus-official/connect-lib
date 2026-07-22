/// <reference types="vitest" />

import { describe, expect, it } from "vitest";
import {
  AUTO_RECONNECT_TIMEOUT_MS,
  DEFAULT_EVM_CHAIN,
  DEFAULT_NONCE_LENGTH,
  DEFAULT_SOLANA_CLUSTER,
  DEFAULT_XRPL_NETWORK,
  EIP155_ARBITRUM,
  EIP155_GOERLI,
  EIP155_MAINNET,
  EIP155_OPTIMISM,
  EIP155_POLYGON,
  EIP155_SEPOLIA,
  NAMESPACE_EIP155,
  NAMESPACE_SOLANA,
  NAMESPACE_XRPL,
  SESSION_TIMEOUT_MS,
  SOLANA_DEVNET,
  SOLANA_MAINNET,
  SOLANA_TESTNET,
  SUPPORTED_NAMESPACES,
  WC_DISCONNECT_SESSION_EXPIRED,
  WC_DISCONNECT_TIMEOUT,
  WC_DISCONNECT_USER,
  XRPL_MAINNET,
  XRPL_TESTNET,
} from "./constants";
import { detectPlatform, isMobileBrowser } from "./platform";

describe("platform utilities", () => {
  describe("detectPlatform", () => {
    it("should return desktop-web in Node.js environment", () => {
      const platform = detectPlatform();
      expect(platform).toBe("desktop-web");
    });
  });

  describe("isMobileBrowser", () => {
    it("should return false in Node.js environment", () => {
      expect(isMobileBrowser()).toBe(false);
    });
  });
});

describe("namespace constants", () => {
  it("should export EIP-155 namespace", () => {
    expect(NAMESPACE_EIP155).toBe("eip155");
  });

  it("should export Solana namespace", () => {
    expect(NAMESPACE_SOLANA).toBe("solana");
  });

  it("should export XRPL namespace", () => {
    expect(NAMESPACE_XRPL).toBe("xrpl");
  });

  it("should export supported namespaces array", () => {
    expect(SUPPORTED_NAMESPACES).toContain("eip155");
    expect(SUPPORTED_NAMESPACES).toContain("solana");
    expect(SUPPORTED_NAMESPACES).toContain("xrpl");
  });
});

describe("EVM chain constants", () => {
  it("should have correct mainnet chain ID", () => {
    expect(EIP155_MAINNET).toBe("eip155:1");
  });

  it("should have correct Goerli chain ID", () => {
    expect(EIP155_GOERLI).toBe("eip155:5");
  });

  it("should have correct Sepolia chain ID", () => {
    expect(EIP155_SEPOLIA).toBe("eip155:11155111");
  });

  it("should have correct Polygon chain ID", () => {
    expect(EIP155_POLYGON).toBe("eip155:137");
  });

  it("should have correct Arbitrum chain ID", () => {
    expect(EIP155_ARBITRUM).toBe("eip155:42161");
  });

  it("should have correct Optimism chain ID", () => {
    expect(EIP155_OPTIMISM).toBe("eip155:10");
  });
});

describe("Solana cluster constants", () => {
  it("should have correct mainnet cluster", () => {
    expect(SOLANA_MAINNET).toBe("solana:0");
  });

  it("should have correct devnet cluster", () => {
    expect(SOLANA_DEVNET).toBe("solana:1");
  });

  it("should have correct testnet cluster", () => {
    expect(SOLANA_TESTNET).toBe("solana:2");
  });
});

describe("XRPL network constants", () => {
  it("should have correct mainnet network", () => {
    expect(XRPL_MAINNET).toBe("xrpl:0");
  });

  it("should have correct testnet network", () => {
    expect(XRPL_TESTNET).toBe("xrpl:1");
  });
});

describe("default chain constants", () => {
  it("should default EVM chain to mainnet", () => {
    expect(DEFAULT_EVM_CHAIN).toBe("eip155:1");
  });

  it("should default Solana cluster to mainnet", () => {
    expect(DEFAULT_SOLANA_CLUSTER).toBe("solana:0");
  });

  it("should default XRPL network to mainnet", () => {
    expect(DEFAULT_XRPL_NETWORK).toBe("xrpl:0");
  });
});

describe("WalletConnect disconnect codes", () => {
  it("should have correct user disconnect code", () => {
    expect(WC_DISCONNECT_USER).toBe(6000);
  });

  it("should have correct timeout disconnect code", () => {
    expect(WC_DISCONNECT_TIMEOUT).toBe(6001);
  });

  it("should have correct session expired code", () => {
    expect(WC_DISCONNECT_SESSION_EXPIRED).toBe(6002);
  });
});

describe("nonce configuration", () => {
  it("should have correct default nonce length", () => {
    expect(DEFAULT_NONCE_LENGTH).toBe(16);
  });
});

describe("session timeout values", () => {
  it("should have correct session timeout", () => {
    expect(SESSION_TIMEOUT_MS).toBe(5 * 60 * 1000); // 5 minutes
  });

  it("should have correct auto-reconnect timeout", () => {
    expect(AUTO_RECONNECT_TIMEOUT_MS).toBe(30 * 1000); // 30 seconds
  });
});

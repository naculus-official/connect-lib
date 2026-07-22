import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @coinbase/wallet-sdk
const mockProvider = {
  request: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
  isCoinbaseWallet: true,
};

const mockMakeWeb3Provider = vi.fn().mockReturnValue(mockProvider);

class MockCoinbaseWalletSDK {
  makeWeb3Provider = mockMakeWeb3Provider;
  getCoinbaseWalletLogo = vi.fn().mockReturnValue("data:image/svg+xml;...");
  storeLatestVersion = vi.fn();
}

vi.mock("@coinbase/wallet-sdk", () => ({
  default: MockCoinbaseWalletSDK,
  CoinbaseWalletSDK: MockCoinbaseWalletSDK,
}));

// Import after mocks
const { CoinbaseConnector } = await import("./connector");

/**
 * Integration tests for CoinbaseConnector.
 *
 * These test the connector's interaction with the connector-manager
 * pattern and verify end-to-end flows with mocked wallet-sdk responses.
 */
describe("CoinbaseConnector Integration", () => {
  let connector: InstanceType<typeof CoinbaseConnector>;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new CoinbaseConnector({
      appName: "Integration Test DApp",
      appChainIds: [1, 137, 8453], // Mainnet, Polygon, Base
    });
  });

  describe("Full connect -> transaction -> disconnect flow", () => {
    it("should complete a full wallet lifecycle", async () => {
      // Step 1: Connect
      mockProvider.request
        .mockResolvedValueOnce(["0x1234567890abcdef1234567890abcdef12345678"]) // eth_requestAccounts
        .mockResolvedValueOnce("0x1"); // eth_chainId

      const session = await connector.connect();
      expect(session).toBeDefined();
      expect(session.id).toBeTypeOf("string");

      // Step 2: Get accounts
      mockProvider.request.mockResolvedValueOnce([
        "0x1234567890abcdef1234567890abcdef12345678",
      ]);
      const accounts = await connector.getAccounts(session);
      expect(accounts.length).toBe(1);
      expect(accounts[0]).toContain("0x");

      // Step 3: Sign a message
      mockProvider.request.mockResolvedValueOnce("0xsignatureabc123");
      const sig = await connector.signMessage(session, {
        message: "Hello Coinbase!",
        address: "0x1234567890abcdef1234567890abcdef12345678",
      });
      expect(sig).toBe("0xsignatureabc123");

      // Step 4: Send a transaction
      mockProvider.request.mockResolvedValueOnce("0xtxhash0001");
      const txHash = await connector.sendTransaction(session, {
        transaction: {
          to: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          value: "0x1000",
        },
      });
      expect(txHash).toBe("0xtxhash0001");

      // Step 5: Disconnect
      await connector.disconnect(session);
      expect(mockProvider.disconnect).toHaveBeenCalled();

      // Step 6: After disconnect, raw requests should fail
      await expect(
        connector.request({ method: "eth_blockNumber", params: [] }),
      ).rejects.toThrow();
    });
  });

  describe("Chain switching flow", () => {
    it("should switch from mainnet to polygon", async () => {
      mockProvider.request
        .mockResolvedValueOnce(["0x1234567890abcdef1234567890abcdef12345678"])
        .mockResolvedValueOnce("0x1");

      await connector.connect();

      // Switch to Polygon (chainId 137 = 0x89)
      mockProvider.request.mockResolvedValueOnce(null);

      const session = {
        id: "test",
        walletId: "coinbase-wallet",
        walletType: "eip6963" as const,
        namespaces: {
          eip155: {
            chains: ["eip155:1"],
            accounts: ["eip155:1:0x1234"],
            methods: [],
            events: [],
          },
        },
        platform: "desktop-web" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await connector.switchChain(session, "eip155:137");

      expect(mockProvider.request).toHaveBeenCalledWith({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x89" }],
      });
    });
  });

  describe("Smart Wallet preference", () => {
    it("should create connector with smartWalletOnly preference", () => {
      const smartConnector = new CoinbaseConnector({
        appName: "Smart Wallet Test",
        preference: "smartWalletOnly",
      });
      expect(smartConnector.config.preference).toBe("smartWalletOnly");
    });

    it("should detect smart-wallet connection mode", async () => {
      const smartConnector = new CoinbaseConnector({
        appName: "Smart Wallet Test",
        appChainIds: [1],
        preference: "smartWalletOnly",
      });

      mockProvider.request
        .mockResolvedValueOnce(["0x1234567890abcdef1234567890abcdef12345678"])
        .mockResolvedValueOnce("0x1");

      await smartConnector.connect();
      expect(smartConnector.getConnectionMode()).toBe("smart-wallet");
    });
  });

  describe("Session expiry handler", () => {
    it("should call session expiry handler on provider disconnect event", async () => {
      mockProvider.request
        .mockResolvedValueOnce(["0x1234567890abcdef1234567890abcdef12345678"])
        .mockResolvedValueOnce("0x1");

      await connector.connect();

      const expiryHandler = vi.fn();
      connector.onSessionExpiry(expiryHandler);

      // Find the disconnect handler and invoke it
      const disconnectCall = mockProvider.on.mock.calls.find(
        (call) => call[0] === "disconnect",
      );
      expect(disconnectCall).toBeDefined();
      const disconnectHandler = disconnectCall![1] as () => void;
      disconnectHandler();

      expect(expiryHandler).toHaveBeenCalledTimes(1);
    });

    it("should call session expiry handler when accounts become empty", async () => {
      mockProvider.request
        .mockResolvedValueOnce(["0x1234567890abcdef1234567890abcdef12345678"])
        .mockResolvedValueOnce("0x1");

      await connector.connect();

      const expiryHandler = vi.fn();
      connector.onSessionExpiry(expiryHandler);

      // Find the accountsChanged handler and invoke with empty array
      const accountsChangedCall = mockProvider.on.mock.calls.find(
        (call) => call[0] === "accountsChanged",
      );
      expect(accountsChangedCall).toBeDefined();
      const accountsChangedHandler = accountsChangedCall![1] as (
        accounts: unknown,
      ) => void;
      accountsChangedHandler([]);

      expect(expiryHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe("Raw JSON-RPC requests", () => {
    it("should forward requests to provider", async () => {
      mockProvider.request
        .mockResolvedValueOnce(["0x1234567890abcdef1234567890abcdef12345678"])
        .mockResolvedValueOnce("0x1");

      await connector.connect();

      mockProvider.request.mockResolvedValueOnce("0x10"); // block number
      const result = await connector.request({
        method: "eth_blockNumber",
        params: [],
      });
      expect(result).toBe("0x10");
    });
  });

  describe("sendCalls with fallback", () => {
    it("should fallback to individual eth_sendTransaction when wallet_sendCalls fails", async () => {
      mockProvider.request
        .mockResolvedValueOnce(["0x1234567890abcdef1234567890abcdef12345678"])
        .mockResolvedValueOnce("0x1");

      await connector.connect();

      // First call (wallet_sendCalls) fails
      mockProvider.request.mockRejectedValueOnce(
        new Error("method not supported"),
      );

      // Fallback: individual eth_sendTransaction calls succeed
      mockProvider.request.mockResolvedValueOnce("0xtxhash1");
      mockProvider.request.mockResolvedValueOnce("0xtxhash2");

      const session = {
        id: "test",
        walletId: "coinbase-wallet",
        walletType: "eip6963" as const,
        namespaces: {
          eip155: {
            chains: ["eip155:1"],
            accounts: ["eip155:1:0x1234"],
            methods: [],
            events: [],
          },
        },
        platform: "desktop-web" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const result = await connector.sendCalls(session, [
        { to: "0xabcd" as `0x${string}` },
        { to: "0xef01" as `0x${string}` },
      ]);
      expect(result).toBe("0xtxhash1,0xtxhash2");
    });
  });
});

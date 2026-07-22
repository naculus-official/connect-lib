import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @coinbase/wallet-sdk before any imports
const mockProvider = {
  request: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
  isCoinbaseWallet: true,
};

const mockMakeWeb3Provider = vi.fn().mockReturnValue(mockProvider);
const mockGetLogo = vi.fn().mockReturnValue("data:image/svg+xml;...");

class MockCoinbaseWalletSDK {
  makeWeb3Provider = mockMakeWeb3Provider;
  getCoinbaseWalletLogo = mockGetLogo;
  storeLatestVersion = vi.fn();
}

vi.mock("@coinbase/wallet-sdk", () => ({
  default: MockCoinbaseWalletSDK,
  CoinbaseWalletSDK: MockCoinbaseWalletSDK,
}));

const { CoinbaseConnector, createCoinbaseConnector } = await import(
  "./connector"
);
const { CoinbaseProviderAdapter } = await import("./provider");

describe("CoinbaseConnector", () => {
  let connector: InstanceType<typeof CoinbaseConnector>;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new CoinbaseConnector({
      appName: "Test DApp",
      appChainIds: [1, 137],
    });
  });

  describe("constructor", () => {
    it("should initialize with valid config", () => {
      expect(connector.id).toBe("coinbase");
      expect(connector.name).toBe("Coinbase Wallet");
      expect(connector.kind).toBe("eip6963");
      expect(connector.namespaces).toEqual(["eip155"]);
      expect(connector.supports.desktop).toBe(true);
      expect(connector.supports.mobile).toBe(true);
      expect(connector.supports.qr).toBe(true);
      expect(connector.supports.trustedReconnect).toBe(false);
    });

    it("should throw on missing appName", () => {
      expect(() => new CoinbaseConnector({} as any)).toThrow();
    });

    it("should default appChainIds to [1]", () => {
      const c = new CoinbaseConnector({ appName: "Test" });
      expect(c.config.appChainIds).toEqual([1]);
    });

    it("should default preference to 'all'", () => {
      const c = new CoinbaseConnector({ appName: "Test" });
      expect(c.config.preference).toBe("all");
    });
  });

  describe("connect", () => {
    it("should successfully connect and return a UniversalWalletSession", async () => {
      mockProvider.request
        .mockResolvedValueOnce(["0x1234567890abcdef1234567890abcdef12345678"]) // eth_requestAccounts
        .mockResolvedValueOnce("0x1"); // eth_chainId

      const session = await connector.connect();

      expect(session).toBeDefined();
      expect(session.id).toBeDefined();
      expect(session.walletType).toBe("eip6963");
      expect(session.walletId).toBe("coinbase-wallet");
      expect(session.namespaces.eip155).toBeDefined();
      expect(session.namespaces.eip155.chains).toContain("eip155:1");
      expect(session.namespaces.eip155.accounts.length).toBeGreaterThan(0);
      expect(session.namespaces.eip155.methods).toContain(
        "eth_sendTransaction",
      );
      expect(session.namespaces.eip155.events).toContain("accountsChanged");
    });

    it("should throw user_rejected when no accounts returned", async () => {
      mockProvider.request
        .mockResolvedValueOnce([]) // empty accounts
        .mockResolvedValueOnce("0x1");

      await expect(connector.connect()).rejects.toThrow("No accounts returned");
    });

    it("should throw user_rejected on user rejection", async () => {
      mockProvider.request.mockRejectedValueOnce(new Error("User rejected"));

      await expect(connector.connect()).rejects.toThrow("User rejected");
    });

    it("should subscribe to provider events after connect", async () => {
      mockProvider.request
        .mockResolvedValueOnce(["0x1234567890abcdef1234567890abcdef12345678"])
        .mockResolvedValueOnce("0x1");

      await connector.connect();

      expect(mockProvider.on).toHaveBeenCalledWith(
        "accountsChanged",
        expect.any(Function),
      );
      expect(mockProvider.on).toHaveBeenCalledWith(
        "chainChanged",
        expect.any(Function),
      );
      expect(mockProvider.on).toHaveBeenCalledWith(
        "disconnect",
        expect.any(Function),
      );
    });
  });

  describe("reconnect", () => {
    it("should throw session_expired", async () => {
      const mockSession = {
        id: "test",
        walletId: "coinbase-wallet",
        walletType: "eip6963" as const,
        namespaces: {
          eip155: {
            chains: ["eip155:1"],
            accounts: ["eip155:1:0x123"],
            methods: [],
            events: [],
          },
        },
        platform: "desktop-web" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await expect(connector.reconnect(mockSession)).rejects.toThrow(
        "does not support silent reconnection",
      );
    });
  });

  describe("disconnect", () => {
    it("should call provider.disconnect and clean up", async () => {
      // First connect
      mockProvider.request
        .mockResolvedValueOnce(["0x1234567890abcdef1234567890abcdef12345678"])
        .mockResolvedValueOnce("0x1");

      await connector.connect();

      // Now disconnect
      const session = {
        id: "test",
        walletId: "coinbase-wallet",
        walletType: "eip6963" as const,
        namespaces: {
          eip155: {
            chains: ["eip155:1"],
            accounts: ["eip155:1:0x123"],
            methods: [],
            events: [],
          },
        },
        platform: "desktop-web" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await connector.disconnect(session);

      expect(mockProvider.disconnect).toHaveBeenCalled();
    });

    it("should not throw when provider is not initialized", async () => {
      const session = {
        id: "test",
        walletId: "coinbase-wallet",
        walletType: "eip6963" as const,
        namespaces: {
          eip155: {
            chains: ["eip155:1"],
            accounts: ["eip155:1:0x123"],
            methods: [],
            events: [],
          },
        },
        platform: "desktop-web" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await expect(connector.disconnect(session)).resolves.not.toThrow();
    });
  });

  describe("getAccounts", () => {
    it("should return accounts from provider when available", async () => {
      mockProvider.request
        .mockResolvedValueOnce(["0x1234567890abcdef1234567890abcdef12345678"])
        .mockResolvedValueOnce("0x1");

      await connector.connect();

      mockProvider.request.mockResolvedValueOnce([
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdef",
      ]);

      const session = {
        id: "test",
        walletId: "coinbase-wallet",
        walletType: "eip6963" as const,
        namespaces: {
          eip155: {
            chains: ["eip155:1"],
            accounts: ["eip155:1:0x123"],
            methods: [],
            events: [],
          },
        },
        platform: "desktop-web" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const accounts = await connector.getAccounts(session);
      expect(accounts.length).toBeGreaterThan(0);
    });
  });

  describe("signMessage", () => {
    it("should sign with personal_sign for plain messages", async () => {
      mockProvider.request
        .mockResolvedValueOnce(["0x1234"])
        .mockResolvedValueOnce("0x1");
      await connector.connect();

      mockProvider.request.mockResolvedValueOnce("0xsignature");

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

      const result = await connector.signMessage(session, {
        message: "Hello World",
        address: "0x1234",
      });

      expect(result).toBe("0xsignature");
      expect(mockProvider.request).toHaveBeenCalledWith({
        method: "personal_sign",
        params: ["0x48656c6c6f20576f726c64", "0x1234"],
      });
    });

    it("should throw with invalid input", async () => {
      await expect(connector.signMessage({} as any, null)).rejects.toThrow();
    });
  });

  describe("sendTransaction", () => {
    it("should send a transaction via eth_sendTransaction", async () => {
      mockProvider.request
        .mockResolvedValueOnce(["0x1234"])
        .mockResolvedValueOnce("0x1");
      await connector.connect();

      mockProvider.request.mockResolvedValueOnce("0xtxhash");

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

      const result = await connector.sendTransaction(session, {
        transaction: {
          to: "0xabcd",
          value: "0x100",
          data: "0x",
        },
      });

      expect(result).toBe("0xtxhash");
      expect(mockProvider.request).toHaveBeenCalledWith({
        method: "eth_sendTransaction",
        params: [{ to: "0xabcd", value: "0x100", data: "0x" }],
      });
    });
  });

  describe("switchChain", () => {
    it("should switch chain via wallet_switchEthereumChain", async () => {
      mockProvider.request
        .mockResolvedValueOnce(["0x1234"])
        .mockResolvedValueOnce("0x1");
      await connector.connect();

      mockProvider.request.mockResolvedValueOnce(null);

      const session = {
        id: "test",
        walletId: "coinbase-wallet",
        walletType: "eip6963" as const,
        namespaces: {
          eip155: {
            chains: ["eip155:1"],
            accounts: [],
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

    it("should throw for non-EVM chains", async () => {
      // Connect first so provider is available
      mockProvider.request
        .mockResolvedValueOnce(["0x1234567890abcdef1234567890abcdef12345678"])
        .mockResolvedValueOnce("0x1");

      await connector.connect();

      const session = {
        id: "test",
        walletId: "coinbase-wallet",
        walletType: "eip6963" as const,
        namespaces: {
          eip155: {
            chains: ["eip155:1"],
            accounts: [],
            methods: [],
            events: [],
          },
        },
        platform: "desktop-web" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await expect(connector.switchChain(session, "solana:0")).rejects.toThrow(
        "only supports EVM chains",
      );
    });
  });

  describe("getBalance", () => {
    it("should throw when no session", async () => {
      await expect(connector.getBalance()).rejects.toThrow();
    });
  });

  describe("request", () => {
    it("should make a raw provider request", async () => {
      mockProvider.request
        .mockResolvedValueOnce(["0x1234"])
        .mockResolvedValueOnce("0x1");
      await connector.connect();

      mockProvider.request.mockResolvedValueOnce("0xresult");
      const result = await connector.request({
        method: "eth_blockNumber",
        params: [],
      });
      expect(result).toBe("0xresult");
    });
  });

  describe("isExtensionMode", () => {
    it("should return false when not connected", () => {
      expect(connector.isExtensionMode()).toBe(false);
    });

    it("should return false after connect (default walletlink)", async () => {
      mockProvider.request
        .mockResolvedValueOnce(["0x1234"])
        .mockResolvedValueOnce("0x1");
      await connector.connect();
      expect(connector.isExtensionMode()).toBe(false);
    });
  });

  describe("getConnectionMode", () => {
    it("should return undefined when not connected", () => {
      expect(connector.getConnectionMode()).toBeUndefined();
    });

    it("should return connection mode after connect", async () => {
      mockProvider.request
        .mockResolvedValueOnce(["0x1234"])
        .mockResolvedValueOnce("0x1");
      await connector.connect();
      expect(connector.getConnectionMode()).toBe("walletlink");
    });
  });

  describe("CoinbaseProviderAdapter", () => {
    it("should delegate on/off to provider", () => {
      const adapter = new CoinbaseProviderAdapter(mockProvider as any);
      const handler = vi.fn();
      adapter.on("accountsChanged", handler);
      expect(mockProvider.on).toHaveBeenCalledWith("accountsChanged", handler);
    });

    it("should not register duplicate handlers", () => {
      const adapter = new CoinbaseProviderAdapter(mockProvider as any);
      const handler = vi.fn();
      adapter.on("accountsChanged", handler);
      adapter.on("accountsChanged", handler);
      expect(mockProvider.on).toHaveBeenCalledTimes(1);
    });

    it("should cleanup all listeners", () => {
      const adapter = new CoinbaseProviderAdapter(mockProvider as any);
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      adapter.on("accountsChanged", handler1);
      adapter.on("chainChanged", handler2);
      adapter.cleanup();
      expect(mockProvider.off).toHaveBeenCalledTimes(2);
    });
  });
});

describe("createCoinbaseConnector", () => {
  it("should create a CoinbaseConnector instance", () => {
    const c = createCoinbaseConnector({ appName: "Test" });
    expect(c).toBeInstanceOf(CoinbaseConnector);
    expect(c.config.appName).toBe("Test");
  });
});

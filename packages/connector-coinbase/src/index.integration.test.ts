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
    vi.resetAllMocks();
    mockMakeWeb3Provider.mockReturnValue(mockProvider);
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
            accounts: ["eip155:1:0x1234000000000000000000000000000000000000"],
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

    it("should expire the session when an account event is malformed", async () => {
      mockProvider.request
        .mockResolvedValueOnce(["0x1234567890abcdef1234567890abcdef12345678"])
        .mockResolvedValueOnce("0x1");

      await connector.connect();

      const expiryHandler = vi.fn();
      connector.onSessionExpiry(expiryHandler);
      const accountsChangedCall = mockProvider.on.mock.calls.find(
        (call) => call[0] === "accountsChanged",
      );
      expect(accountsChangedCall).toBeDefined();
      const accountsChangedHandler = accountsChangedCall![1] as (
        accounts: unknown,
      ) => void;
      accountsChangedHandler(["not-an-address"]);

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
            accounts: ["eip155:1:0x1234000000000000000000000000000000000000"],
            methods: [],
            events: [],
          },
        },
        platform: "desktop-web" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const result = await connector.sendCalls(session, [
        { to: "0x000000000000000000000000000000000000abcd" as `0x${string}` },
        { to: "0x000000000000000000000000000000000000ef01" as `0x${string}` },
      ]);
      expect(result).toBe("0xtxhash1,0xtxhash2");
    });

    it("passes an ERC-7677 paymaster service to wallet_sendCalls", async () => {
      mockProvider.request
        .mockResolvedValueOnce(["0x1234567890abcdef1234567890abcdef12345678"])
        .mockResolvedValueOnce("0x1");
      const session = await connector.connect();
      mockProvider.request.mockResolvedValueOnce({ id: "bundle-id" });

      await connector.sendCalls(
        session,
        [{ to: "0x000000000000000000000000000000000000abcd" }],
        "eip155:1",
        {
          paymasterService: {
            url: "https://paymaster.example/rpc",
            context: { policy: "checkout" },
          },
        },
      );

      expect(mockProvider.request).toHaveBeenLastCalledWith({
        method: "wallet_sendCalls",
        params: [
          expect.objectContaining({
            capabilities: {
              paymasterService: {
                url: "https://paymaster.example/rpc",
                context: { policy: "checkout" },
              },
            },
          }),
        ],
      });
    });

    it("does not silently charge the user when paymaster routing is unsupported", async () => {
      mockProvider.request
        .mockResolvedValueOnce(["0x1234567890abcdef1234567890abcdef12345678"])
        .mockResolvedValueOnce("0x1");
      const session = await connector.connect();
      mockProvider.request.mockClear();
      mockProvider.request.mockRejectedValueOnce(
        Object.assign(new Error("method not supported"), { code: -32601 }),
      );

      await expect(
        connector.sendCalls(
          session,
          [{ to: "0x000000000000000000000000000000000000abcd" }],
          "eip155:1",
          { paymasterService: { url: "https://paymaster.example/rpc" } },
        ),
      ).rejects.toThrow("method not supported");
      expect(mockProvider.request).toHaveBeenCalledTimes(1);
      expect(mockProvider.request).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: "eth_sendTransaction" }),
      );
    });
  });

  /**
   * EIP-5792 capability discovery.
   *
   * This connector used to answer from a non-standard `capabilities` key on
   * the session namespace, which nothing populates, and so reported
   * `supported: false` for every chain. Coinbase Smart Wallet is a reference
   * EIP-5792 implementation: the invented "no" was wrong for precisely the
   * wallet this connector serves.
   */
  describe("getCapabilities", () => {
    const session = {
      id: "test",
      walletId: "coinbase-wallet",
      walletType: "eip6963" as const,
      namespaces: {
        eip155: {
          chains: ["eip155:1", "eip155:8453"],
          accounts: [
            "eip155:1:0x1234567890abcdef1234567890abcdef12345678",
            "eip155:8453:0x1234567890abcdef1234567890abcdef12345678",
          ],
          methods: [],
          events: [],
        },
      },
      platform: "desktop-web" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const connectThen = async (outcome: () => void) => {
      mockProvider.request
        .mockResolvedValueOnce(["0x1234567890abcdef1234567890abcdef12345678"])
        .mockResolvedValueOnce("0x1");
      await connector.connect();
      outcome();
    };

    it("asks the provider rather than reading the session", async () => {
      await connectThen(() => {
        mockProvider.request.mockResolvedValueOnce({
          "0x1": { atomic: { status: "supported" } },
          "0x2105": { atomic: { status: "unsupported" } },
        });
      });

      const caps = await connector.getCapabilities(session);
      const last = mockProvider.request.mock.calls.at(-1)?.[0];
      expect(last.method).toBe("wallet_getCapabilities");
      expect(last.params[1]).toEqual(["0x1", "0x2105"]);
      expect(caps["eip155:1"].atomicBatch.supported).toBe(true);
      expect(caps["eip155:8453"].atomicBatch.supported).toBe(false);
    });

    it("propagates a failed query instead of inventing a no", async () => {
      // getAccountCapabilities turns this into discovered: false, which is a
      // different fact from the wallet declining.
      await connectThen(() => {
        mockProvider.request.mockRejectedValueOnce(
          new Error("method not supported"),
        );
      });
      await expect(connector.getCapabilities(session)).rejects.toThrow(
        /not supported/,
      );
    });

    it("refuses a session with no EVM chains", async () => {
      await connectThen(() => {});
      await expect(
        connector.getCapabilities({
          ...session,
          namespaces: {},
        } as never),
      ).rejects.toThrow(/EVM chains/);
    });
  });

  /**
   * Wallet-initiated account and chain changes.
   *
   * This connector already re-keyed the session on both provider events, but
   * had no way to tell anyone, so nothing downstream ever learned about an
   * in-wallet switch. The subscription is what makes the update reach a UI.
   */
  describe("onAccountsChanged / onChainChanged", () => {
    const connectFirst = async () => {
      mockProvider.request
        .mockResolvedValueOnce(["0x1234567890abcdef1234567890abcdef12345678"])
        .mockResolvedValueOnce("0x1");
      return connector.connect();
    };

    const fire = (event: string, payload: unknown) => {
      const call = mockProvider.on.mock.calls.find(([name]) => name === event);
      if (!call) throw new Error(`connector never registered "${event}"`);
      (call[1] as (arg: unknown) => void)(payload);
    };

    it("notifies with re-keyed CAIP-10 accounts", async () => {
      const session = await connectFirst();
      const seen: string[][] = [];
      connector.onAccountsChanged(session, (accounts) => seen.push(accounts));

      fire("accountsChanged", ["0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"]);

      expect(seen).toHaveLength(1);
      expect(seen[0][0]).toMatch(/^eip155:\d+:0xabcdef/i);
    });

    it("signals a disconnect with an empty list", async () => {
      const session = await connectFirst();
      const seen: string[][] = [];
      connector.onAccountsChanged(session, (accounts) => seen.push(accounts));

      fire("accountsChanged", []);

      expect(seen).toEqual([[]]);
    });

    it("reports a chain switch and the accounts it re-keyed", async () => {
      const session = await connectFirst();
      const chains: string[] = [];
      const accounts: string[][] = [];
      connector.onChainChanged(session, (chainId) => chains.push(chainId));
      connector.onAccountsChanged(session, (next) => accounts.push(next));

      fire("chainChanged", "0x2105");

      expect(chains).toEqual(["eip155:8453"]);
      // A CAIP-10 account is only meaningful against the chain in its prefix,
      // so accounts subscribers must hear about a chain switch too.
      expect(accounts[0]?.[0]).toContain("eip155:8453:");
    });

    it("ignores a malformed chain value rather than corrupting the session", async () => {
      const session = await connectFirst();
      const chains: string[] = [];
      connector.onChainChanged(session, (chainId) => chains.push(chainId));

      fire("chainChanged", "not-hex");

      expect(chains).toEqual([]);
    });

    it("does not stack provider listeners across reconnects", async () => {
      // setupEventListeners runs inside connect() and installs fresh closures,
      // so the adapter's identity-based dedupe never applied. Two connects
      // meant one wallet event was reported twice.
      await connectFirst();
      mockProvider.request
        .mockResolvedValueOnce(["0x1234567890abcdef1234567890abcdef12345678"])
        .mockResolvedValueOnce("0x1");
      await connector.connect();

      const session = {
        id: "t",
        walletId: "coinbase-wallet",
        walletType: "eip6963" as const,
        namespaces: {
          eip155: {
            chains: ["eip155:1"],
            accounts: ["eip155:1:0x1234567890abcdef1234567890abcdef12345678"],
            methods: [],
            events: [],
          },
        },
        platform: "desktop-web" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const seen: string[][] = [];
      connector.onAccountsChanged(session, (accounts) => seen.push(accounts));

      const live = mockProvider.on.mock.calls.filter(
        ([name]) => name === "accountsChanged",
      ).length;
      const removed = mockProvider.off.mock.calls.filter(
        ([name]) => name === "accountsChanged",
      ).length;
      expect(live - removed).toBe(1);
    });

    it("stops notifying after unsubscribe", async () => {
      const session = await connectFirst();
      const subscriber = vi.fn();
      connector.onAccountsChanged(session, subscriber)();

      fire("accountsChanged", ["0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"]);

      expect(subscriber).not.toHaveBeenCalled();
    });
  });
});

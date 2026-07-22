import type { UniversalWalletSession } from "@naculus/connect-core";
import { createEmptySession } from "@naculus/connect-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isCoinbaseWalletInstalled as discoveryIsCoinbase,
  isMetaMaskInstalled as discoveryIsMetaMask,
} from "./discovery";
import type { DiscoveredWallet, Eip6963EthereumProvider } from "./index";
import {
  createEIP6963Connector,
  EIP6963Connector,
  eip6963Connector,
  getEIP6963Provider,
  isCoinbaseWalletInstalled,
  isMetaMaskInstalled,
  isWalletInstalled,
} from "./index";
import { toHexValue } from "./utils";

function createMockProvider(overrides = {}) {
  return {
    request: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    ...overrides,
  };
}

function createMockDiscoveredWallet(
  provider: Eip6963EthereumProvider,
): DiscoveredWallet {
  return {
    id: "test-wallet",
    name: "Test Wallet",
    icon: "data:image/svg+xml;base64,test",
    rdns: "io.test.wallet",
    provider,
  };
}

function createMockEIP6963Session(wallet: DiscoveredWallet) {
  return {
    wallet,
    accounts: ["eip155:0x1234567890abcdef1234567890abcdef12345678"],
    chains: ["eip155:1"],
    methods: [
      "eth_requestAccounts",
      "eth_sendTransaction",
      "personal_sign",
      "eth_signTypedData_v4",
    ],
    events: ["accountsChanged", "chainChanged"],
  };
}

function createSession(overrides = {}): UniversalWalletSession {
  return createEmptySession({
    id: "eip6963-test-wallet-1234567890",
    walletId: "test-wallet",
    walletType: "eip6963",
    namespaces: {
      eip155: {
        chains: ["eip155:1"],
        accounts: ["eip155:0x1234567890abcdef1234567890abcdef12345678"],
        methods: [
          "eth_requestAccounts",
          "eth_sendTransaction",
          "personal_sign",
          "eth_signTypedData_v4",
        ],
        events: ["accountsChanged", "chainChanged"],
      },
    },
    platform: "desktop-web",
    ...overrides,
  });
}

describe("EIP6963Connector", () => {
  let connector: EIP6963Connector;
  let provider: ReturnType<typeof createMockProvider>;
  let wallet: DiscoveredWallet;

  beforeEach(() => {
    connector = new EIP6963Connector();
    provider = createMockProvider();
    wallet = createMockDiscoveredWallet(provider);
    // Inject wallet into discovery
    (connector as any).discoveredWallets.set(wallet.id, wallet);
    (connector as any).activeSessions.set(
      wallet.id,
      createMockEIP6963Session(wallet),
    );
  });

  afterEach(() => {
    connector.clear();
  });

  describe("constructor", () => {
    it("should create new connector instance", () => {
      const c = new EIP6963Connector();
      expect(c).toBeDefined();
    });

    it("should have correct identity", () => {
      expect(connector.id).toBe("eip6963");
      expect(connector.name).toBe("EIP-6963 Injected Wallets");
      expect(connector.kind).toBe("eip6963");
      expect(connector.namespaces).toEqual(["eip155"]);
    });
  });

  describe("getDiscoveredWallets", () => {
    it("should return empty array initially", () => {
      const c = new EIP6963Connector();
      expect(c.getDiscoveredWallets()).toEqual([]);
    });
  });

  describe("clear", () => {
    it("should clear discovered wallets", () => {
      connector.clear();
      expect(connector.getDiscoveredWallets()).toEqual([]);
    });
  });

  describe("onUpdate", () => {
    it("should register callback", () => {
      const callback = () => {};
      const unsubscribe = connector.onUpdate(callback);
      expect(typeof unsubscribe).toBe("function");
    });
  });

  describe("getWalletByRDNS", () => {
    it("should return undefined for unknown RDNS", () => {
      expect(connector.getWalletByRDNS("unknown")).toBeUndefined();
    });
  });

  describe("connect", () => {
    it("should connect with first discovered wallet when no input", async () => {
      provider.request.mockResolvedValue([
        "0x1234567890abcdef1234567890abcdef12345678",
      ]);
      const session = await connector.connect();
      expect(session.walletType).toBe("eip6963");
      expect(session.namespaces.eip155).toBeDefined();
    });

    it("should throw when no wallet discovered", async () => {
      const c = new EIP6963Connector();
      await expect(c.connect()).rejects.toThrow("No wallets discovered");
    });
  });

  describe("signMessage", () => {
    it("should throw on invalid input", async () => {
      const session = createSession();
      await expect(connector.signMessage(session, null)).rejects.toThrow();
    });

    it("should throw on missing message", async () => {
      const session = createSession();
      await expect(
        connector.signMessage(session, { address: "0x1234" }),
      ).rejects.toThrow();
    });

    it("should sign with personal_sign using session account", async () => {
      provider.request.mockResolvedValue("0xsig");
      const session = createSession();
      const result = await connector.signMessage(session, { message: "hello" });
      expect(provider.request).toHaveBeenCalledWith({
        method: "personal_sign",
        params: [
          "0x" +
            Array.from(new TextEncoder().encode("hello"))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(""),
          "0x1234567890abcdef1234567890abcdef12345678",
        ],
      });
      expect(result).toBe("0xsig");
    });

    it("should use provided address over session account", async () => {
      provider.request.mockResolvedValue("0xsig");
      const session = createSession();
      await connector.signMessage(session, {
        message: "hello",
        address: "eip155:0xdeadbeef",
      });
      expect(provider.request).toHaveBeenCalledWith(
        expect.objectContaining({
          params: [expect.any(String), "0xdeadbeef"],
        }),
      );
    });
  });

  describe("signTransaction", () => {
    it("should throw on missing transaction", async () => {
      const session = createSession();
      await expect(connector.signTransaction(session, {})).rejects.toThrow();
    });

    it("should throw on invalid serialized data", async () => {
      const session = createSession();
      await expect(
        connector.signTransaction(session, { transaction: {} }),
      ).rejects.toThrow();
    });

    it("should sign transaction with serialized bytes", async () => {
      provider.request.mockResolvedValue("0xtxhash");
      const session = createSession();
      const result = await connector.signTransaction(session, {
        transaction: { serialized: [0x01, 0x02, 0x03] },
      });
      expect(provider.request).toHaveBeenCalledWith({
        method: "eth_sendTransaction",
        params: [
          {
            from: "0x1234567890abcdef1234567890abcdef12345678",
            data: "0x010203",
          },
        ],
      });
      expect(result).toBe("0xtxhash");
    });
  });

  describe("sendTransaction", () => {
    it("should throw on missing transaction", async () => {
      const session = createSession();
      await expect(connector.sendTransaction(session, {})).rejects.toThrow();
    });

    it("should send transaction with value hex conversion", async () => {
      provider.request.mockResolvedValue("0xtxhash");
      const session = createSession();
      const result = await connector.sendTransaction(session, {
        transaction: {
          to: "0xdead",
          value: "1000000",
          data: "0xabc",
        },
      });
      expect(provider.request).toHaveBeenCalledWith({
        method: "eth_sendTransaction",
        params: [
          {
            from: "0x1234567890abcdef1234567890abcdef12345678",
            to: "0xdead",
            value: "0xf4240",
            data: "0xabc",
          },
        ],
      });
      expect(result).toBe("0xtxhash");
    });
  });

  describe("sendCalls", () => {
    it("should use wallet_sendCalls when supported", async () => {
      provider.request.mockResolvedValue("0xbatch");
      const session = createSession();
      const result = await connector.sendCalls(session, [
        { to: "0xaddr1", value: "0x1", data: "0x" },
        { to: "0xaddr2", value: "0x2", data: "0x" },
      ]);
      expect(provider.request).toHaveBeenCalledWith({
        method: "wallet_sendCalls",
        params: [
          {
            from: "0x1234567890abcdef1234567890abcdef12345678",
            calls: [
              { to: "0xaddr1", value: "0x1", data: "0x" },
              { to: "0xaddr2", value: "0x2", data: "0x" },
            ],
          },
        ],
      });
      expect(result).toBe("0xbatch");
    });

    it("should fallback to individual eth_sendTransaction", async () => {
      provider.request
        .mockRejectedValueOnce(new Error("not supported"))
        .mockResolvedValueOnce("0xtx1")
        .mockResolvedValueOnce("0xtx2");

      const session = createSession();
      const result = await connector.sendCalls(session, [
        { to: "0xaddr1", value: "0x1", data: "0x" },
        { to: "0xaddr2", value: "0x2", data: "0x" },
      ]);
      expect(result).toBe("0xtx1,0xtx2");
    });
  });

  describe("getCapabilities", () => {
    it("should return capabilities from wallet_getCapabilities", async () => {
      provider.request.mockResolvedValue({
        "eip155:1": { atomicBatch: true },
      });
      const session = createSession();
      const caps = await connector.getCapabilities(session);
      expect(caps["eip155:1"]!.atomicBatch!.supported).toBe(true);
    });

    it("should return defaults when wallet_getCapabilities fails", async () => {
      provider.request.mockRejectedValue(new Error("not supported"));
      const session = createSession();
      const caps = await connector.getCapabilities(session);
      expect(caps["eip155:1"]!.atomicBatch!.supported).toBe(true);
    });
  });

  describe("getBalance", () => {
    it("should return balance from provider", async () => {
      provider.request.mockResolvedValue("0x100");
      const session = createSession();
      const balance = await (connector as any).getBalance();
      expect(provider.request).toHaveBeenCalledWith({
        method: "eth_getBalance",
        params: ["0x1234567890abcdef1234567890abcdef12345678", "latest"],
      });
      expect(balance).toBe("0x100");
    });

    it("should throw when no active session", async () => {
      const c = new EIP6963Connector();
      await expect((c as any).getBalance()).rejects.toThrow("Session expired");
    });
  });

  describe("request", () => {
    it("should forward request to active session provider", async () => {
      provider.request.mockResolvedValue("0xresult");
      const result = await connector.request({
        method: "eth_chainId",
        params: [],
      });
      expect(provider.request).toHaveBeenCalledWith({
        method: "eth_chainId",
        params: [],
      });
      expect(result).toBe("0xresult");
    });
  });

  describe("reconnect", () => {
    it("should throw when wallet not discovered", async () => {
      const session = createSession({ walletId: "unknown-wallet" });
      await expect(connector.reconnect(session)).rejects.toThrow(
        "EIP-6963 wallet not found",
      );
    });

    it("should reconnect with discovered wallet", async () => {
      provider.request.mockResolvedValue([
        "0x1234567890abcdef1234567890abcdef12345678",
      ]);
      const session = createSession();
      const result = await connector.reconnect(session);
      expect(result.walletId).toBe("test-wallet");
    });
  });

  describe("disconnect", () => {
    it("should disconnect active session", async () => {
      const session = createSession();
      await connector.disconnect(session);
      expect((connector as any).activeSessions.size).toBe(0);
    });
  });

  describe("getAccounts", () => {
    it("should return accounts from session", async () => {
      const session = createSession();
      const accounts = await connector.getAccounts(session);
      expect(accounts).toEqual([
        "eip155:0x1234567890abcdef1234567890abcdef12345678",
      ]);
    });
  });
});

describe("createEIP6963Connector", () => {
  it("should create connector factory function", () => {
    const connector = createEIP6963Connector();
    expect(connector).toBeInstanceOf(EIP6963Connector);
  });
});

describe("toHexValue", () => {
  it("should convert decimal string to hex", () => {
    expect(toHexValue("1000000")).toBe("0xf4240");
  });

  it("should return 0x-prefixed strings unchanged", () => {
    expect(toHexValue("0xabc")).toBe("0xabc");
  });
});

describe("isMetaMaskInstalled", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should return true when window.ethereum.isMetaMask", () => {
    vi.stubGlobal("window", { ethereum: { isMetaMask: true } } as any);
    expect(isMetaMaskInstalled()).toBe(true);
  });

  it("should return false when not present", () => {
    vi.stubGlobal("window", {} as any);
    expect(isMetaMaskInstalled()).toBe(false);
  });

  it("should return false in SSR", () => {
    const win = globalThis.window;
    vi.stubGlobal("window", undefined);
    expect(isMetaMaskInstalled()).toBe(false);
    vi.stubGlobal("window", win);
  });
});

describe("isCoinbaseWalletInstalled", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should return true when window.ethereum.isCoinbaseWallet", () => {
    vi.stubGlobal("window", { ethereum: { isCoinbaseWallet: true } } as any);
    expect(isCoinbaseWalletInstalled()).toBe(true);
  });

  it("should return false when not present", () => {
    vi.stubGlobal("window", {} as any);
    expect(isCoinbaseWalletInstalled()).toBe(false);
  });
});

describe("isWalletInstalled", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should return boolean", () => {
    const result = isWalletInstalled("unknown");
    expect(typeof result).toBe("boolean");
  });

  it("should return false in SSR", () => {
    const win = globalThis.window;
    vi.stubGlobal("window", undefined);
    expect(isWalletInstalled("io.test.wallet")).toBe(false);
    vi.stubGlobal("window", win);
  });
});

describe("getEIP6963Provider", () => {
  afterEach(() => {
    eip6963Connector.clear();
  });

  it("should return null for unknown rdns", () => {
    expect(getEIP6963Provider("unknown")).toBeNull();
  });
});

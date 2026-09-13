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
    accounts: ["eip155:1:0x1234567890abcdef1234567890abcdef12345678"],
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
        accounts: ["eip155:1:0x1234567890abcdef1234567890abcdef12345678"],
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
      provider.request.mockImplementation(async ({ method }) =>
        method === "eth_chainId"
          ? "0x1"
          : ["0x1234567890abcdef1234567890abcdef12345678"],
      );
      const session = await connector.connect();
      expect(session.walletType).toBe("eip6963");
      expect(session.namespaces.eip155).toBeDefined();
    });

    it("uses a wallet announced while discovery is waiting", async () => {
      const delayedConnector = new EIP6963Connector();
      const delayedProvider = createMockProvider({
        request: vi
          .fn()
          .mockImplementation(async ({ method }) =>
            method === "eth_chainId"
              ? "0x1"
              : ["0x1234567890abcdef1234567890abcdef12345678"],
          ),
      });
      const delayedWallet = createMockDiscoveredWallet(delayedProvider);
      setTimeout(() => {
        (delayedConnector as any).discoveredWallets.set(
          delayedWallet.id,
          delayedWallet,
        );
      }, 10);

      const session = await delayedConnector.connect();
      expect(session.walletId).toBe(delayedWallet.id);
      delayedConnector.clear();
    });

    it("should throw when no wallet discovered", async () => {
      const c = new EIP6963Connector();
      await expect(c.connect()).rejects.toThrow("No wallet available");
    });

    it("keeps the session account in sync after accountsChanged", async () => {
      provider.request.mockImplementation(async ({ method }) =>
        method === "eth_chainId"
          ? "0x1"
          : ["0x1234567890abcdef1234567890abcdef12345678"],
      );
      const session = await connector.connect(wallet);
      const accountsHandler = provider.on.mock.calls.find(
        ([event]) => event === "accountsChanged",
      )?.[1] as ((accounts: string[]) => void) | undefined;

      accountsHandler?.(["0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"]);

      expect(session.namespaces.eip155?.accounts).toEqual([
        "eip155:1:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      ]);
      expect((connector as any).activeSessions.get(wallet.id).accounts).toEqual(
        ["eip155:1:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"],
      );
    });

    it("normalizes chainChanged and rebinds CAIP-10 accounts", async () => {
      provider.request.mockImplementation(async ({ method }) =>
        method === "eth_chainId"
          ? "0x1"
          : ["0x1234567890abcdef1234567890abcdef12345678"],
      );
      const session = await connector.connect(wallet);
      const chainHandler = provider.on.mock.calls.find(
        ([event]) => event === "chainChanged",
      )?.[1] as ((chainId: string) => void) | undefined;

      chainHandler?.("0x89");

      expect(session.namespaces.eip155?.chains).toEqual(["eip155:137"]);
      expect(session.namespaces.eip155?.accounts).toEqual([
        "eip155:137:0x1234567890abcdef1234567890abcdef12345678",
      ]);
      expect((connector as any).activeSessions.get(wallet.id).chains).toEqual([
        "eip155:137",
      ]);
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

    it("should reject a provided address outside the session account", async () => {
      provider.request.mockResolvedValue("0xsig");
      const session = createSession();
      await expect(
        connector.signMessage(session, {
          message: "hello",
          address: "eip155:1:0xdeadbeef00000000000000000000000000000000",
        }),
      ).rejects.toThrow("connected EVM accounts");
      expect(provider.request).not.toHaveBeenCalled();
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

    it("rejects serialized bytes instead of broadcasting them", async () => {
      const session = createSession();
      await expect(
        connector.signTransaction(session, {
          transaction: { serialized: [0x01, 0x02, 0x03] },
        }),
      ).rejects.toThrow("cannot safely decode");
      expect(provider.request).not.toHaveBeenCalled();
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
          to: "0x000000000000000000000000000000000000dead",
          value: "1000000",
          data: "0xabcd",
        },
      });
      expect(provider.request).toHaveBeenCalledWith({
        method: "eth_sendTransaction",
        params: [
          {
            from: "0x1234567890abcdef1234567890abcdef12345678",
            to: "0x000000000000000000000000000000000000dead",
            value: "0xf4240",
            data: "0xabcd",
          },
        ],
      });
      expect(result).toBe("0xtxhash");
    });

    it("rejects malformed EIP-1474 quantities before provider access", async () => {
      const session = createSession();
      await expect(
        connector.sendTransaction(session, {
          transaction: {
            to: "0x000000000000000000000000000000000000dead",
            value: "0xnot-hex",
          },
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(provider.request).not.toHaveBeenCalled();
    });

    it("rejects a transaction from an account outside the session", async () => {
      const session = createSession();
      await expect(
        connector.sendTransaction(session, {
          transaction: {
            from: "0x0000000000000000000000000000000000000001",
            to: "0x000000000000000000000000000000000000dead",
          },
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(provider.request).not.toHaveBeenCalled();
    });

    it("rejects a transaction chain that differs from the active chain", async () => {
      const session = createSession();
      await expect(
        connector.sendTransaction(session, {
          transaction: {
            chainId: "0x89",
            to: "0x000000000000000000000000000000000000dead",
          },
        }),
      ).rejects.toMatchObject({ code: "chain_mismatch" });
      expect(provider.request).not.toHaveBeenCalled();
    });
  });

  describe("sendCalls", () => {
    it("should use wallet_sendCalls when supported", async () => {
      provider.request.mockResolvedValue("0xbatch");
      const session = createSession();
      const result = await connector.sendCalls(session, [
        {
          to: "0x0000000000000000000000000000000000000001",
          value: "0x1",
          data: "0x",
        },
        {
          to: "0x0000000000000000000000000000000000000002",
          value: "0x2",
          data: "0x",
        },
      ]);
      expect(provider.request).toHaveBeenCalledWith({
        method: "wallet_sendCalls",
        params: [
          {
            version: "2.0.0",
            from: "0x1234567890abcdef1234567890abcdef12345678",
            chainId: "0x1",
            atomicRequired: false,
            calls: [
              {
                to: "0x0000000000000000000000000000000000000001",
                value: "0x1",
                data: "0x",
              },
              {
                to: "0x0000000000000000000000000000000000000002",
                value: "0x2",
                data: "0x",
              },
            ],
          },
        ],
      });
      expect(result).toBe("0xbatch");
    });

    it("allows contract-creation calls without a to address", async () => {
      provider.request.mockResolvedValue("0xbatch");
      const result = await connector.sendCalls(createSession(), [
        { data: "0x6000600055", value: "0x0" },
      ]);

      expect(result).toBe("0xbatch");
      expect(provider.request).toHaveBeenCalledWith({
        method: "wallet_sendCalls",
        params: [
          expect.objectContaining({
            calls: [{ data: "0x6000600055", value: "0x0" }],
          }),
        ],
      });
    });

    it("extracts the EIP-5792 bundle id from an object result", async () => {
      provider.request.mockResolvedValue({ id: "0xbundle" });
      const result = await connector.sendCalls(createSession(), [
        { to: "0x0000000000000000000000000000000000000001", value: "1" },
      ]);
      expect(result).toBe("0xbundle");
    });

    it("should fallback to individual eth_sendTransaction", async () => {
      provider.request
        .mockRejectedValueOnce(new Error("not supported"))
        .mockResolvedValueOnce("0xtx1")
        .mockResolvedValueOnce("0xtx2");

      const session = createSession();
      const result = await connector.sendCalls(session, [
        {
          to: "0x0000000000000000000000000000000000000001",
          value: "0x1",
          data: "0x",
        },
        {
          to: "0x0000000000000000000000000000000000000002",
          value: "0x2",
          data: "0x",
        },
      ]);
      expect(result).toBe("0xtx1,0xtx2");
    });

    /**
     * EIP-5792 atomicRequired.
     *
     * Choosing the batch path is a decision that the calls must land together.
     * Two things used to undo it silently: the request always carried
     * atomicRequired: false, which tells the wallet it may split the batch, and
     * a wallet without wallet_sendCalls got the calls sent one at a time. Both
     * turn "all or nothing" into "an approve landed and the swap did not",
     * with a return value that looks like success.
     */
    it("tells the wallet atomicity is required when the caller requires it", async () => {
      provider.request.mockResolvedValue({ id: "0xbundle" });
      await connector.sendCalls(
        createSession(),
        [
          { to: "0x0000000000000000000000000000000000000001", value: "0x1" },
          { to: "0x0000000000000000000000000000000000000002", value: "0x2" },
        ],
        undefined,
        { atomicRequired: true },
      );
      const sent = provider.request.mock.calls.at(-1)?.[0];
      expect(sent.params[0].atomicRequired).toBe(true);
    });

    it("forwards the executable paymaster service to the wallet", async () => {
      provider.request.mockResolvedValue({ id: "0xbundle" });
      await connector.sendCalls(
        createSession(),
        [
          { to: "0x0000000000000000000000000000000000000001", value: "0x1" },
        ],
        undefined,
        {
          paymasterService: {
            url: "https://paymaster.example",
            context: { policy: "daily-limit" },
          },
        },
      );
      const sent = provider.request.mock.calls.at(-1)?.[0];
      expect(sent.params[0].capabilities).toEqual({
        paymasterService: {
          url: "https://paymaster.example",
          context: { policy: "daily-limit" },
        },
      });
    });

    it("does not fall back to user-paid transactions after sponsored sendCalls is unavailable", async () => {
      provider.request.mockRejectedValueOnce(new Error("method not supported"));
      await expect(
        connector.sendCalls(
          createSession(),
          [
            { to: "0x0000000000000000000000000000000000000001", value: "0x1" },
          ],
          undefined,
          { paymasterService: { url: "https://paymaster.example" } },
        ),
      ).rejects.toThrow(/not supported/);
      expect(provider.request).toHaveBeenCalledTimes(1);
    });

    it("leaves atomicity to the wallet when the caller did not require it", async () => {
      // EIP-5792 defaults atomicRequired to false; not requiring it is a valid
      // choice, so the flag must not be forced on.
      provider.request.mockResolvedValue({ id: "0xbundle" });
      await connector.sendCalls(createSession(), [
        { to: "0x0000000000000000000000000000000000000001", value: "0x1" },
      ]);
      const sent = provider.request.mock.calls.at(-1)?.[0];
      expect(sent.params[0].atomicRequired).toBe(false);
    });

    it("refuses to degrade to individual transactions when atomicity is required", async () => {
      // The fallback is the exact partial execution atomicRequired rules out.
      provider.request.mockRejectedValueOnce(new Error("method not supported"));
      await expect(
        connector.sendCalls(
          createSession(),
          [
            { to: "0x0000000000000000000000000000000000000001", value: "0x1" },
            { to: "0x0000000000000000000000000000000000000002", value: "0x2" },
          ],
          undefined,
          { atomicRequired: true },
        ),
      ).rejects.toThrow(/not supported/);
      // One attempt, then a refusal — no transactions were sent.
      expect(provider.request).toHaveBeenCalledTimes(1);
    });

    it("does not fall back to transactions after a user rejection", async () => {
      provider.request.mockRejectedValueOnce(
        Object.assign(new Error("User rejected"), { code: 4001 }),
      );
      const session = createSession();

      await expect(
        connector.sendCalls(session, [
          { to: "0x0000000000000000000000000000000000000001", value: "0x1" },
        ]),
      ).rejects.toMatchObject({ code: 4001 });
      expect(provider.request).toHaveBeenCalledTimes(1);
    });
  });

  describe("getCapabilities", () => {
    it("should return capabilities from wallet_getCapabilities", async () => {
      provider.request.mockResolvedValue({
        "0x1": { atomic: { status: "supported" } },
      });
      const session = createSession();
      const caps = await connector.getCapabilities(session);
      expect(provider.request).toHaveBeenCalledWith({
        method: "wallet_getCapabilities",
        params: ["0x1234567890abcdef1234567890abcdef12345678", ["0x1"]],
      });
      expect(caps["eip155:1"]!.atomicBatch!.supported).toBe(true);
      expect(caps["eip155:1"]!.atomicBatch!.maxBatchSize).toBeUndefined();
    });

    it("counts the ready state as support, per EIP-5792 2.0.0", async () => {
      // "ready" means the wallet can execute atomically once the user approves
      // an upgrade. Only "unsupported" is a no.
      provider.request.mockResolvedValue({
        "0x1": { atomic: { status: "ready" } },
      });
      const caps = await connector.getCapabilities(createSession());
      expect(caps["eip155:1"]!.atomicBatch!.supported).toBe(true);
    });

    it("does not read an explicit no as a yes", async () => {
      // This branch used to test `Boolean(caps.atomicBatch)`, and
      // `{ supported: false }` is truthy — a wallet saying it cannot batch was
      // recorded as able to, then handed an atomic batch it could not honour.
      provider.request.mockResolvedValue({
        "0x1": { atomicBatch: { supported: false } },
      });
      const caps = await connector.getCapabilities(createSession());
      expect(caps["eip155:1"]!.atomicBatch!.supported).toBe(false);
    });

    it("propagates a failed query instead of reporting no support", async () => {
      // A wallet that cannot answer has not answered no. Swallowing the error
      // into supported: false makes "never asked" indistinguishable from
      // "asked and declined"; the caller needs that difference to decide
      // whether falling back is safe. getAccountCapabilities turns this into
      // discovered: false.
      provider.request.mockRejectedValue(new Error("not supported"));
      await expect(connector.getCapabilities(createSession())).rejects.toThrow(
        /not supported/,
      );
    });

    it("omits a chain the wallet did not report on", async () => {
      provider.request.mockResolvedValue({
        "0x89": { atomic: { status: "supported" } },
      });
      const caps = await connector.getCapabilities(createSession());
      expect(caps["eip155:1"]).toBeUndefined();
      expect(caps["eip155:137"]!.atomicBatch!.supported).toBe(true);
    });
  });

  describe("getCallsStatus", () => {
    it("returns the wallet's EIP-5792 status response", async () => {
      const status = {
        version: "2.0.0",
        id: "0xbundle",
        chainId: "0x1",
        status: 200,
        atomic: true,
      } as const;
      provider.request.mockResolvedValue(status);

      await expect(
        connector.getCallsStatus(createSession(), status.id),
      ).resolves.toEqual(status);
      expect(provider.request).toHaveBeenCalledWith({
        method: "wallet_getCallsStatus",
        params: [status.id],
      });
    });

    it("propagates a provider error instead of fabricating pending status", async () => {
      provider.request.mockRejectedValue(new Error("bundle not found"));

      await expect(
        connector.getCallsStatus(createSession(), "0xbundle"),
      ).rejects.toThrow("bundle not found");
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

    it("should reject a non-canonical provider balance", async () => {
      provider.request.mockResolvedValue("123");
      await expect((connector as any).getBalance()).rejects.toThrow(
        "non-canonical eth_getBalance quantity",
      );
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
      provider.request.mockImplementation(async ({ method }) =>
        method === "eth_chainId"
          ? "0x1"
          : ["0x1234567890abcdef1234567890abcdef12345678"],
      );
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
        "eip155:1:0x1234567890abcdef1234567890abcdef12345678",
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

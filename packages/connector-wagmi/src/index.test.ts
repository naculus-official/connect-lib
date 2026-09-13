import { WalletConnectConnector } from "@naculus/connector-walletconnect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNaculusConnector } from "./index";

const TEST_PROJECT_ID = "test-project-id";
const TEST_METADATA = {
  name: "Test DApp",
  description: "Test Description",
  url: "https://test.dapp.com",
  icons: ["https://test.dapp.com/icon.png"],
};

function createMockEmitter() {
  return {
    emit: vi.fn(),
    on: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createNaculusConnector", () => {
  it("should return a CreateConnectorFn", () => {
    const fn = createNaculusConnector({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });
    expect(fn).toBeInstanceOf(Function);
  });

  it("should produce a Connector when called with wagmi params", () => {
    const fn = createNaculusConnector({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });

    const connector = fn({
      chains: [] as any,
      emitter: createMockEmitter() as any,
      providers: [],
    });
    expect(connector).toBeDefined();
    expect(connector.id).toBe("naculus");
    expect(connector.name).toBe("Naculus");
    expect(connector.type).toBe("walletconnect");
  });

  it("should have required connector methods", () => {
    const fn = createNaculusConnector({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });

    const connector = fn({
      chains: [] as any,
      emitter: createMockEmitter() as any,
      providers: [],
    });
    expect(typeof connector.connect).toBe("function");
    expect(typeof connector.disconnect).toBe("function");
    expect(typeof connector.getAccounts).toBe("function");
    expect(typeof connector.getChainId).toBe("function");
    expect(typeof connector.isAuthorized).toBe("function");
    expect(typeof connector.switchChain).toBe("function");
    expect(typeof connector.onAccountsChanged).toBe("function");
    expect(typeof connector.onChainChanged).toBe("function");
    expect(typeof connector.onDisconnect).toBe("function");
    expect(typeof connector.getProvider).toBe("function");
    expect(typeof connector.setup).toBe("function");
  });

  it("should fail closed when no chain is configured and no session exists", async () => {
    const fn = createNaculusConnector({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });

    const connector = fn({
      chains: [] as any,
      emitter: createMockEmitter() as any,
      providers: [],
    });
    await expect(connector.getChainId()).rejects.toMatchObject({
      code: "session_expired",
    });
  });

  it("does not retain a session when the approved chain ID is malformed", async () => {
    vi.spyOn(WalletConnectConnector.prototype, "connect").mockResolvedValue({
      id: "session-invalid-chain",
      walletType: "walletconnect",
      namespaces: {
        eip155: {
          chains: ["eip155:not-a-number"],
          accounts: [],
          methods: [],
          events: [],
        },
      },
    } as any);

    const connector = createNaculusConnector({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    })({
      chains: [{ id: 1 }] as any,
      emitter: createMockEmitter() as any,
      providers: [],
    });

    await expect(connector.connect()).rejects.toMatchObject({
      code: "chain_unsupported",
    });
    await expect(connector.isAuthorized()).resolves.toBe(false);
    await expect(connector.getAccounts()).resolves.toEqual([]);
  });

  it("should return empty accounts when not connected", async () => {
    const fn = createNaculusConnector({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });

    const connector = fn({
      chains: [] as any,
      emitter: createMockEmitter() as any,
      providers: [],
    });
    const accounts = await connector.getAccounts();
    expect(accounts).toEqual([]);
  });

  it("should return not authorized when not connected", async () => {
    const fn = createNaculusConnector({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });

    const connector = fn({
      chains: [] as any,
      emitter: createMockEmitter() as any,
      providers: [],
    });
    const authorized = await connector.isAuthorized();
    expect(authorized).toBe(false);
  });

  it("should route provider requests through the connected connector", async () => {
    const session = {
      id: "session-1",
      topic: "topic-1",
      walletType: "walletconnect",
      namespaces: {
        eip155: {
          chains: ["eip155:1"],
          accounts: ["eip155:1:0x1234567890123456789012345678901234567890"],
          methods: [],
          events: [],
        },
      },
    } as any;

    vi.spyOn(WalletConnectConnector.prototype, "connect").mockImplementation(
      async function (this: WalletConnectConnector) {
        (this as any).lastSession = session;
        return session;
      },
    );
    vi.spyOn(WalletConnectConnector.prototype, "request").mockImplementation(
      async function (this: WalletConnectConnector) {
        if (!(this as any).lastSession) throw new Error("session_expired");
        return "ok";
      },
    );

    const connector = createNaculusConnector({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    })({
      chains: [{ id: 1 }] as any,
      emitter: createMockEmitter() as any,
      providers: [],
    });
    await connector.connect();
    const provider = (await connector.getProvider()) as any;

    await expect(provider.request({ method: "eth_chainId" })).resolves.toBe(
      "ok",
    );
  });

  it("should expose only EVM accounts from a multi-namespace session", async () => {
    const session = {
      id: "session-1",
      topic: "topic-1",
      walletType: "walletconnect",
      namespaces: {
        eip155: {
          chains: ["eip155:1"],
          accounts: ["eip155:1:0x1234567890123456789012345678901234567890"],
          methods: [],
          events: [],
        },
        solana: {
          chains: ["solana:4sGjMW1s"],
          accounts: ["solana:4sGjMW1s:SolanaAddress"],
          methods: [],
          events: [],
        },
      },
    } as any;
    vi.spyOn(WalletConnectConnector.prototype, "connect").mockResolvedValue(
      session,
    );

    const connector = createNaculusConnector({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    })({
      chains: [{ id: 1 }] as any,
      emitter: createMockEmitter() as any,
      providers: [],
    });

    await connector.connect();
    await expect(connector.getAccounts()).resolves.toEqual([
      "0x1234567890123456789012345678901234567890",
    ]);
  });

  it("should clear authorization after an external disconnect", async () => {
    const session = {
      id: "session-1",
      topic: "topic-1",
      walletType: "walletconnect",
      namespaces: {
        eip155: {
          chains: ["eip155:1"],
          accounts: ["eip155:1:0x1234567890123456789012345678901234567890"],
          methods: [],
          events: [],
        },
      },
    } as any;
    vi.spyOn(WalletConnectConnector.prototype, "connect").mockResolvedValue(
      session,
    );

    const connector = createNaculusConnector({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    })({
      chains: [{ id: 1 }] as any,
      emitter: createMockEmitter() as any,
      providers: [],
    });

    await connector.connect();
    await connector.onDisconnect();
    await expect(connector.isAuthorized()).resolves.toBe(false);
    await expect(connector.getAccounts()).resolves.toEqual([]);
  });

  it("should keep EVM accounts in sync after accountsChanged", async () => {
    const session = {
      id: "session-1",
      topic: "topic-1",
      walletType: "walletconnect",
      namespaces: {
        eip155: {
          chains: ["eip155:1"],
          accounts: ["eip155:1:0x1234567890123456789012345678901234567890"],
          methods: [],
          events: [],
        },
      },
    } as any;
    vi.spyOn(WalletConnectConnector.prototype, "connect").mockResolvedValue(
      session,
    );

    const connector = createNaculusConnector({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    })({
      chains: [{ id: 1 }] as any,
      emitter: createMockEmitter() as any,
      providers: [],
    });

    await connector.connect();
    await connector.onAccountsChanged([
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    ]);

    await expect(connector.getAccounts()).resolves.toEqual([
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    ]);
  });
});

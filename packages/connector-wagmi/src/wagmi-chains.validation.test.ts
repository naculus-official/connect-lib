import { WalletConnectConnector } from "@naculus/connector-walletconnect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNaculusConnector } from "./index";

const MAINNET_ACCOUNT = "0x1111111111111111111111111111111111111111";
const POLYGON_ACCOUNT = "0x2222222222222222222222222222222222222222";

function createSession() {
  return {
    id: "dummy-session",
    topic: "dummy-session",
    walletId: "dummy-wallet",
    walletType: "walletconnect",
    platform: "desktop-web",
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
    namespaces: {
      eip155: {
        chains: ["eip155:1", "eip155:137"],
        accounts: [
          `eip155:1:${MAINNET_ACCOUNT}`,
          `eip155:137:${POLYGON_ACCOUNT}`,
        ],
        methods: [
          "eth_accounts",
          "eth_requestAccounts",
          "personal_sign",
          "eth_sign",
          "eth_signTransaction",
          "eth_sendTransaction",
          "eth_sendRawTransaction",
          "eth_signTypedData_v4",
          "wallet_switchEthereumChain",
        ],
        events: ["accountsChanged", "chainChanged", "disconnect"],
      },
    },
  } as any;
}

function createHarness() {
  const emitter = { emit: vi.fn(), on: vi.fn() };
  const connector = createNaculusConnector({
    projectId: "dummy-project",
    metadata: {
      name: "Dummy DApp",
      description: "In-memory validation harness",
      url: "https://example.invalid",
      icons: [],
    },
  })({
    chains: [{ id: 1 }, { id: 137 }] as any,
    emitter: emitter as any,
    providers: [],
  });

  return { connector, emitter };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Wagmi multi-chain account projection validation", () => {
  // connector-wagmi:unscoped-eip155-account-projection
  it("scopes connect and getAccounts results to the selected chain", async () => {
    const session = createSession();
    vi.spyOn(WalletConnectConnector.prototype, "connect").mockResolvedValue(
      session,
    );
    vi.spyOn(
      WalletConnectConnector.prototype,
      "switchChain",
    ).mockResolvedValue(undefined);
    const { connector, emitter } = createHarness();

    const connected = await connector.connect({ chainId: 1 });
    const storedAccounts = await connector.getAccounts();
    const connectEvent = emitter.emit.mock.calls.find(
      ([event]) => event === "connect",
    )?.[1];

    expect({ connected, storedAccounts, connectEvent }).toEqual({
      connected: { accounts: [MAINNET_ACCOUNT], chainId: 1 },
      storedAccounts: [MAINNET_ACCOUNT],
      connectEvent: { accounts: [MAINNET_ACCOUNT], chainId: 1 },
    });
  });

  // connector-wagmi:unscoped-eip155-account-projection
  it("labels accountsChanged accounts with the selected chain", async () => {
    const session = createSession();
    vi.spyOn(WalletConnectConnector.prototype, "connect").mockResolvedValue(
      session,
    );
    const switchChain = vi
      .spyOn(WalletConnectConnector.prototype, "switchChain")
      .mockResolvedValue(undefined);
    const { connector, emitter } = createHarness();

    await connector.connect({ chainId: 1 });
    await connector.switchChain?.({ chainId: 137 });
    await connector.onAccountsChanged([POLYGON_ACCOUNT]);
    const changeEvent = emitter.emit.mock.calls.find(
      ([event, payload]) => event === "change" && "accounts" in payload,
    )?.[1];

    expect(switchChain).toHaveBeenCalledWith(session, "eip155:137");
    expect({
      emittedAccounts: changeEvent?.accounts,
      chainId: await connector.getChainId(),
      labelledAccounts: session.namespaces.eip155.accounts,
    }).toEqual({
      emittedAccounts: [POLYGON_ACCOUNT],
      chainId: 137,
      labelledAccounts: [`eip155:137:${POLYGON_ACCOUNT}`],
    });
  });

  it("fails closed when the selected chain has no account", async () => {
    const session = createSession();
    session.namespaces.eip155.accounts = [
      `eip155:137:${POLYGON_ACCOUNT}`,
    ];
    vi.spyOn(WalletConnectConnector.prototype, "connect").mockResolvedValue(
      session,
    );
    const { connector, emitter } = createHarness();

    await expect(connector.connect({ chainId: 1 })).rejects.toMatchObject({
      code: "session_expired",
    });
    expect(emitter.emit).not.toHaveBeenCalledWith("connect", expect.anything());
    await expect(connector.isAuthorized()).resolves.toBe(false);
  });

  it("returns no accounts when the current chain loses its account", async () => {
    const session = createSession();
    session.namespaces.eip155.accounts = [`eip155:1:${MAINNET_ACCOUNT}`];
    vi.spyOn(WalletConnectConnector.prototype, "connect").mockResolvedValue(
      session,
    );
    vi.spyOn(
      WalletConnectConnector.prototype,
      "switchChain",
    ).mockResolvedValue(undefined);
    const { connector } = createHarness();

    await connector.connect({ chainId: 1 });
    await connector.switchChain?.({ chainId: 137 });

    await expect(connector.getAccounts()).resolves.toEqual([]);
  });
});

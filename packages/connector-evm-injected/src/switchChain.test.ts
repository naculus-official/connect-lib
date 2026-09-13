import type { UniversalWalletSession } from "@naculus/connect-core";
import { createEmptySession } from "@naculus/connect-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredWallet, Eip6963EthereumProvider } from "./index";
import { EIP6963Connector } from "./index";

function createMockProvider() {
  return {
    request: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
}

function createMockDiscoveredWallet(
  provider: Eip6963EthereumProvider,
): DiscoveredWallet {
  return {
    id: "test-wallet-uuid",
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

function createSession(chainId: string): UniversalWalletSession {
  return createEmptySession({
    id: "eip6963-test-wallet-uuid-1234567890",
    walletId: "test-wallet-uuid",
    walletType: "eip6963",
    namespaces: {
      eip155: {
        chains: [`eip155:${chainId}`],
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
  });
}

describe("EIP6963Connector.switchChain", () => {
  let connector: EIP6963Connector;
  let provider: ReturnType<typeof createMockProvider>;
  let wallet: DiscoveredWallet;
  let session: UniversalWalletSession;

  beforeEach(() => {
    connector = new EIP6963Connector();
    provider = createMockProvider();
    wallet = createMockDiscoveredWallet(provider);
    session = createSession("1");
    (connector as any).activeSessions.set(
      wallet.id,
      createMockEIP6963Session(wallet),
    );
  });

  it("should add chain via wallet_addEthereumChain on 4902 error and retry switch", async () => {
    const providerRequest = provider.request as ReturnType<typeof vi.fn>;
    providerRequest
      .mockRejectedValueOnce({ code: 4902, message: "Chain not recognized" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await connector.switchChain(session, "eip155:137");

    expect(providerRequest).toHaveBeenCalledTimes(3);
    expect(providerRequest).toHaveBeenNthCalledWith(1, {
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x89" }],
    });
    expect(providerRequest).toHaveBeenNthCalledWith(2, {
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: "0x89",
          chainName: "Polygon Mainnet",
          nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
          rpcUrls: ["https://polygon-rpc.com"],
          blockExplorerUrls: ["https://polygonscan.com"],
        },
      ],
    });
    expect(providerRequest).toHaveBeenNthCalledWith(3, {
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x89" }],
    });
    expect(session.namespaces.eip155?.chains).toContain("eip155:137");
  });

  it("should throw chain_unsupported for 4902 error with no chain metadata", async () => {
    const providerRequest = provider.request as ReturnType<typeof vi.fn>;
    providerRequest.mockRejectedValueOnce({
      code: 4902,
      message: "Chain not recognized",
    });

    await expect(
      connector.switchChain(session, "eip155:999999"),
    ).rejects.toThrow(
      "Chain 0xf423f is not recognized. No metadata available to add it.",
    );
    expect(providerRequest).toHaveBeenCalledTimes(1);
  });

  it("should propagate non-4902 errors as chain_unsupported", async () => {
    const providerRequest = provider.request as ReturnType<typeof vi.fn>;
    providerRequest.mockRejectedValueOnce({
      code: 4001,
      message: "User rejected the request",
    });

    await expect(connector.switchChain(session, "eip155:137")).rejects.toThrow(
      "Failed to switch chain: User rejected the request",
    );
    expect(providerRequest).toHaveBeenCalledTimes(1);
  });

  it("should update session chains when switching to new chain", async () => {
    const providerRequest = provider.request as ReturnType<typeof vi.fn>;
    providerRequest.mockResolvedValue(null);

    await connector.switchChain(session, "eip155:137");

    expect(session.namespaces.eip155?.chains).toContain("eip155:137");
  });

  it("should keep existing chains when adding a new one", async () => {
    const providerRequest = provider.request as ReturnType<typeof vi.fn>;
    providerRequest.mockResolvedValue(null);

    await connector.switchChain(session, "eip155:137");

    expect(session.namespaces.eip155?.chains).toContain("eip155:1");
    expect(session.namespaces.eip155?.chains).toContain("eip155:137");
  });

  it("should handle raw hex chainId without eip155: prefix", async () => {
    const providerRequest = provider.request as ReturnType<typeof vi.fn>;
    providerRequest
      .mockRejectedValueOnce({ code: 4902, message: "Not found" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await connector.switchChain(session, "0x89");

    expect(providerRequest).toHaveBeenNthCalledWith(1, {
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x89" }],
    });
    expect(providerRequest).toHaveBeenNthCalledWith(2, {
      method: "wallet_addEthereumChain",
      params: [expect.objectContaining({ chainId: "0x89" })],
    });
  });
});

describe("EIP6963Connector.switchChain — active chain tracking", () => {
  /**
   * Nine call sites in this connector read `chains[0]` as the active chain,
   * one of them literally naming it `activeChain`, and normalizeEvmTransaction
   * rejects a caller-supplied chainId that disagrees with it. switchChain must
   * therefore keep `chains[0]` in sync with the wallet.
   */
  let connector: EIP6963Connector;
  let provider: ReturnType<typeof createMockProvider>;
  let wallet: DiscoveredWallet;
  let session: UniversalWalletSession;

  beforeEach(() => {
    connector = new EIP6963Connector();
    provider = createMockProvider();
    wallet = createMockDiscoveredWallet(provider);
    session = createSession("1");
    (connector as any).activeSessions.set(
      wallet.id,
      createMockEIP6963Session(wallet),
    );
    (provider.request as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });

  it("promotes a chain that was already listed in the session", async () => {
    session.namespaces.eip155!.chains = ["eip155:1", "eip155:137"];
    await connector.switchChain(session, "eip155:137");
    expect(session.namespaces.eip155!.chains[0]).toBe("eip155:137");
  });

  it("promotes a newly added chain and keeps the previous one", async () => {
    await connector.switchChain(session, "eip155:8453");
    expect(session.namespaces.eip155!.chains[0]).toBe("eip155:8453");
    expect(session.namespaces.eip155!.chains).toContain("eip155:1");
  });

  it("does not duplicate a chain on repeated switches", async () => {
    await connector.switchChain(session, "eip155:137");
    await connector.switchChain(session, "eip155:1");
    await connector.switchChain(session, "eip155:137");
    const chains = session.namespaces.eip155!.chains;
    expect(new Set(chains).size).toBe(chains.length);
    expect(chains[0]).toBe("eip155:137");
  });

  it("accepts a transaction stamped for the chain just switched to", async () => {
    // Proper CAIP-10 accounts on both sides: switchChain re-qualifies them to
    // the new chain reference, and findActiveSession matches by exact string.
    const caip10 = "eip155:1:0x1234567890abcdef1234567890abcdef12345678";
    session.namespaces.eip155!.chains = ["eip155:1", "eip155:137"];
    session.namespaces.eip155!.accounts = [caip10];
    (connector as any).activeSessions.get(wallet.id).accounts = [caip10];

    await connector.switchChain(session, "eip155:137");
    expect(session.namespaces.eip155!.accounts).toEqual([
      "eip155:137:0x1234567890abcdef1234567890abcdef12345678",
    ]);
    await expect(
      connector.sendTransaction(session, {
        transaction: {
          from: "0x1234567890abcdef1234567890abcdef12345678",
          to: "0x1111111111111111111111111111111111111111",
          chainId: "0x89",
        },
      }),
    ).resolves.not.toThrow();
  });

  it("keeps a from-less transaction working after a switch", async () => {
    const caip10 = "eip155:1:0x1234567890abcdef1234567890abcdef12345678";
    session.namespaces.eip155!.chains = ["eip155:1", "eip155:137"];
    session.namespaces.eip155!.accounts = [caip10];
    (connector as any).activeSessions.get(wallet.id).accounts = [caip10];

    await connector.switchChain(session, "eip155:137");
    await expect(
      connector.sendTransaction(session, {
        transaction: { to: "0x1111111111111111111111111111111111111111" },
      }),
    ).resolves.not.toThrow();
  });
});

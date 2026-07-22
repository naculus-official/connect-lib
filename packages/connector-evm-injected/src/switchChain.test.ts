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

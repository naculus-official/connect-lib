import { describe, expect, it, vi } from "vitest";
import type { DiscoveredWallet, Eip6963EthereumProvider } from "./index";
import { createEIP6963Connector } from "./index";

const ACCOUNT = "0x1234567890abcdef1234567890abcdef12345678";

function walletOn(chainHex: string): DiscoveredWallet {
  const provider = {
    request: vi.fn(async ({ method }: { method: string }) =>
      method === "eth_chainId" ? chainHex : [ACCOUNT],
    ),
    on: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as Eip6963EthereumProvider;
  return { id: "w", name: "W", icon: "", rdns: "io.w", provider };
}

describe("EIP-6963 connect with a CAIP-25 scope request", () => {
  it("refuses a wallet on a chain outside required, and accepts one inside", async () => {
    const connector = createEIP6963Connector();
    const scope = {
      required: {
        eip155: {
          chains: ["eip155:1", "eip155:8453"],
          methods: [],
          events: [],
        },
      },
    };
    await expect(
      connector.connect({ ...walletOn("0x89"), scope }),
    ).rejects.toMatchObject({ code: "chain_unsupported" });

    const session = await connector.connect({ ...walletOn("0x2105"), scope });
    expect(session.namespaces.eip155.chains).toEqual(["eip155:8453"]);
  });

  it("without a scope keeps the previous behavior: any chain is accepted", async () => {
    const connector = createEIP6963Connector();
    const session = await connector.connect(walletOn("0x89"));
    expect(session.namespaces.eip155.chains).toEqual(["eip155:137"]);
  });
});

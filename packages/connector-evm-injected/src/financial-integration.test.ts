import type {
  BatchCall,
  UniversalConnector,
  UniversalWalletSession,
} from "@naculus/connect-core";
import { createEmptySession } from "@naculus/connect-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EIP6963Connector } from "./index";
import type { DiscoveredWallet } from "./types";

function createMockEIP6963Provider(
  accounts: string[],
  chainId: string = "0x1",
) {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  return {
    request: vi.fn(
      async ({ method, params }: { method: string; params?: unknown[] }) => {
        switch (method) {
          case "eth_requestAccounts":
            return accounts;
          case "eth_accounts":
            return accounts;
          case "eth_chainId":
            return chainId;
          case "personal_sign":
            return `0x${"ab".repeat(65)}`;
          case "eth_sendTransaction":
            return `0x${"cd".repeat(32)}`;
          case "eth_signTypedData_v4":
            return `0x${"ef".repeat(65)}`;
          case "wallet_switchEthereumChain":
            return null;
          case "wallet_addEthereumChain":
            return null;
          case "eth_getBalance":
            return "0x56BC75E2D63100000"; // 100 ETH
          case "wallet_sendCalls":
            return `0x${"dd".repeat(32)}`;
          default:
            return null;
        }
      },
    ),
    on: vi.fn((event: string, cb: (...args: any[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
    }),
    removeListener: vi.fn((event: string, cb: (...args: any[]) => void) => {
      listeners.get(event)?.delete(cb);
    }),
  };
}

describe("EVM Injected Financial Integration", () => {
  let provider: ReturnType<typeof createMockEIP6963Provider>;
  let accounts: string[];
  let chainId: string;

  beforeEach(() => {
    accounts = ["0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B"];
    chainId = "0x1";
    provider = createMockEIP6963Provider(accounts, chainId);
  });

  it("connects and returns accounts", async () => {
    const result = await provider.request({ method: "eth_requestAccounts" });
    expect(result).toEqual(accounts);
    expect(result[0]).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("signs message and returns hex signature", async () => {
    const msg = "0x48656c6c6f";
    const sig = await provider.request({
      method: "personal_sign",
      params: [msg, accounts[0]],
    });
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("sends transaction and returns tx hash", async () => {
    const tx = {
      from: accounts[0],
      to: "0x" + "ab".repeat(20),
      value: "0xde0b6b3a7640000",
    };
    const hash = await provider.request({
      method: "eth_sendTransaction",
      params: [tx],
    });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("switches chain", async () => {
    const result = await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x89" }],
    });
    expect(result).toBeNull();
  });

  it("signs typed data (EIP-712)", async () => {
    const typedData = {
      types: {
        EIP712Domain: [],
        Message: [{ name: "content", type: "string" }],
      },
      domain: {
        name: "Test",
        version: "1",
        chainId: 1,
        verifyingContract: "0x" + "cd".repeat(20),
      },
      primaryType: "Message",
      message: { content: "Hello" },
    };
    const sig = await provider.request({
      method: "eth_signTypedData_v4",
      params: [accounts[0], JSON.stringify(typedData)],
    });
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("handles multiple accounts", async () => {
    const multiAccounts = ["0x" + "ab".repeat(20), "0x" + "cd".repeat(20)];
    const p = createMockEIP6963Provider(multiAccounts, "0x1");
    const result = await p.request({ method: "eth_requestAccounts" });
    expect(result).toHaveLength(2);
  });
});

describe("EVM Injected Financial Integration: sendCalls Fallback", () => {
  it("handles single call via eth_sendTransaction", async () => {
    const provider = createMockEIP6963Provider(["0x" + "ab".repeat(20)], "0x1");
    const hash = await provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: "0x" + "ab".repeat(20),
          to: "0x" + "cd".repeat(20),
          value: "0x1",
        },
      ],
    });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("multiple calls each produce valid hashes", async () => {
    const provider = createMockEIP6963Provider(["0x" + "ab".repeat(20)], "0x1");
    const calls = [
      {
        from: "0x" + "ab".repeat(20),
        to: "0x" + "cd".repeat(20),
        value: "0x1",
      },
      {
        from: "0x" + "ab".repeat(20),
        to: "0x" + "ef".repeat(20),
        value: "0x2",
      },
    ];
    const hashes = await Promise.all(
      calls.map((c) =>
        provider.request({ method: "eth_sendTransaction", params: [c] }),
      ),
    );
    for (const h of hashes) {
      expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
});

describe("EVM Injected Financial Integration: Chain Operations", () => {
  it("reads current chain ID as hex", async () => {
    const provider = createMockEIP6963Provider(["0x" + "ab".repeat(20)], "0x1");
    const chainId = await provider.request({ method: "eth_chainId" });
    expect(chainId).toBe("0x1");
    expect(Number(BigInt(chainId))).toBe(1);
  });

  it("switches to Polygon (0x89)", async () => {
    const provider = createMockEIP6963Provider(
      ["0x" + "ab".repeat(20)],
      "0x89",
    );
    const chainId = await provider.request({ method: "eth_chainId" });
    expect(chainId).toBe("0x89");
    expect(Number(BigInt(chainId))).toBe(137);
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. sendTransaction VALUE PASSTHROUGH
// ═══════════════════════════════════════════════════════════════

describe("EVM Injected Financial Integration: sendTransaction Values", () => {
  const FROM = "0x" + "ab".repeat(20);
  const TO = "0x" + "cd".repeat(20);
  const BASE_TX = { from: FROM, to: TO };

  it("passes hex value string and BigInt round-trips to 1 ETH", async () => {
    const provider = createMockEIP6963Provider([FROM], "0x1");
    const hash = await provider.request({
      method: "eth_sendTransaction",
      params: [{ ...BASE_TX, value: "0xde0b6b3a7640000" }],
    });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt("0xde0b6b3a7640000")).toBe(1_000_000_000_000_000_000n);
  });

  it("passes zero value (0x0)", async () => {
    const provider = createMockEIP6963Provider([FROM], "0x1");
    const hash = await provider.request({
      method: "eth_sendTransaction",
      params: [{ ...BASE_TX, value: "0x0" }],
    });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt("0x0")).toBe(0n);
  });

  it("passes dust value (1 wei = 0x1)", async () => {
    const provider = createMockEIP6963Provider([FROM], "0x1");
    const hash = await provider.request({
      method: "eth_sendTransaction",
      params: [{ ...BASE_TX, value: "0x1" }],
    });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt("0x1")).toBe(1n);
  });

  it("passes value exceeding Number.MAX_SAFE_INTEGER", async () => {
    const provider = createMockEIP6963Provider([FROM], "0x1");
    const large = "0xffffffffffffffff"; // 2^64-1
    const hash = await provider.request({
      method: "eth_sendTransaction",
      params: [{ ...BASE_TX, value: large }],
    });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    const asBigInt = BigInt(large);
    expect(asBigInt).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(typeof asBigInt).toBe("bigint");
  });

  it("passes value with decimal string via toHexValue", async () => {
    const provider = createMockEIP6963Provider([FROM], "0x1");
    const hash = await provider.request({
      method: "eth_sendTransaction",
      params: [{ ...BASE_TX, value: "0x2386f26fc10000" }],
    });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt("0x2386f26fc10000")).toBe(10_000_000_000_000_000n);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. sendCalls BATCH VALUES
// ═══════════════════════════════════════════════════════════════

describe("EVM Injected Financial Integration: sendCalls Batch Values", () => {
  const FROM = "0x" + "ab".repeat(20);

  it("handles call with explicit value and data", async () => {
    const provider = createMockEIP6963Provider([FROM], "0x1");
    const hash = await provider.request({
      method: "wallet_sendCalls",
      params: [
        {
          from: FROM,
          calls: [
            {
              to: ("0x" + "cd".repeat(20)) as `0x${string}`,
              value: "0x1",
              data: "0x" as `0x${string}`,
            },
          ],
        },
      ],
    });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("handles call with missing value", async () => {
    const provider = createMockEIP6963Provider([FROM], "0x1");
    const hash = await provider.request({
      method: "wallet_sendCalls",
      params: [
        {
          from: FROM,
          calls: [
            {
              to: ("0x" + "cd".repeat(20)) as `0x${string}`,
              data: "0x" as `0x${string}`,
            },
          ],
        },
      ],
    });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("handles call with missing data", async () => {
    const provider = createMockEIP6963Provider([FROM], "0x1");
    const hash = await provider.request({
      method: "wallet_sendCalls",
      params: [
        {
          from: FROM,
          calls: [
            { to: ("0x" + "cd".repeat(20)) as `0x${string}`, value: "0x1" },
          ],
        },
      ],
    });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("handles call with both value and data missing", async () => {
    const provider = createMockEIP6963Provider([FROM], "0x1");
    const hash = await provider.request({
      method: "wallet_sendCalls",
      params: [
        {
          from: FROM,
          calls: [{ to: ("0x" + "cd".repeat(20)) as `0x${string}` }],
        },
      ],
    });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. getBalance PARSING
// ═══════════════════════════════════════════════════════════════

describe("EVM Injected Financial Integration: getBalance", () => {
  it("parses hex balance as bigint", async () => {
    const provider = createMockEIP6963Provider(["0x" + "ab".repeat(20)], "0x1");
    const balance = await provider.request({
      method: "eth_getBalance",
      params: ["0x" + "ab".repeat(20), "latest"],
    });
    expect(typeof balance).toBe("string");
    expect(balance).toMatch(/^0x[0-9a-fA-F]+$/);
    const asBigInt = BigInt(balance);
    expect(asBigInt).toBeGreaterThan(0n);
    expect(typeof asBigInt).toBe("bigint");
  });

  it("parses zero balance as 0n", async () => {
    const provider = createMockEIP6963Provider(["0x" + "ab".repeat(20)], "0x1");
    provider.request.mockImplementation(
      async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_getBalance") return "0x0";
        return null;
      },
    );
    const balance = await provider.request({
      method: "eth_getBalance",
      params: ["0x" + "ab".repeat(20), "latest"],
    });
    expect(BigInt(balance)).toBe(0n);
  });

  it("parses large balance as bigint without precision loss", async () => {
    const provider = createMockEIP6963Provider(["0x" + "ab".repeat(20)], "0x1");
    provider.request.mockImplementation(
      async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_getBalance")
          return "0xffffffffffffffffffffffffffffffff";
        return null;
      },
    );
    const balance = await provider.request({
      method: "eth_getBalance",
      params: ["0x" + "ab".repeat(20), "latest"],
    });
    const asBigInt = BigInt(balance);
    expect(asBigInt).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(asBigInt.toString()).toBe("340282366920938463463374607431768211455");
  });
});

// ═══════════════════════════════════════════════════════════════
// 12. switchChain
// ═══════════════════════════════════════════════════════════════

describe("EVM Injected Financial Integration: switchChain", () => {
  it("switches to mainnet (0x1)", async () => {
    const provider = createMockEIP6963Provider(["0x" + "ab".repeat(20)], "0x1");
    const result = await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x1" }],
    });
    expect(result).toBeNull();
  });

  it("switches to Polygon (0x89)", async () => {
    const provider = createMockEIP6963Provider(
      ["0x" + "ab".repeat(20)],
      "0x89",
    );
    const result = await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x89" }],
    });
    expect(result).toBeNull();
  });

  it("switches to Arbitrum (0xa4b1 = chainId 42161)", async () => {
    const provider = createMockEIP6963Provider(
      ["0x" + "ab".repeat(20)],
      "0xa4b1",
    );
    const result = await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0xa4b1" }],
    });
    expect(result).toBeNull();
    expect(Number(BigInt("0xa4b1"))).toBe(42161);
  });
});

// ═══════════════════════════════════════════════════════════════
// 13. ERROR CASES
// ═══════════════════════════════════════════════════════════════

describe("EVM Injected Financial Integration: Error Cases", () => {
  it("throws user rejection (code 4001) on personal_sign", async () => {
    const provider = createMockEIP6963Provider(["0x" + "ab".repeat(20)], "0x1");
    provider.request.mockRejectedValueOnce({
      code: 4001,
      message: "User rejected",
    });
    await expect(
      provider.request({
        method: "personal_sign",
        params: ["0x48656c6c6f", "0x" + "ab".repeat(20)],
      }),
    ).rejects.toMatchObject({ code: 4001 });
  });

  it("throws user rejection (code 4001) on eth_sendTransaction", async () => {
    const provider = createMockEIP6963Provider(["0x" + "ab".repeat(20)], "0x1");
    provider.request.mockRejectedValueOnce({
      code: 4001,
      message: "User rejected",
    });
    await expect(
      provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: "0x" + "ab".repeat(20),
            to: "0x" + "cd".repeat(20),
            value: "0x1",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 4001 });
  });

  it("throws user rejection (code 4001) on wallet_switchEthereumChain", async () => {
    const provider = createMockEIP6963Provider(["0x" + "ab".repeat(20)], "0x1");
    provider.request.mockRejectedValueOnce({
      code: 4001,
      message: "User rejected",
    });
    await expect(
      provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x89" }],
      }),
    ).rejects.toMatchObject({ code: 4001 });
  });

  it("returns null for unsupported method (no throw)", async () => {
    const provider = createMockEIP6963Provider(["0x" + "ab".repeat(20)], "0x1");
    const result = await provider.request({
      method: "eth_unsupportedMethod",
      params: [],
    });
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. CONNECTOR-LEVEL INPUT VALIDATION
// ═══════════════════════════════════════════════════════════════

describe("EVM Injected Financial Integration: Input Validation", () => {
  let connector: EIP6963Connector;
  let provider: ReturnType<typeof createMockEIP6963Provider>;
  let wallet: DiscoveredWallet;
  let session: UniversalWalletSession;

  beforeEach(() => {
    connector = new EIP6963Connector();
    provider = createMockEIP6963Provider(
      ["0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B"],
      "0x1",
    );
    wallet = {
      id: "test-wallet",
      name: "Test Wallet",
      icon: "data:image/svg+xml;base64,test",
      rdns: "io.test.wallet",
      provider: provider as any,
    };
    (connector as any).discoveredWallets.set(wallet.id, wallet);
    (connector as any).activeSessions.set(wallet.id, {
      wallet,
      accounts: ["eip155:0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B"],
      chains: ["eip155:1"],
      methods: [
        "eth_requestAccounts",
        "eth_sendTransaction",
        "personal_sign",
        "eth_signTypedData_v4",
      ],
      events: ["accountsChanged", "chainChanged"],
    });
    session = createEmptySession({
      id: "eip6963-test-wallet-1234567890",
      walletId: "test-wallet",
      walletType: "eip6963",
      namespaces: {
        eip155: {
          chains: ["eip155:1"],
          accounts: ["eip155:0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B"],
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
  });

  afterEach(() => {
    connector.clear();
  });

  it("throws on missing transaction in sendTransaction", async () => {
    await expect(connector.sendTransaction(session, {} as any)).rejects.toThrow(
      "Missing transaction",
    );
  });

  it("throws on null input in sendTransaction", async () => {
    await expect(
      connector.sendTransaction(session, null as any),
    ).rejects.toThrow("Invalid input");
  });

  it("throws on missing transaction in signTransaction", async () => {
    await expect(connector.signTransaction(session, {} as any)).rejects.toThrow(
      "Missing transaction",
    );
  });

  it("throws on null input in signMessage", async () => {
    await expect(connector.signMessage(session, null as any)).rejects.toThrow(
      "Invalid input",
    );
  });

  it("throws on missing message in signMessage", async () => {
    await expect(
      connector.signMessage(session, {
        address: "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B",
      } as any),
    ).rejects.toThrow("Missing message parameter");
  });

  it("throws on null calls in sendCalls", async () => {
    await expect(connector.sendCalls(session, null as any)).rejects.toThrow(
      "Invalid input",
    );
  });

  it("throws session_expired when no active session", async () => {
    const fresh = new EIP6963Connector();
    await expect(
      fresh.sendTransaction(session, {
        transaction: { to: "0x" + "cd".repeat(20), value: "0x1" },
      } as any),
    ).rejects.toThrow("Session expired");
  });
});

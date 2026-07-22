import type { BatchCall, UniversalWalletSession } from "@naculus/connect-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock @coinbase/wallet-sdk ─────────────────────────────────

const mockProvider = {
  request: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
  isCoinbaseWallet: true,
};

const mockMakeWeb3Provider = vi.fn().mockReturnValue(mockProvider);

vi.mock("@coinbase/wallet-sdk", () => ({
  default: class MockCoinbaseWalletSDK {
    makeWeb3Provider = mockMakeWeb3Provider;
    getCoinbaseWalletLogo = vi.fn();
    storeLatestVersion = vi.fn();
  },
  CoinbaseWalletSDK: class MockCoinbaseWalletSDK {
    makeWeb3Provider = mockMakeWeb3Provider;
    getCoinbaseWalletLogo = vi.fn();
    storeLatestVersion = vi.fn();
  },
}));

const { CoinbaseConnector } = await import("./connector");

// ─── Constants ──────────────────────────────────────────────────

const ACCOUNT = "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B" as `0x${string}`;
const RECIPIENT = ("0x" + "ab".repeat(20)) as `0x${string}`;
const RECIPIENT2 = ("0x" + "cd".repeat(20)) as `0x${string}`;

function createSession(): UniversalWalletSession {
  return {
    id: "test-session",
    connectorId: "coinbase",
    namespaces: {
      eip155: {
        chains: ["eip155:1"],
        accounts: [`eip155:1:${ACCOUNT}`],
        methods: [
          "eth_sendTransaction",
          "personal_sign",
          "wallet_switchEthereumChain",
        ],
        events: ["accountsChanged", "chainChanged", "disconnect"],
      },
    },
    expiry: Date.now() + 300_000,
  };
}

async function createConnectedConnector() {
  const connector = new CoinbaseConnector({ appName: "Test DApp" });
  mockProvider.request
    .mockResolvedValueOnce([ACCOUNT])
    .mockResolvedValueOnce("0x1");
  await connector.connect();
  vi.clearAllMocks();
  return connector;
}

// ═══════════════════════════════════════════════════════════════
// 1. VALUE PASSTHROUGH — sendTransaction
// ═══════════════════════════════════════════════════════════════

describe("Coinbase Financial: sendTransaction value passthrough", () => {
  let connector: InstanceType<typeof CoinbaseConnector>;
  let session: UniversalWalletSession;

  beforeEach(async () => {
    connector = await createConnectedConnector();
    session = createSession();
  });

  it("passes hex value unchanged to provider", async () => {
    mockProvider.request.mockResolvedValueOnce("0x" + "aa".repeat(32));
    await connector.sendTransaction(session, {
      transaction: { to: RECIPIENT, value: "0xde0b6b3a7640000", data: "0x" },
    });
    expect(mockProvider.request).toHaveBeenCalledWith({
      method: "eth_sendTransaction",
      params: [expect.objectContaining({ value: "0xde0b6b3a7640000" })],
    });
  });

  it("passes decimal string value through as-is", async () => {
    mockProvider.request.mockResolvedValueOnce("0x" + "bb".repeat(32));
    await connector.sendTransaction(session, {
      transaction: { to: RECIPIENT, value: "1000000000000000000", data: "0x" },
    });
    expect(mockProvider.request).toHaveBeenCalledWith({
      method: "eth_sendTransaction",
      params: [expect.objectContaining({ value: "1000000000000000000" })],
    });
  });

  it("passes zero value correctly", async () => {
    mockProvider.request.mockResolvedValueOnce("0x" + "cc".repeat(32));
    await connector.sendTransaction(session, {
      transaction: { to: RECIPIENT, value: "0", data: "0x" },
    });
    expect(mockProvider.request).toHaveBeenCalledWith({
      method: "eth_sendTransaction",
      params: [expect.objectContaining({ value: "0" })],
    });
  });

  it("passes 1 wei (dust) value", async () => {
    mockProvider.request.mockResolvedValueOnce("0x" + "dd".repeat(32));
    await connector.sendTransaction(session, {
      transaction: { to: RECIPIENT, value: "0x1", data: "0x" },
    });
    expect(mockProvider.request).toHaveBeenCalledWith({
      method: "eth_sendTransaction",
      params: [expect.objectContaining({ value: "0x1" })],
    });
  });

  it("passes large value exceeding MAX_SAFE_INTEGER", async () => {
    const large = (Number.MAX_SAFE_INTEGER + 1000).toString();
    mockProvider.request.mockResolvedValueOnce("0x" + "ee".repeat(32));
    await connector.sendTransaction(session, {
      transaction: { to: RECIPIENT, value: large, data: "0x" },
    });
    expect(mockProvider.request).toHaveBeenCalledWith({
      method: "eth_sendTransaction",
      params: [expect.objectContaining({ value: large })],
    });
  });

  it("passes near-max uint256 hex value", async () => {
    const maxHex =
      "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as `0x${string}`;
    mockProvider.request.mockResolvedValueOnce("0x" + "ff".repeat(32));
    await connector.sendTransaction(session, {
      transaction: { to: RECIPIENT, value: maxHex, data: "0x" },
    });
    expect(mockProvider.request).toHaveBeenCalledWith({
      method: "eth_sendTransaction",
      params: [expect.objectContaining({ value: maxHex })],
    });
  });

  it("returns tx hash matching hex format", async () => {
    mockProvider.request.mockResolvedValueOnce("0x" + "ab".repeat(32));
    const hash = await connector.sendTransaction(session, {
      transaction: { to: RECIPIENT, value: "0x1", data: "0x" },
    });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. VALUE PASSTHROUGH — signTransaction
// ═══════════════════════════════════════════════════════════════

describe("Coinbase Financial: signTransaction value passthrough", () => {
  let connector: InstanceType<typeof CoinbaseConnector>;
  let session: UniversalWalletSession;

  beforeEach(async () => {
    connector = await createConnectedConnector();
    session = createSession();
  });

  it("passes full transaction object to eth_signTransaction", async () => {
    const tx = {
      to: RECIPIENT,
      value: "0xde0b6b3a7640000",
      data: "0x",
      gas: "0x5208",
    };
    mockProvider.request.mockResolvedValueOnce("0xsigned-tx-blob");
    await connector.signTransaction(session, { transaction: tx });
    expect(mockProvider.request).toHaveBeenCalledWith({
      method: "eth_signTransaction",
      params: [tx],
    });
  });

  it("passes zero-value transaction", async () => {
    const tx = {
      to: RECIPIENT,
      value: "0x0",
      data: "0xa9059cbb0000000000000000000000000000000000000000000000000000000000000000",
    };
    mockProvider.request.mockResolvedValueOnce("0xsigned-tx-blob");
    await connector.signTransaction(session, { transaction: tx });
    expect(mockProvider.request).toHaveBeenCalledWith({
      method: "eth_signTransaction",
      params: [expect.objectContaining({ value: "0x0" })],
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. sendCalls — BATCH VALUES
// ═══════════════════════════════════════════════════════════════

describe("Coinbase Financial: sendCalls batch values", () => {
  let connector: InstanceType<typeof CoinbaseConnector>;
  let session: UniversalWalletSession;

  beforeEach(async () => {
    connector = await createConnectedConnector();
    session = createSession();
  });

  it("sends multiple calls via wallet_sendCalls with values intact", async () => {
    mockProvider.request.mockResolvedValueOnce("0x" + "aa".repeat(32));
    const calls: BatchCall[] = [
      { to: RECIPIENT, value: "0xde0b6b3a7640000", data: "0x" },
      { to: RECIPIENT2, value: "0x1bc16d674ec80000", data: "0x" },
    ];
    await connector.sendCalls(session, calls, "eip155:1");
    expect(mockProvider.request).toHaveBeenCalledWith({
      method: "wallet_sendCalls",
      params: [{ calls, chainId: "eip155:1" }],
    });
  });

  it("fallback sends each call as individual eth_sendTransaction", async () => {
    mockProvider.request
      .mockRejectedValueOnce(new Error("method not found"))
      .mockResolvedValueOnce("0x" + "bb".repeat(32))
      .mockResolvedValueOnce("0x" + "cc".repeat(32));
    const calls: BatchCall[] = [
      { to: RECIPIENT, value: "0x1", data: "0x" },
      { to: RECIPIENT2, value: "0x2", data: "0x" },
    ];
    const result = await connector.sendCalls(session, calls);
    expect(result).toContain("0x");
    expect(result.split(",").length).toBe(2);
    expect(mockProvider.request).toHaveBeenCalledTimes(3);
    expect(mockProvider.request.mock.calls[1][0]).toEqual({
      method: "eth_sendTransaction",
      params: [{ from: ACCOUNT, to: RECIPIENT, value: "0x1", data: "0x" }],
    });
  });

  it("fallback preserves value for each individual call", async () => {
    mockProvider.request
      .mockRejectedValueOnce(new Error("unsupported"))
      .mockResolvedValueOnce("0x" + "dd".repeat(32));
    const calls: BatchCall[] = [
      { to: RECIPIENT, value: "0xde0b6b3a7640000", data: "0x" },
    ];
    await connector.sendCalls(session, calls, "eip155:1");
    expect(mockProvider.request.mock.calls[1][0].params[0].value).toBe(
      "0xde0b6b3a7640000",
    );
  });

  it("returns single hash for single-call fallback (no comma)", async () => {
    mockProvider.request
      .mockRejectedValueOnce(new Error("not authorized"))
      .mockResolvedValueOnce("0x" + "ee".repeat(32));
    const calls: BatchCall[] = [{ to: RECIPIENT, value: "0x1", data: "0x" }];
    const result = await connector.sendCalls(session, calls);
    expect(result).not.toContain(",");
    expect(result).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("throws when session has no accounts in fallback", async () => {
    const noAccountSession = createSession();
    noAccountSession.namespaces.eip155.accounts = [];
    mockProvider.request.mockRejectedValueOnce(new Error("method not found"));
    await expect(
      connector.sendCalls(noAccountSession, [
        { to: RECIPIENT, value: "0x1", data: "0x" },
      ]),
    ).rejects.toThrow("No account found for transaction");
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. switchChain — CHAIN ID HEX CONVERSION
// ═══════════════════════════════════════════════════════════════

describe("Coinbase Financial: switchChain chainId conversion", () => {
  let connector: InstanceType<typeof CoinbaseConnector>;
  let session: UniversalWalletSession;

  beforeEach(async () => {
    connector = await createConnectedConnector();
    session = createSession();
  });

  it("converts eip155:1 to 0x1", async () => {
    mockProvider.request.mockResolvedValueOnce(null);
    await connector.switchChain(session, "eip155:1");
    expect(mockProvider.request).toHaveBeenCalledWith({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x1" }],
    });
  });

  it("converts eip155:137 (Polygon) to 0x89", async () => {
    mockProvider.request.mockResolvedValueOnce(null);
    await connector.switchChain(session, "eip155:137");
    expect(mockProvider.request).toHaveBeenCalledWith({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x89" }],
    });
  });

  it("converts eip155:8453 (Base) to 0x2105", async () => {
    mockProvider.request.mockResolvedValueOnce(null);
    await connector.switchChain(session, "eip155:8453");
    expect(mockProvider.request).toHaveBeenCalledWith({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x2105" }],
    });
  });

  it("rejects non-EVM namespace", async () => {
    await expect(connector.switchChain(session, "solana:0")).rejects.toThrow(
      "only supports EVM chains",
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. getBalance — BigInt return
// ═══════════════════════════════════════════════════════════════

describe("Coinbase Financial: getBalance BigInt", () => {
  let connector: InstanceType<typeof CoinbaseConnector>;
  let session: UniversalWalletSession;

  beforeEach(async () => {
    vi.clearAllMocks();
    connector = await createConnectedConnector();
    session = createSession();
  });

  it("returns string bigint from RPC balance", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: "0x56BC75E2D63100000",
      }),
    } as Response);
    const balance = await connector.getBalance();
    expect(typeof balance).toBe("string");
    expect(() => BigInt(balance)).not.toThrow();
    expect(BigInt(balance)).toBe(100_000_000_000_000_000_000n);
  });

  it("returns balance exceeding MAX_SAFE_INTEGER without precision loss", async () => {
    const huge =
      "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: huge }),
    } as Response);
    const balance = await connector.getBalance();
    expect(BigInt(balance)).toBe(2n ** 256n - 1n);
    expect(balance).toBe(huge);
  });

  it("returns zero balance", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x0" }),
    } as Response);
    const balance = await connector.getBalance();
    expect(BigInt(balance)).toBe(0n);
  });

  it("throws when not connected", async () => {
    const fresh = new CoinbaseConnector({ appName: "Test" });
    await expect(fresh.getBalance()).rejects.toThrow("Session expired");
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. ERROR HANDLING
// ═══════════════════════════════════════════════════════════════

describe("Coinbase Financial: input validation", () => {
  let connector: InstanceType<typeof CoinbaseConnector>;
  let session: UniversalWalletSession;

  beforeEach(async () => {
    connector = await createConnectedConnector();
    session = createSession();
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

  it("throws on missing message in signMessage", async () => {
    await expect(
      connector.signMessage(session, { address: ACCOUNT } as any),
    ).rejects.toThrow("Missing message");
  });

  it("throws on missing address in signMessage", async () => {
    await expect(
      connector.signMessage(session, { message: "hello" } as any),
    ).rejects.toThrow("Missing message");
  });

  it("throws session_expired when provider not initialized", async () => {
    const fresh = new CoinbaseConnector({ appName: "Test" });
    await expect(
      fresh.sendTransaction(session, {
        transaction: { to: RECIPIENT, value: "0x1" },
      }),
    ).rejects.toThrow("Session expired");
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. PRODUCTION CODE NUMBER() VIOLATION — switchChain
// ═══════════════════════════════════════════════════════════════

describe("Coinbase Financial: switchChain Number() violation", () => {
  let connector: InstanceType<typeof CoinbaseConnector>;
  let session: UniversalWalletSession;

  beforeEach(async () => {
    connector = await createConnectedConnector();
    session = createSession();
  });

  it("uses Number() in switchChain — known violation for chainId > 2^53", () => {
    // connector.ts:402: const hexChainId = `0x${Number(numericChainId).toString(16)}`;
    // This truncates chain IDs larger than Number.MAX_SAFE_INTEGER.
    // Per ARCHITECTURE.md: "All financial operations use BigInt (Number conversion prohibited)"
    // This should eventually use BigInt instead of Number.
    const spy = vi.spyOn(globalThis, "Number");
    void connector.switchChain(session, "eip155:137");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

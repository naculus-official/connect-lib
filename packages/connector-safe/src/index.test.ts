/**
 * SafeConnector — Unit Tests
 *
 * Tests cover:
 * - Constructor and basic properties
 * - Environment detection
 * - connect() with mock SDK
 * - signMessage, sendTransaction
 * - Batch transactions
 * - switchChain (unsupported)
 * - Error conditions (unavailable, rejected, etc.)
 */

import type { UniversalWalletSession } from "@naculus/connect-core";
import { createEmptySession } from "@naculus/connect-core";
import { ADDRESSES } from "@naculus/test-utils/test-constants";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSafeConnector, SafeConnector } from "./index";

// ── Mock @safe-global/safe-apps-sdk ─────────────────────────────
// Safe SDK v9 API:
//   - sdk.safe.getInfo() → SafeInfoExtended
//   - sdk.txs.signMessage(message) → SignMessageResponse
//   - sdk.txs.signTypedMessage(typedData) → SignMessageResponse
//   - sdk.txs.send({ txs, params? }) → SendTransactionsResponse

const mockSafeInfo = {
  safeAddress: ADDRESSES.SAFE_MULTISIG,
  chainId: 1,
  owners: [ADDRESSES.SAFE_RECIPIENT_A, ADDRESSES.SAFE_RECIPIENT_B],
  threshold: 2,
  isReadOnly: false,
  nonce: 0,
  implementation: ADDRESSES.SAFE_IMPL,
  modules: null,
  fallbackHandler: null,
  guard: null,
  version: "1.4.1",
};

let mockSignMessageReject = false;
let mockSignTypedMessageReject = false;
let mockGetInfoReject = false;

const mockTxsSend = vi.fn().mockResolvedValue({
  safeTxHash: ADDRESSES.SAFE_TX_HASH,
});

const mockTxsSignMessage = vi
  .fn()
  .mockImplementation(async (message: string) => {
    if (mockSignMessageReject) throw new Error("User rejected signing");
    return { signature: `signed:${message}` };
  });

const mockTxsSignTypedMessage = vi
  .fn()
  .mockImplementation(async (_typedData: unknown) => {
    if (mockSignTypedMessageReject) throw new Error("User rejected signing");
    return { signature: "0xtypeddatasignature" };
  });

const mockSafeGetInfo = vi.fn().mockImplementation(async () => {
  if (mockGetInfoReject) throw new Error("Not in Safe App");
  return mockSafeInfo;
});

vi.mock("@safe-global/safe-apps-sdk", () => {
  return {
    default: class MockSafeAppsSDK {
      safe = {
        getInfo: mockSafeGetInfo,
      };
      txs = {
        send: mockTxsSend,
        signMessage: mockTxsSignMessage,
        signTypedMessage: mockTxsSignTypedMessage,
      };
    },
  };
});

// ── Helper ──────────────────────────────────────────────────────

/** Create a SafeConnector with mock availability enabled for testing */
function createTestConnector(config?: Parameters<typeof SafeConnector>[0]) {
  return new SafeConnector(config, true);
}

/** Create a mock wallet session for tests */
function createMockSession(
  overrides: Partial<UniversalWalletSession> = {},
): UniversalWalletSession {
  return createEmptySession({
    id: "safe-test-session",
    walletId: ADDRESSES.SAFE_MULTISIG,
    walletType: "safe",
    namespaces: {
      eip155: {
        chains: ["eip155:1"],
        accounts: ["eip155:1:0x1234567890123456789012345678901234567890"],
        methods: ["eth_sendTransaction", "personal_sign", "eth_signTypedData"],
        events: ["accountsChanged", "chainChanged"],
      },
    },
    platform: "desktop-web",
    ...overrides,
  });
}

/** Reset mocks between tests */
beforeEach(() => {
  vi.clearAllMocks();
  mockSignMessageReject = false;
  mockSignTypedMessageReject = false;
  mockGetInfoReject = false;
});

// ── Tests ───────────────────────────────────────────────────────

describe("SafeConnector → basic properties", () => {
  it("should create instance with correct id/name/kind/supports", () => {
    const c = createTestConnector();
    expect(c.id).toBe("safe");
    expect(c.name).toBe("Safe (Gnosis Safe)");
    expect(c.kind).toBe("safe");
    expect(c.namespaces).toEqual(["eip155"]);
    expect(c.supports.desktop).toBe(true);
    expect(c.supports.mobile).toBe(false);
    expect(c.supports.deepLink).toBe(false);
    expect(c.supports.qr).toBe(false);
    expect(c.supports.trustedReconnect).toBe(false);
  });

  it("should expose config", () => {
    const c = createTestConnector({ sdkOptions: { debug: true } });
    expect(c.sdkInstance).toBeDefined();
  });

  it("should default to empty config", () => {
    const c = createTestConnector();
    expect(c.sdkInstance).toBeDefined();
  });
});

describe("SafeConnector → availability", () => {
  it("should be available when overridden in constructor", () => {
    const c = createTestConnector();
    expect(c.isAvailable).toBe(true);
  });

  it("should not be available when not overridden (no iframe in node)", () => {
    const c = new SafeConnector();
    expect(c.isAvailable).toBe(false);
  });
});

describe("SafeConnector → connect", () => {
  it("should connect and return a session", async () => {
    const c = createTestConnector();
    const session = await c.connect();
    expect(session).toBeDefined();
    expect(session.id).toContain("safe-");
    expect(session.walletType).toBe("safe");
    expect(session.namespaces.eip155.accounts[0]).toContain(
      ADDRESSES.SAFE_MULTISIG,
    );
    expect(mockSafeGetInfo).toHaveBeenCalledOnce();
  });

  it("should set atomicBatch capability in session", async () => {
    const c = createTestConnector();
    const session = await c.connect();
    expect(session.namespaces.eip155.capabilities?.atomicBatch).toBeDefined();
    expect(session.namespaces.eip155.capabilities!.atomicBatch!.supported).toBe(
      true,
    );
  });

  it("should throw when getInfo fails", async () => {
    mockGetInfoReject = true;
    const c = createTestConnector();
    // When isAvailable=true but SDK getInfo fails, the error message is about Safe info
    await expect(c.connect()).rejects.toThrow("Failed to get Safe info");
  });
});

describe("SafeConnector → getAccounts", () => {
  it("should return Safe address from cached info", async () => {
    const c = createTestConnector();
    await c.connect();
    const accounts = await c.getAccounts(createMockSession());
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toContain(ADDRESSES.SAFE_MULTISIG);
  });

  it("should fallback to session namespaces when no cached info", async () => {
    const c = createTestConnector();
    const session = createMockSession();
    const accounts = await c.getAccounts(session);
    expect(accounts).toHaveLength(1);
  });
});

describe("SafeConnector → signMessage", () => {
  it("should sign a message successfully", async () => {
    const c = createTestConnector();
    await c.connect();
    const result = await c.signMessage(createMockSession(), {
      message: "Hello Safe!",
    });
    expect(result).toBeDefined();
    expect(mockTxsSignMessage).toHaveBeenCalledWith("Hello Safe!");
  });

  it("should throw when message is missing", async () => {
    const c = createTestConnector();
    await c.connect();
    await expect(c.signMessage(createMockSession(), {})).rejects.toThrow();
  });

  it("should throw when user rejects signing", async () => {
    mockSignMessageReject = true;
    const c = createTestConnector();
    await c.connect();
    await expect(
      c.signMessage(createMockSession(), { message: "test" }),
    ).rejects.toThrow("rejected");
  });

  it("should throw when SDK is not initialized", async () => {
    const c = createTestConnector();
    await c.disconnect();
    (c as any).sdk = null;
    await expect(
      c.signMessage(createMockSession(), { message: "test" }),
    ).rejects.toThrow("Safe SDK not initialized");
  });
});

describe("SafeConnector → sendTransaction", () => {
  it("should submit a transaction and return safeTxHash", async () => {
    const c = createTestConnector();
    await c.connect();
    const result = (await c.sendTransaction(createMockSession(), {
      transaction: {
        to: ADDRESSES.SAFE_RECIPIENT_A,
        value: "1000000000000000000",
        data: "0x",
      },
    })) as { safeTxHash: string };
    expect(result.safeTxHash).toBeDefined();
    expect(result.safeTxHash).toMatch(/^0x/);
    expect(mockTxsSend).toHaveBeenCalledOnce();
  });

  it("should throw when transaction is missing", async () => {
    const c = createTestConnector();
    await c.connect();
    await expect(c.sendTransaction(createMockSession(), {})).rejects.toThrow();
  });

  it("should throw when user rejects transaction", async () => {
    mockTxsSend.mockRejectedValueOnce(new Error("User rejected signing"));
    const c = createTestConnector();
    await c.connect();
    await expect(
      c.sendTransaction(createMockSession(), {
        transaction: {
          to: ADDRESSES.SAFE_RECIPIENT_A,
          value: "0",
          data: "0x",
        },
      }),
    ).rejects.toThrow("rejected");
  });

  it("should pass transaction fields to SDK (to/value/data only, params for safeTxGas)", async () => {
    const c = createTestConnector();
    await c.connect();
    await c.sendTransaction(createMockSession(), {
      transaction: {
        to: ADDRESSES.SAFE_RECIPIENT_A,
        value: "0",
        data: "0x",
        operation: 1,
        safeTxGas: 100000,
        baseGas: 21000,
        gasPrice: "50000000000",
        gasToken: "0x0000000000000000000000000000000000000000",
        refundReceiver: ADDRESSES.SAFE_RECIPIENT_B,
      },
    });
    expect(mockTxsSend).toHaveBeenCalledWith({
      txs: [
        {
          to: ADDRESSES.SAFE_RECIPIENT_A,
          value: "0",
          data: "0x",
        },
      ],
      params: {
        safeTxGas: 100000,
      },
    });
  });
});

describe("SafeConnector → batch transactions (sendTransactions)", () => {
  it("should submit multiple transactions as a batch", async () => {
    const c = createTestConnector();
    await c.connect();
    const result = await c.sendTransactions(createMockSession(), [
      {
        to: ADDRESSES.SAFE_RECIPIENT_A,
        value: "1000000000000000000",
        data: "0x",
      },
      {
        to: ADDRESSES.SAFE_RECIPIENT_B,
        value: "0",
        data: "0xdeadbeef",
        safeTxGas: 50000,
      },
    ]);
    expect(result.safeTxHash).toBeDefined();
    expect(mockTxsSend).toHaveBeenCalledWith({
      txs: [
        {
          to: ADDRESSES.SAFE_RECIPIENT_A,
          value: "1000000000000000000",
          data: "0x",
        },
        {
          to: ADDRESSES.SAFE_RECIPIENT_B,
          value: "0",
          data: "0xdeadbeef",
        },
      ],
      params: {
        safeTxGas: undefined,
      },
    });
  });

  it("should throw when txs array is empty", async () => {
    const c = createTestConnector();
    await c.connect();
    await expect(c.sendTransactions(createMockSession(), [])).rejects.toThrow(
      "At least one transaction is required",
    );
  });

  it("should throw when SDK is not initialized", async () => {
    const c = createTestConnector();
    await c.disconnect();
    (c as any).sdk = null;
    await expect(
      c.sendTransactions(createMockSession(), [
        { to: "0x0", value: "0", data: "0x" },
      ]),
    ).rejects.toThrow("Safe SDK not initialized");
  });
});

describe("SafeConnector → sendCalls (batch via UniversalConnector)", () => {
  it("should submit multiple calls", async () => {
    const c = createTestConnector();
    await c.connect();
    const hash = await c.sendCalls(createMockSession(), [
      { to: ADDRESSES.SAFE_RECIPIENT_A, value: "1", data: "0x" },
      { to: ADDRESSES.SAFE_RECIPIENT_B, data: "0x1234" },
    ]);
    expect(hash).toMatch(/^0x/);
    expect(mockTxsSend).toHaveBeenCalledWith({
      txs: [
        { to: ADDRESSES.SAFE_RECIPIENT_A, value: "1", data: "0x" },
        { to: ADDRESSES.SAFE_RECIPIENT_B, value: "0", data: "0x1234" },
      ],
    });
  });
});

describe("SafeConnector → signTypedData", () => {
  it("should sign typed data successfully", async () => {
    const c = createTestConnector();
    await c.connect();
    const typedData = {
      types: {
        EIP712Domain: [],
        Message: [{ name: "content", type: "string" }],
      },
      domain: { chainId: 1 },
      message: { content: "hello" },
    };
    const result = await c.signTypedData(createMockSession(), typedData);
    expect(result).toBeDefined();
    expect(mockTxsSignTypedMessage).toHaveBeenCalledWith(typedData);
  });

  it("should throw when user rejects", async () => {
    mockSignTypedMessageReject = true;
    const c = createTestConnector();
    await c.connect();
    await expect(
      c.signTypedData(createMockSession(), {
        types: {},
        domain: {},
        message: {},
      }),
    ).rejects.toThrow("rejected");
  });
});

describe("SafeConnector → switchChain", () => {
  it("should throw not supported", async () => {
    const c = createTestConnector();
    const session = createMockSession();
    await expect(c.switchChain(session, "eip155:137")).rejects.toThrow(
      "Safe Connector cannot switch chains",
    );
  });
});

describe("SafeConnector → getCapabilities", () => {
  it("should return atomicBatch capability", async () => {
    const c = createTestConnector();
    await c.connect();
    const caps = await c.getCapabilities(createMockSession());
    const chainKey = Object.keys(caps)[0];
    expect(chainKey).toContain("eip155:");
    expect(caps[chainKey].atomicBatch?.supported).toBe(true);
    expect(caps[chainKey].atomicBatch?.maxBatchSize).toBe(100);
  });
});

describe("SafeConnector → disconnect", () => {
  it("should clear internal state", async () => {
    const c = createTestConnector();
    await c.connect();
    expect((c as any).safeInfoInternal).not.toBeNull();
    await c.disconnect();
    expect((c as any).safeInfoInternal).toBeNull();
  });
});

describe("SafeConnector → getSafeInfo", () => {
  it("should return Safe environment info", async () => {
    const c = createTestConnector();
    await c.connect();
    const info = await c.getSafeInfo();
    expect(info.isSafeApp).toBe(true);
    expect(info.safeAddress).toBe(mockSafeInfo.safeAddress);
    expect(info.chainId).toBe(1);
    expect(info.owners).toHaveLength(2);
    expect(info.threshold).toBe(2);
    expect(info.version).toBe("1.4.1");
  });

  it("should return isSafeApp false when not connected", async () => {
    mockGetInfoReject = true;
    const c = createTestConnector();
    (c as any).safeInfoInternal = null;
    const info = await c.getSafeInfo();
    expect(info.isSafeApp).toBe(false);
  });
});

describe("SafeConnector → signTransaction", () => {
  it("should delegate to sendTransaction", async () => {
    const c = createTestConnector();
    await c.connect();
    const tx = {
      to: ADDRESSES.SAFE_RECIPIENT_A,
      value: "0",
      data: "0x",
    };
    const result = (await c.signTransaction(createMockSession(), {
      transaction: tx,
    })) as { safeTxHash: string };
    expect(result.safeTxHash).toBeDefined();
    expect(mockTxsSend).toHaveBeenCalled();
  });
});

// ── Factory Function Tests ──────────────────────────────────────

describe("createSafeConnector", () => {
  it("should create via factory", () => {
    const c = createSafeConnector();
    expect(c).toBeInstanceOf(SafeConnector);
  });

  it("should pass config", () => {
    const c = createSafeConnector({ sdkOptions: { debug: true } });
    expect(c.sdkInstance).toBeDefined();
  });
});

import type { BatchCall } from "@naculus/connect-core";
import { ADDRESSES } from "@naculus/test-utils/test-constants";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock @safe-global/safe-apps-sdk ───────────────────────────

const mockTxsSend = vi.fn();
const mockSafeGetInfo = vi.fn();

vi.mock("@safe-global/safe-apps-sdk", () => ({
  default: class MockSafeAppsSDK {
    safe = { getInfo: mockSafeGetInfo };
    txs = { send: mockTxsSend };
  },
}));

const { SafeConnector } = await import("./connector");

// ─── Constants ──────────────────────────────────────────────────

const SAFE_ADDRESS = ADDRESSES.TEST_2 as `0x${string}`;
const RECIPIENT = ("0x" + "ab".repeat(20)) as `0x${string}`;
const RECIPIENT2 = ("0x" + "cd".repeat(20)) as `0x${string}`;

const SAFE_TX_HASH = "0x" + "dd".repeat(32);

// ─── Helpers ────────────────────────────────────────────────────

function createTestConnector() {
  return new SafeConnector(undefined, true);
}

function createMockSession() {
  return {
    id: "safe-test-session",
    connectorId: "safe",
    namespaces: {
      eip155: {
        chains: ["eip155:1"],
        accounts: [`eip155:1:${SAFE_ADDRESS}`],
        methods: ["eth_sendTransaction", "personal_sign"],
        events: ["accountsChanged", "chainChanged"],
      },
    },
    expiry: Date.now() + 300_000,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSafeGetInfo.mockResolvedValue({
    safeAddress: SAFE_ADDRESS,
    chainId: 1,
    owners: [SAFE_ADDRESS],
    threshold: 1,
    isReadOnly: false,
    nonce: 0,
    implementation: "0xcccccccccccccccccccccccccccccccccccccccc",
    modules: null,
    fallbackHandler: null,
    guard: null,
    version: "1.4.1",
  });
  mockTxsSend.mockResolvedValue({ safeTxHash: SAFE_TX_HASH });
});

// ═══════════════════════════════════════════════════════════════
// 1. sendTransaction — VALUE PASSTHROUGH
// ═══════════════════════════════════════════════════════════════

describe("Safe Financial: sendTransaction value passthrough", () => {
  let connector: SafeConnector;

  beforeEach(async () => {
    connector = createTestConnector();
    await connector.connect();
  });

  it("passes hex value to Safe SDK", async () => {
    await connector.sendTransaction(createMockSession(), {
      transaction: { to: RECIPIENT, value: "0xde0b6b3a7640000", data: "0x" },
    });
    expect(mockTxsSend).toHaveBeenCalledWith({
      txs: [{ to: RECIPIENT, value: "0xde0b6b3a7640000", data: "0x" }],
      params: { safeTxGas: undefined },
    });
  });

  it("passes decimal string value as-is", async () => {
    await connector.sendTransaction(createMockSession(), {
      transaction: { to: RECIPIENT, value: "1000000000000000000", data: "0x" },
    });
    expect(mockTxsSend).toHaveBeenCalledWith({
      txs: [expect.objectContaining({ value: "1000000000000000000" })],
      params: { safeTxGas: undefined },
    });
  });

  it("passes zero value", async () => {
    await connector.sendTransaction(createMockSession(), {
      transaction: { to: RECIPIENT, value: "0x0", data: "0x" },
    });
    expect(mockTxsSend).toHaveBeenCalledWith({
      txs: [expect.objectContaining({ value: "0x0" })],
      params: { safeTxGas: undefined },
    });
  });

  it("passes 1 wei (dust) value", async () => {
    await connector.sendTransaction(createMockSession(), {
      transaction: { to: RECIPIENT, value: "0x1", data: "0x" },
    });
    expect(mockTxsSend).toHaveBeenCalledWith({
      txs: [expect.objectContaining({ value: "0x1" })],
      params: { safeTxGas: undefined },
    });
  });

  it("passes large value exceeding MAX_SAFE_INTEGER", async () => {
    const large = (Number.MAX_SAFE_INTEGER + 1000).toString();
    await connector.sendTransaction(createMockSession(), {
      transaction: { to: RECIPIENT, value: large, data: "0x" },
    });
    expect(mockTxsSend).toHaveBeenCalledWith({
      txs: [expect.objectContaining({ value: large })],
      params: { safeTxGas: undefined },
    });
  });

  it("passes only to/value/data to SDK (strips safeTxGas)", async () => {
    await connector.sendTransaction(createMockSession(), {
      transaction: {
        to: RECIPIENT,
        value: "0xde0b6b3a7640000",
        data: "0x",
        safeTxGas: 100000,
        operation: 1,
      },
    });
    // SDK BaseTransaction only accepts to/value/data; safeTxGas goes in params
    expect(mockTxsSend).toHaveBeenCalledWith({
      txs: [{ to: RECIPIENT, value: "0xde0b6b3a7640000", data: "0x" }],
      params: { safeTxGas: 100000 },
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. sendTransaction — safeTxHash RETURN FORMAT
// ═══════════════════════════════════════════════════════════════

describe("Safe Financial: safeTxHash return format", () => {
  let connector: SafeConnector;

  beforeEach(async () => {
    connector = createTestConnector();
    await connector.connect();
  });

  it("returns safeTxHash in object with safeTxHash field", async () => {
    const result = (await connector.sendTransaction(createMockSession(), {
      transaction: { to: RECIPIENT, value: "0x1", data: "0x" },
    })) as { safeTxHash: string };
    expect(result.safeTxHash).toBe(SAFE_TX_HASH);
    expect(result.safeTxHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("has no on-chain tx hash field", async () => {
    const result = (await connector.sendTransaction(createMockSession(), {
      transaction: { to: RECIPIENT, value: "0x1", data: "0x" },
    })) as Record<string, unknown>;
    expect(result).not.toHaveProperty("hash");
    expect(result).toHaveProperty("safeTxHash");
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. sendCalls — BATCH VALUES
// ═══════════════════════════════════════════════════════════════

describe("Safe Financial: sendCalls batch values", () => {
  let connector: SafeConnector;

  beforeEach(async () => {
    connector = createTestConnector();
    await connector.connect();
  });

  it("passes all call values to SDK", async () => {
    const calls: BatchCall[] = [
      { to: RECIPIENT, value: "0xde0b6b3a7640000", data: "0x" },
      { to: RECIPIENT2, value: "0x1bc16d674ec80000", data: "0x" },
    ];
    await connector.sendCalls(createMockSession(), calls);
    expect(mockTxsSend).toHaveBeenCalledWith({
      txs: [
        { to: RECIPIENT, value: "0xde0b6b3a7640000", data: "0x" },
        { to: RECIPIENT2, value: "0x1bc16d674ec80000", data: "0x" },
      ],
    });
  });

  it("defaults missing value to 0 string", async () => {
    await connector.sendCalls(createMockSession(), [
      { to: RECIPIENT, data: "0x" },
    ]);
    expect(mockTxsSend).toHaveBeenCalledWith({
      txs: [expect.objectContaining({ value: "0" })],
    });
  });

  it("defaults missing data to 0x", async () => {
    await connector.sendCalls(createMockSession(), [
      { to: RECIPIENT, value: "0x1" },
    ]);
    expect(mockTxsSend).toHaveBeenCalledWith({
      txs: [expect.objectContaining({ data: "0x" })],
    });
  });

  it("defaults both missing value and data", async () => {
    await connector.sendCalls(createMockSession(), [{ to: RECIPIENT }]);
    expect(mockTxsSend).toHaveBeenCalledWith({
      txs: [{ to: RECIPIENT, value: "0", data: "0x" }],
    });
  });

  it("returns safeTxHash as string (not object)", async () => {
    mockTxsSend.mockResolvedValue({ safeTxHash: SAFE_TX_HASH });
    const result = await connector.sendCalls(createMockSession(), [
      { to: RECIPIENT, value: "0x1", data: "0x" },
    ]);
    expect(result).toBe(SAFE_TX_HASH);
    expect(result).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. sendTransactions (Safe-specific) — BATCH VALUES
// ═══════════════════════════════════════════════════════════════

describe("Safe Financial: sendTransactions batch values", () => {
  let connector: SafeConnector;

  beforeEach(async () => {
    connector = createTestConnector();
    await connector.connect();
  });

  it("passes multiple tx values to SDK", async () => {
    await connector.sendTransactions(createMockSession(), [
      { to: RECIPIENT, value: "0xde0b6b3a7640000", data: "0x" },
      { to: RECIPIENT2, value: "0x0", data: "0xdeadbeef" },
    ]);
    expect(mockTxsSend).toHaveBeenCalledWith({
      txs: [
        { to: RECIPIENT, value: "0xde0b6b3a7640000", data: "0x" },
        { to: RECIPIENT2, value: "0x0", data: "0xdeadbeef" },
      ],
      params: { safeTxGas: undefined },
    });
  });

  it("passes safeTxGas from first tx", async () => {
    await connector.sendTransactions(createMockSession(), [
      { to: RECIPIENT, value: "0x1", data: "0x", safeTxGas: 50000 },
      { to: RECIPIENT2, value: "0x2", data: "0x", safeTxGas: 99999 },
    ]);
    // Only first tx's safeTxGas is used
    expect(mockTxsSend).toHaveBeenCalledWith({
      txs: [
        { to: RECIPIENT, value: "0x1", data: "0x" },
        { to: RECIPIENT2, value: "0x2", data: "0x" },
      ],
      params: { safeTxGas: 50000 },
    });
  });

  it("returns SafeTransactionResponse with safeTxHash", async () => {
    const result = await connector.sendTransactions(createMockSession(), [
      { to: RECIPIENT, value: "0x1", data: "0x" },
    ]);
    expect(result).toEqual({ safeTxHash: SAFE_TX_HASH });
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. signTransaction — DELEGATES TO sendTransaction
// ═══════════════════════════════════════════════════════════════

describe("Safe Financial: signTransaction delegation", () => {
  let connector: SafeConnector;

  beforeEach(async () => {
    connector = createTestConnector();
    await connector.connect();
  });

  it("delegates to sendTransaction and returns safeTxHash", async () => {
    const sendSpy = vi.spyOn(connector, "sendTransaction");
    const session = createMockSession();
    const tx = { to: RECIPIENT, value: "0xde0b6b3a7640000", data: "0x" };
    await connector.signTransaction(session, { transaction: tx });
    expect(sendSpy).toHaveBeenCalledWith(session, { transaction: tx });
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. VALIDATION & ERROR HANDLING
// ═══════════════════════════════════════════════════════════════

describe("Safe Financial: validation", () => {
  let connector: SafeConnector;

  beforeEach(async () => {
    connector = createTestConnector();
    await connector.connect();
  });

  it("throws on missing transaction in sendTransaction", async () => {
    await expect(
      connector.sendTransaction(createMockSession(), {} as any),
    ).rejects.toThrow("Missing transaction");
  });

  it("throws on missing transaction in signTransaction", async () => {
    await expect(
      connector.signTransaction(createMockSession(), {} as any),
    ).rejects.toThrow("Missing transaction");
  });

  it("throws on empty tx array in sendTransactions", async () => {
    await expect(
      connector.sendTransactions(createMockSession(), []),
    ).rejects.toThrow("At least one transaction is required");
  });

  it("throws when SDK not initialized for sendTransaction", async () => {
    const disconnected = createTestConnector();
    await disconnected.connect();
    await disconnected.disconnect();
    (disconnected as any).sdk = null;
    await expect(
      disconnected.sendTransaction(createMockSession(), {
        transaction: { to: RECIPIENT, value: "0x1", data: "0x" },
      }),
    ).rejects.toThrow("Safe SDK not initialized");
  });

  it("throws when SDK not initialized for sendCalls", async () => {
    const disconnected = createTestConnector();
    await disconnected.connect();
    await disconnected.disconnect();
    (disconnected as any).sdk = null;
    await expect(
      disconnected.sendCalls(createMockSession(), [
        { to: RECIPIENT, value: "0x1", data: "0x" },
      ]),
    ).rejects.toThrow("Safe SDK not initialized");
  });
});

describe("Safe Financial: user rejection", () => {
  let connector: SafeConnector;

  beforeEach(async () => {
    connector = createTestConnector();
    await connector.connect();
  });

  it("re-throws user rejection in sendTransaction", async () => {
    mockTxsSend.mockRejectedValueOnce(new Error("User rejected signing"));
    await expect(
      connector.sendTransaction(createMockSession(), {
        transaction: { to: RECIPIENT, value: "0x1", data: "0x" },
      }),
    ).rejects.toThrow("rejected");
  });

  it("re-throws user rejection in sendCalls", async () => {
    mockTxsSend.mockRejectedValueOnce(new Error("User denied"));
    await expect(
      connector.sendCalls(createMockSession(), [
        { to: RECIPIENT, value: "0x1", data: "0x" },
      ]),
    ).rejects.toThrow("rejected");
  });

  it("wraps non-rejection error in sendTransaction", async () => {
    mockTxsSend.mockRejectedValueOnce(new Error("Gas estimation failed"));
    await expect(
      connector.sendTransaction(createMockSession(), {
        transaction: { to: RECIPIENT, value: "0x1", data: "0x" },
      }),
    ).rejects.toThrow("Safe transaction submission failed");
  });
});

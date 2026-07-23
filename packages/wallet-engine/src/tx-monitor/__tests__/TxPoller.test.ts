import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TxPoller, DEFAULT_POLL_INTERVAL } from "../poller";
import type { ProviderLike } from "../types";

class MockProvider {
  private receipts = new Map<string, any>();
  private blockNumber = 100;
  private _request: ((method: string, params?: unknown[]) => Promise<unknown>) | null = null;

  setReceipt(hash: string, receipt: any | null): void {
    this.receipts.set(hash, receipt);
  }

  setBlockNumber(n: number): void {
    this.blockNumber = n;
  }

  setCustomRequest(fn: (method: string, params?: unknown[]) => Promise<unknown>): void {
    this._request = fn;
  }

  request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
    if (this._request) return this._request(method, params);
    switch (method) {
      case "eth_getTransactionReceipt": {
        const hash = params?.[0] as string;
        return Promise.resolve(this.receipts.get(hash) ?? null);
      }
      case "eth_blockNumber": {
        return Promise.resolve(`0x${this.blockNumber.toString(16)}`);
      }
      case "eth_getTransactionByHash": {
        const hash = params?.[0] as string;
        return Promise.resolve(this.receipts.get(hash) ?? null);
      }
      case "eth_getTransactionCount": {
        return Promise.resolve("0x5");
      }
      default:
        return Promise.resolve(null);
    }
  }
}

function getProvider(mock: MockProvider): (chainId: number) => ProviderLike {
  return () => mock as unknown as ProviderLike;
}

describe("TxPoller", () => {
  let mockProvider: MockProvider;
  let poller: TxPoller;

  beforeEach(() => {
    vi.useFakeTimers();
    mockProvider = new MockProvider();
    poller = new TxPoller(getProvider(mockProvider), 100);
  });

  afterEach(() => {
    poller.stopAll();
    vi.useRealTimers();
  });

  it("calls onStatus when receipt arrives (mined)", async () => {
    const hash = "0x" + "a".repeat(64);
    const onStatus = vi.fn();
    const onError = vi.fn();

    mockProvider.setReceipt(hash, {
      blockNumber: "0x64",
      blockHash: "0x" + "b".repeat(64),
      status: "0x1",
      gasUsed: "0x5208",
      effectiveGasPrice: "0x4a817c800",
    });
    mockProvider.setBlockNumber(100);

    poller.startPolling(hash, 1, onStatus, onError, 100);

    // Wait for the immediate poll to settle
    await vi.advanceTimersByTimeAsync(10);

    expect(onStatus).toHaveBeenCalled();
    const call = onStatus.mock.calls[0][0];
    expect(call.status).toBe("mined");
    expect(call.blockNumber).toBe(100);
  });

  it("transitions to confirmed when confirmations reached", async () => {
    const hash = "0x" + "c".repeat(64);
    const onStatus = vi.fn();
    const onError = vi.fn();

    mockProvider.setReceipt(hash, {
      blockNumber: "0x63", // 99
      blockHash: "0x" + "d".repeat(64),
      status: "0x1",
      gasUsed: "0x5208",
      effectiveGasPrice: "0x4a817c800",
    });
    // Current block 99, tx block 99 → 0 confirmations → mined
    mockProvider.setBlockNumber(99);

        poller.startPolling(hash, 1, onStatus, onError, 100, { requiredConfirmations: 3 } as any);

        // Wait for immediate poll
    await vi.advanceTimersByTimeAsync(10);

    expect(onStatus).toHaveBeenCalled();
    const firstCall = onStatus.mock.calls[0][0];
    expect(firstCall.status).toBe("mined");

    // Move block ahead so we have enough confirmations
    mockProvider.setBlockNumber(102); // 102 - 99 = 3 confirmations
    onStatus.mockClear();

    // Advance one timer cycle
    await vi.advanceTimersByTimeAsync(100);

    expect(onStatus).toHaveBeenCalled();
    const secondCall = onStatus.mock.calls[0][0];
    expect(secondCall.status).toBe("confirmed");
  });

  it("calls onStatus with failed when receipt status is 0x0", async () => {
    const hash = "0x" + "e".repeat(64);
    const onStatus = vi.fn();
    const onError = vi.fn();

    mockProvider.setReceipt(hash, {
      blockNumber: "0x64",
      blockHash: "0x" + "f".repeat(64),
      status: "0x0",
    });

    poller.startPolling(hash, 1, onStatus, onError, 100);
    await vi.advanceTimersByTimeAsync(10);

    expect(onStatus).toHaveBeenCalled();
    const call = onStatus.mock.calls[0][0];
    expect(call.status).toBe("failed");
    expect(call.error).toBeDefined();
  });

  it("calls onError on RPC failure", async () => {
    const hash = "0x" + "g".repeat(64);
    const onStatus = vi.fn();
    const onError = vi.fn();

    // Make the provider throw for the receipt call only
    mockProvider.setCustomRequest((method: string) => {
      if (method === "eth_getTransactionReceipt") return Promise.reject(new Error("RPC error"));
      return Promise.resolve("0x64");
    });

    poller.startPolling(hash, 1, onStatus, onError, 100);
    await vi.advanceTimersByTimeAsync(10);

    expect(onError).toHaveBeenCalled();
  });

  it("stops polling on stopPolling", async () => {
    const hash = "0x" + "h".repeat(64);
    const onStatus = vi.fn();
    const onError = vi.fn();

    mockProvider.setReceipt(hash, {
      blockNumber: "0x64",
      blockHash: "0x" + "i".repeat(64),
      status: "0x1",
    });
    mockProvider.setBlockNumber(101);

    poller.startPolling(hash, 1, onStatus, onError, 100);
    await vi.advanceTimersByTimeAsync(10);
    onStatus.mockClear();

    poller.stopPolling(hash, 1);

    // Advance time — no more polls should happen
    await vi.advanceTimersByTimeAsync(500);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("stopPolling without chainId scans all matching keys", async () => {
    const hash = "0x" + "j".repeat(64);
    const onStatus = vi.fn();
    const onError = vi.fn();

    mockProvider.setReceipt(hash, {
      blockNumber: "0x64",
      blockHash: "0x" + "k".repeat(64),
      status: "0x1",
    });
    mockProvider.setBlockNumber(100); // 0 confs → mined, entry stays alive

    poller.startPolling(hash, 1, onStatus, onError, 100, { requiredConfirmations: 2 } as any);
    await vi.advanceTimersByTimeAsync(10);
    onStatus.mockClear();

    poller.stopPolling(hash);
    await vi.advanceTimersByTimeAsync(200);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("getActivePolls and getActivePollKeys return active poll data", async () => {
    const hash = "0xtx";
    const onStatus = vi.fn();
    const onError = vi.fn();
    mockProvider.setBlockNumber(100);

    poller.startPolling(hash, 1, onStatus, onError, 100, {
      pollInterval: 100,
      label: "test",
      memo: "test",
      initialEntry: { status: "pending", chainId: 1 },
      requiredConfirmations: 2,
    });
    poller.startPolling("0x" + "l".repeat(64), 1, onStatus, onError, 100);
    poller.startPolling("0x" + "m".repeat(64), 137, onStatus, onError, 100);

    expect(poller.getActivePolls().length).toBeGreaterThanOrEqual(2);
    expect(poller.getActivePollKeys().length).toBeGreaterThanOrEqual(2);
  });

  it("pollNow triggers immediate poll", async () => {
    const hash = "0x" + "n".repeat(64);
    const onStatus = vi.fn();
    const onError = vi.fn();

    mockProvider.setReceipt(hash, {
      blockNumber: "0x64",
      blockHash: "0x" + "o".repeat(64),
      status: "0x1",
    });
    mockProvider.setBlockNumber(100); // tx block 100, current 100 → 0 confs → mined

    poller.startPolling(hash, 1, onStatus, onError, 100, {
      pollInterval: 100,
      label: "test",
      memo: "test",
      initialEntry: { status: "pending", chainId: 1 },
      requiredConfirmations: 2,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus.mock.calls[0][0].status).toBe("mined");
    onStatus.mockClear();

    await poller.pollNow(hash, 1);

    expect(onStatus).toHaveBeenCalled();
  });

  it("times out pending tx after MAX_PENDING_TIMEOUT_MS", async () => {
    const hash = "0x" + "p".repeat(64);
    const onStatus = vi.fn();
    const onError = vi.fn();

    mockProvider.setCustomRequest((method: string) => {
      if (method === "eth_getTransactionReceipt") return Promise.resolve(null);
      if (method === "eth_getTransactionByHash") return Promise.resolve({ hash, blockNumber: null });
      if (method === "eth_blockNumber") return Promise.resolve("0x64");
      return Promise.resolve(null);
    });

    poller.startPolling(hash, 1, onStatus, onError, 100);

    // First poll: pending (no receipt, tx in mempool)
    await vi.advanceTimersByTimeAsync(10);
    expect(onStatus).toHaveBeenCalled();

    // Advance past 5 min timeout
    onStatus.mockClear();
    await vi.advanceTimersByTimeAsync(301_000);

    expect(onStatus).toHaveBeenCalled();
    const call = onStatus.mock.calls[onStatus.mock.calls.length - 1][0];
    expect(call.status).toBe("failed");
    expect(call.error).toContain("timed out");
  });

  it("emits pending when tx is in mempool but no receipt yet", async () => {
    const hash = "0x" + "q".repeat(64);
    const onStatus = vi.fn();
    const onError = vi.fn();

    mockProvider.setCustomRequest((method: string) => {
      if (method === "eth_getTransactionReceipt") return Promise.resolve(null);
      if (method === "eth_getTransactionByHash") return Promise.resolve({ hash, blockNumber: null });
      if (method === "eth_blockNumber") return Promise.resolve("0x64");
      return Promise.resolve(null);
    });

    poller.startPolling(hash, 1, onStatus, onError, 100);
    await vi.advanceTimersByTimeAsync(10);

    expect(onStatus).toHaveBeenCalled();
    const call = onStatus.mock.calls[0][0];
    expect(call.status).toBe("pending");
  });

  it("wraps non-Error thrown values in Error object", async () => {
    const hash = "0x" + "r".repeat(64);
    const onStatus = vi.fn();
    const onError = vi.fn();

    mockProvider.setCustomRequest((method: string) => {
      if (method === "eth_getTransactionReceipt") return Promise.reject("string error");
      return Promise.resolve("0x64");
    });

    poller.startPolling(hash, 1, onStatus, onError, 100);
    await vi.advanceTimersByTimeAsync(10);

    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

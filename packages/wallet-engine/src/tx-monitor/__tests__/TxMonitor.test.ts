import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TxMonitor } from "../TxMonitor";
import { TxHistoryStore, MemoryHistoryStorage } from "../TxHistoryStore";
import type { ProviderLike } from "../types";

class MockProvider {
  private receipts = new Map<string, any>();
  private blockNumber = 100;
  private _customRequest: ((method: string, params?: unknown[]) => Promise<unknown>) | null = null;

  setReceipt(hash: string, receipt: any | null): void {
    this.receipts.set(hash, receipt);
  }

  setBlockNumber(n: number): void {
    this.blockNumber = n;
  }

  setCustomRequest(fn: (method: string, params?: unknown[]) => Promise<unknown>): void {
    this._customRequest = fn;
  }

  request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
    if (this._customRequest) return this._customRequest(method, params);
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

function createMonitor(mock: MockProvider): TxMonitor {
  return new TxMonitor({
    getProvider: () => mock as unknown as ProviderLike,
    defaultPollInterval: 100,
    defaultRequiredConfirmations: 1,
    autoCleanup: false,
    historyStore: undefined,
  });
}

describe("TxMonitor - State Transitions", () => {
  let mockProvider: MockProvider;
  let monitor: TxMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    mockProvider = new MockProvider();
    monitor = createMonitor(mockProvider);
    monitor.start();
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  it("starts watching and returns a TxStatusEntry", async () => {
    const hash = "0x" + "a".repeat(64);
    mockProvider.setReceipt(hash, null); // no receipt initially = pending

    const entry = await monitor.watchTx(hash, 1, {
      initialEntry: {
        from: "0x" + "b".repeat(40),
        to: "0x" + "c".repeat(40),
        value: "0x0",
      },
    });

    expect(entry.hash).toBe(hash);
    expect(entry.from).toBe("0x" + "b".repeat(40));
  });

  it("transitions from pending to mined when receipt arrives", async () => {
    const hash = "0x" + "d".repeat(64);
    const onStatusChange = vi.fn();
    monitor.on("statusChange", onStatusChange);

    // Set up receipt from the start — the immediate poll will find it
    mockProvider.setReceipt(hash, {
      blockNumber: "0x64", // 100
      blockHash: "0x" + "g".repeat(64),
      status: "0x1",
      gasUsed: "0x5208",
      effectiveGasPrice: "0x4a817c800",
    });
    mockProvider.setBlockNumber(100); // 100 - 100 = 0 confirmations → mined

    await monitor.watchTx(hash, 1, {
      initialEntry: { from: "0x" + "e".repeat(40), to: "0x" + "f".repeat(40), value: "0x0" },
      requiredConfirmations: 2, // Require 2 so it stays in "mined"
    });

    // Let the immediate poll settle
    await vi.advanceTimersByTimeAsync(10);

    expect(onStatusChange).toHaveBeenCalled();
    const lastCall = onStatusChange.mock.calls[onStatusChange.mock.calls.length - 1][0];
    expect(lastCall.status).toBe("mined");
  });

  it("transitions to confirmed when confirmations reached", async () => {
    const hash = "0x" + "h".repeat(64);
    const onConfirmed = vi.fn();
    monitor.on("confirmed", onConfirmed);

    // Tx in block 99, current block 101 → 2 confirmations
    mockProvider.setReceipt(hash, {
      blockNumber: "0x63", // 99
      blockHash: "0x" + "i".repeat(64),
      status: "0x1",
    });
    mockProvider.setBlockNumber(101); // 101 - 99 = 2 confs

    await monitor.watchTx(hash, 1, {
      initialEntry: { from: "0x" + "j".repeat(40), to: "0x" + "k".repeat(40), value: "0x0" },
      requiredConfirmations: 2,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(onConfirmed).toHaveBeenCalled();
    const call = onConfirmed.mock.calls[0][0];
    expect(call.status).toBe("confirmed");
  });

  it("transitions to failed when receipt status is 0x0", async () => {
    const hash = "0x" + "l".repeat(64);
    const onFailed = vi.fn();
    monitor.on("failed", onFailed);

    mockProvider.setReceipt(hash, {
      blockNumber: "0x64",
      blockHash: "0x" + "m".repeat(64),
      status: "0x0",
      gasUsed: "0x5208",
    });

    await monitor.watchTx(hash, 1, {
      initialEntry: { from: "0x" + "n".repeat(40), to: "0x" + "o".repeat(40), value: "0x0" },
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(onFailed).toHaveBeenCalled();
    const [entry, reason] = onFailed.mock.calls[0];
    expect(entry.status).toBe("failed");
    expect(reason).toBeDefined();
  });

  it("emits statusChange on state transitions", async () => {
    const hash = "0x" + "p".repeat(64);
    const onStatusChange = vi.fn();
    monitor.on("statusChange", onStatusChange);

    // Set up receipt to be found immediately
    mockProvider.setReceipt(hash, {
      blockNumber: "0x64",
      blockHash: "0x" + "q".repeat(64),
      status: "0x1",
    });
    mockProvider.setBlockNumber(101);

    await monitor.watchTx(hash, 1, {
      initialEntry: { from: "0x" + "r".repeat(40), to: "0x" + "s".repeat(40), value: "0x0" },
    });

    await vi.advanceTimersByTimeAsync(10);

    // Should transition: unknown → confirmed (since tx block 100, current 101 = 1 confirmation >= 1)
    expect(onStatusChange).toHaveBeenCalled();
  });

  it("does not re-emit same state on consecutive polls", async () => {
    const hash = "0x" + "t".repeat(64);
    const onStatusChange = vi.fn();
    monitor.on("statusChange", onStatusChange);

    mockProvider.setReceipt(hash, {
      blockNumber: "0x64",
      blockHash: "0x" + "u".repeat(64),
      status: "0x1",
    });
    mockProvider.setBlockNumber(101);

    await monitor.watchTx(hash, 1, {
      initialEntry: { from: "0x" + "v".repeat(40), to: "0x" + "w".repeat(40), value: "0x0" },
      requiredConfirmations: 1,
    });

    // First poll → confirmed
    await vi.advanceTimersByTimeAsync(10);
    expect(onStatusChange).toHaveBeenCalled();

    // Advance timer again — poller should have stopped after confirmation
    onStatusChange.mockClear();
    await vi.advanceTimersByTimeAsync(200);
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("retrieves status with getTxStatus", async () => {
    const hash = "0x" + "x".repeat(64);
    mockProvider.setReceipt(hash, null);

    await monitor.watchTx(hash, 1, {
      initialEntry: { from: "0x" + "y".repeat(40), to: "0x" + "z".repeat(40), value: "0x0" },
    });

    const status = monitor.getTxStatus(hash, 1);
    expect(status).not.toBeNull();
    expect(status!.hash).toBe(hash);

    // Without chainId
    const status2 = monitor.getTxStatus(hash);
    expect(status2).not.toBeNull();
    expect(status2!.hash).toBe(hash);
  });

  it("stops watching on stopWatching", async () => {
    const hash = "0x" + "aa".repeat(32);
    mockProvider.setReceipt(hash, null);

    await monitor.watchTx(hash, 1, {
      initialEntry: { from: "0x" + "bb".repeat(20), to: "0x" + "cc".repeat(20), value: "0x0" },
    });

    expect(monitor._watcherCount()).toBe(1);
    monitor.stopWatching(hash, 1);
    expect(monitor._watcherCount()).toBe(0);
  });
});

describe("TxMonitor - Reorg Handling", () => {
  let mockProvider: MockProvider;
  let monitor: TxMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    mockProvider = new MockProvider();
    monitor = createMonitor(mockProvider);
    monitor.start();
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  it("emits reorg event when block hash changes", async () => {
    const hash = "0x" + "a".repeat(64);
    const onReorg = vi.fn();
    monitor.on("reorg", onReorg);

    // First poll: receipt with block hash "0x1...64"
    mockProvider.setReceipt(hash, {
      blockNumber: "0x64",
      blockHash: "0x" + "1".repeat(64),
      status: "0x1",
    });
    mockProvider.setBlockNumber(100);

    await monitor.watchTx(hash, 1, {
      initialEntry: { from: "0x" + "b".repeat(40), to: "0x" + "c".repeat(40), value: "0x0" },
      requiredConfirmations: 2, // Require 2 confs so it stays in mined
    });

    // First poll → mined (0 confirmations, need 2)
    await vi.advanceTimersByTimeAsync(10);
    expect(monitor.getTxStatus(hash, 1)!.status).toBe("mined");
    onReorg.mockClear();

    // Second poll: different block hash = reorg
    mockProvider.setReceipt(hash, {
      blockNumber: "0x64",
      blockHash: "0x" + "2".repeat(64), // different block hash!
      status: "0x1",
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(onReorg).toHaveBeenCalled();
    const [reorgHash] = onReorg.mock.calls[0];
    expect(reorgHash).toBe(hash);
  });
});

describe("TxMonitor - Event Management", () => {
  let mockProvider: MockProvider;
  let monitor: TxMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    mockProvider = new MockProvider();
    monitor = createMonitor(mockProvider);
    monitor.start();
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  it("removes event listener with off()", async () => {
    const hash = "0x" + "d".repeat(64);
    const fn = vi.fn();
    monitor.on("statusChange", fn);
    monitor.off("statusChange", fn);

    mockProvider.setReceipt(hash, {
      blockNumber: "0x64",
      blockHash: "0x" + "e".repeat(64),
      status: "0x1",
    });
    mockProvider.setBlockNumber(101);

    await monitor.watchTx(hash, 1, {
      initialEntry: { from: "0x" + "f".repeat(40), to: "0x" + "g".repeat(40), value: "0x0" },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(fn).not.toHaveBeenCalled();
  });

  it("returns existing entry when already watching same tx", async () => {
    const hash = "0x" + "h".repeat(64);
    mockProvider.setReceipt(hash, null);

    const entry1 = await monitor.watchTx(hash, 1, {
      initialEntry: { from: "0x" + "i".repeat(40), to: "0x" + "j".repeat(40), value: "0x0" },
    });

    const entry2 = await monitor.watchTx(hash, 1);
    expect(entry2.hash).toBe(hash);
  });

  it("returns stored confirmed entry without re-watching", async () => {
    const hash = "0x" + "k".repeat(64);
    const store = monitor._getStore();
    await store.upsert({
      hash,
      chainId: 1,
      from: "0x" + "l".repeat(40),
      to: "0x" + "m".repeat(40),
      value: "0x0",
      status: "confirmed",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      replacementCount: 0,
      blockNumber: 100,
      blockHash: "0x" + "n".repeat(64),
      confirmedAt: Date.now(),
    });

    const entry = await monitor.watchTx(hash, 1);
    expect(entry.status).toBe("confirmed");
    expect(monitor._watcherCount()).toBe(0);
  });

  it("stopWatching without chainId scans all watchers", async () => {
    const hash = "0x" + "o".repeat(64);
    mockProvider.setReceipt(hash, null);

    await monitor.watchTx(hash, 1, {
      initialEntry: { from: "0x" + "p".repeat(40), to: "0x" + "q".repeat(40), value: "0x0" },
    });

    expect(monitor._watcherCount()).toBe(1);
    monitor.stopWatching(hash);
    expect(monitor._watcherCount()).toBe(0);
  });

  it("stopWatchingByChain removes all watchers on that chain", async () => {
    const receipt = {
      blockNumber: "0x64",
      blockHash: "0x" + "r".repeat(64),
      status: "0x1",
    };
    mockProvider.setReceipt("0x" + "r".repeat(64), receipt);
    mockProvider.setReceipt("0x" + "s".repeat(64), receipt);
    mockProvider.setReceipt("0x" + "t".repeat(64), receipt);
    mockProvider.setBlockNumber(100); // 0 confs → mined (needs 2 to confirm)

    await monitor.watchTx("0x" + "r".repeat(64), 1, {
      initialEntry: { from: "0x" + "u".repeat(40), to: "0x" + "v".repeat(40), value: "0x0" },
      requiredConfirmations: 2,
    });
    await monitor.watchTx("0x" + "s".repeat(64), 1, {
      initialEntry: { from: "0x" + "w".repeat(40), to: "0x" + "x".repeat(40), value: "0x0" },
      requiredConfirmations: 2,
    });
    await monitor.watchTx("0x" + "t".repeat(64), 137, {
      initialEntry: { from: "0x" + "y".repeat(40), to: "0x" + "z".repeat(40), value: "0x0" },
      requiredConfirmations: 2,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(monitor._watcherCount()).toBe(3);
    monitor.stopWatchingByChain(1);
    expect(monitor._watcherCount()).toBe(1);
  });

  it("getTxStatus returns null for unknown hash without chainId", () => {
    const status = monitor.getTxStatus("0xnonexistent");
    expect(status).toBeNull();
  });

  it("getTxHistory returns entries for an address", async () => {
    const hash = "0x" + "aa".repeat(32);
    mockProvider.setReceipt(hash, null);

    await monitor.watchTx(hash, 1, {
      initialEntry: { from: "0x" + "bb".repeat(20), to: "0x" + "cc".repeat(20), value: "0x0" },
    });

    const history = await monitor.getTxHistory("0x" + "bb".repeat(20));
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].hash).toBe(hash);
  });

  it("getTxHistory filters by chainId", async () => {
    const hash1 = "0x" + "dd".repeat(32);
    const hash2 = "0x" + "ee".repeat(32);
    mockProvider.setReceipt(hash1, null);
    mockProvider.setReceipt(hash2, null);

    await monitor.watchTx(hash1, 1, { initialEntry: { from: "0x" + "ff".repeat(20), to: "0x" + "gg".repeat(20), value: "0x0" } });
    await monitor.watchTx(hash2, 137, { initialEntry: { from: "0x" + "hh".repeat(20), to: "0x" + "ii".repeat(20), value: "0x0" } });

    const history = await monitor.getTxHistory(undefined, 137);
    expect(history).toHaveLength(1);
  });

  it("refreshTx with explicit chainId triggers poll", async () => {
    const hash = "0x" + "jj".repeat(32);
    mockProvider.setReceipt(hash, {
      blockNumber: "0x64",
      blockHash: "0x" + "kk".repeat(32),
      status: "0x1",
    });
    mockProvider.setBlockNumber(101);

    await monitor.watchTx(hash, 1, {
      initialEntry: { from: "0x" + "ll".repeat(20), to: "0x" + "mm".repeat(20), value: "0x0" },
    });

    const status = monitor.getTxStatus(hash, 1)!;
    const oldUpdatedAt = status.updatedAt;

    await vi.advanceTimersByTimeAsync(10);
    await monitor.refreshTx(hash, 1);

    expect(monitor.getTxStatus(hash, 1)!.updatedAt).toBeGreaterThanOrEqual(oldUpdatedAt);
  });

  it("refreshTx resolves chainId from store when not being watched", async () => {
    const hash = "0x" + "nn".repeat(32);
    const store = monitor._getStore();
    await store.upsert({
      hash,
      chainId: 1,
      from: "0x" + "oo".repeat(20),
      to: "0x" + "pp".repeat(20),
      value: "0x0",
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      replacementCount: 0,
    });

    // refreshTx should find it in store and call pollNow (no error expected)
    await expect(monitor.refreshTx(hash)).resolves.toBeUndefined();
  });

  it("refreshTx resolves chainId from active watcher", async () => {
    const hash = "0x" + "qq".repeat(32);
    mockProvider.setReceipt(hash, {
      blockNumber: "0x64",
      blockHash: "0x" + "rr".repeat(32),
      status: "0x1",
    });
    mockProvider.setBlockNumber(100);

    await monitor.watchTx(hash, 1, {
      initialEntry: { from: "0x" + "ss".repeat(20), to: "0x" + "tt".repeat(20), value: "0x0" },
      requiredConfirmations: 2, // stays mined
    });

    await vi.advanceTimersByTimeAsync(10);
    await expect(monitor.refreshTx(hash)).resolves.toBeUndefined();
  });

  it("stored mined entry is re-watched and continues monitoring", async () => {
    monitor.stop();
    vi.useRealTimers();

    // Create monitor with pre-populated "mined" entry in store
    const customStore = new TxHistoryStore(new MemoryHistoryStorage());
    await customStore.upsert({
      hash: "0x" + "uu".repeat(32),
      chainId: 1,
      from: "0x" + "vv".repeat(20),
      to: "0x" + "ww".repeat(20),
      value: "0x0",
      status: "mined",
      blockNumber: 100,
      blockHash: "0x" + "xx".repeat(32),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      replacementCount: 0,
    });

    const mon = new TxMonitor({
      getProvider: () => mockProvider as unknown as ProviderLike,
      defaultPollInterval: 100,
      autoCleanup: false,
      historyStore: customStore,
    });
    mon.start();

    const hash = "0x" + "uu".repeat(32);
    mockProvider.setReceipt(hash, {
      blockNumber: "0x64",
      blockHash: "0x" + "yy".repeat(32),
      status: "0x1",
    });
    mockProvider.setBlockNumber(101);

    // Watching a stored "mined" entry should re-use it and keep status as mined
    const entry = await mon.watchTx(hash, 1);
    expect(entry.status).toBe("mined");

    mon.stop();
  });
});

describe("TxMonitor - Lifecycle & Error Handling", () => {
  let mockProvider: MockProvider;
  let monitor: TxMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    mockProvider = new MockProvider();
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  it("start() already running is a no-op", () => {
    monitor = createMonitor(mockProvider);
    monitor.start();
    // Calling start again should not throw
    expect(() => monitor.start()).not.toThrow();
  });

  it("stop() clears watchers and cleanup timer", () => {
    monitor = new TxMonitor({
      getProvider: () => mockProvider as unknown as ProviderLike,
      defaultPollInterval: 100,
      autoCleanup: true,
    });
    monitor.start();
    expect(monitor._watcherCount()).toBe(0);

    monitor.stop();
    expect(monitor._watcherCount()).toBe(0);
  });

  it("clearHistory removes all entries from store", async () => {
    monitor = createMonitor(mockProvider);

    const hash = "0x" + "qq".repeat(32);
    mockProvider.setReceipt(hash, null);

    await monitor.watchTx(hash, 1, {
      initialEntry: { from: "0x" + "rr".repeat(20), to: "0x" + "ss".repeat(20), value: "0x0" },
    });

    await monitor.clearHistory();
    const store = monitor._getStore();
    expect(await store.count()).toBe(0);
  });

  it("updates status on poll error", async () => {
    monitor = createMonitor(mockProvider);
    monitor.start();

    const hash = "0x" + "tt".repeat(32);
    const onStatusChange = vi.fn();
    monitor.on("statusChange", onStatusChange);

    // First poll succeeds (mined with 2 confirmations needed → stays alive)
    mockProvider.setReceipt(hash, {
      blockNumber: "0x64",
      blockHash: "0x" + "uu".repeat(32),
      status: "0x1",
    });
    mockProvider.setBlockNumber(100);

    await monitor.watchTx(hash, 1, {
      initialEntry: { from: "0x" + "vv".repeat(20), to: "0x" + "ww".repeat(20), value: "0x0" },
      requiredConfirmations: 2,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(monitor.getTxStatus(hash, 1)).not.toBeNull();

    // Make next poll throw
    onStatusChange.mockClear();
    mockProvider.setCustomRequest((method: string) => {
      if (method === "eth_getTransactionReceipt") return Promise.reject(new Error("RPC down"));
      return Promise.resolve("0x64");
    });

    await vi.advanceTimersByTimeAsync(200);

    expect(onStatusChange).toHaveBeenCalled();
    const status = monitor.getTxStatus(hash, 1);
    expect(status!.error).toBe("RPC down");
  });

  it("cleanup runs on start with autoCleanup and removes expired entries", async () => {
    monitor = new TxMonitor({
      getProvider: () => mockProvider as unknown as ProviderLike,
      defaultPollInterval: 100,
      autoCleanup: true,
      retentionDays: 30,
    });

    const store = monitor._getStore();
    // Insert 100 entries + one very old one
    for (let i = 0; i < 100; i++) {
      await store.upsert({
        hash: "0x" + i.toString(16).padStart(64, "0"),
        chainId: 1,
        from: "0x" + "xx".repeat(20),
        to: "0x" + "yy".repeat(20),
        value: "0x0",
        status: "confirmed",
        createdAt: Date.now() - 1 * 24 * 60 * 60 * 1000,
        updatedAt: Date.now(),
        replacementCount: 0,
      });
    }

    const oldHash = "0x" + "zz".repeat(32);
    const oldEntry = {
      hash: oldHash,
      chainId: 1,
      from: "0x" + "xx".repeat(20),
      to: "0x" + "yy".repeat(20),
      value: "0x0",
      status: "confirmed",
      createdAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
      updatedAt: Date.now(),
      replacementCount: 0,
    };
    await store.upsert(oldEntry);

    monitor.start();
    // Flush async cleanup that runs on start()
    await vi.advanceTimersByTimeAsync(0);

    // After cleanup, the old entry should be removed
    const oldRetrieved = await store.get(oldHash, 1);
    expect(oldRetrieved).toBeNull();
  });

  it("testing helpers provide access to internals", () => {
    monitor = createMonitor(mockProvider);
    expect(monitor._getStore()).toBeInstanceOf(TxHistoryStore);
    expect(monitor._getPoller()).toBeDefined();
    expect(monitor._watcherCount()).toBe(0);
  });
});

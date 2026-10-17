/**
 * Validation for wallet-engine/tx-monitor/receipt-identity-mismatch
 * (NEEDS-VALIDATION.md run2, line 486). Run without OS sandbox: in-process,
 * in-memory ProviderLike, fake timers, dummy hashes, no network.
 *
 * Mechanism only: inaccurate observation state for watched hash A. Whether
 * any consumer makes a protected decision from a TxMonitor terminal event is
 * not shown here (no such consumer was identified), and a hash-equality check
 * would not authenticate a provider that fabricates matching fields.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryHistoryStorage,
  TxHistoryStore,
} from "./tx-monitor/TxHistoryStore";
import { TxMonitor } from "./tx-monitor/TxMonitor";
import type { ProviderLike, TxStatusEntry } from "./tx-monitor/types";

const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;
const BLOCK_HASH = `0x${"c".repeat(64)}`;

function receiptFor(transactionHash: string) {
  return {
    transactionHash,
    blockNumber: "0x63",
    blockHash: BLOCK_HASH,
    status: "0x1",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x1",
  };
}

function setup(receipt: unknown, txKnown = true) {
  const receiptParams: unknown[][] = [];
  const provider: ProviderLike = {
    request: async ({ method, params }) => {
      if (method === "eth_getTransactionReceipt") {
        receiptParams.push(params ?? []);
        return receipt;
      }
      if (method === "eth_blockNumber") return "0x65";
      // A known, still-pending transaction: not "dropped".
      if (method === "eth_getTransactionByHash")
        return txKnown ? { hash: params?.[0] } : null;
      return null;
    },
  };
  const store = new TxHistoryStore(new MemoryHistoryStorage());
  const monitor = new TxMonitor({
    getProvider: () => provider,
    defaultPollInterval: 100,
    defaultRequiredConfirmations: 1,
    autoCleanup: false,
    historyStore: store,
  });
  const confirmed: TxStatusEntry[] = [];
  const changes: TxStatusEntry[] = [];
  monitor.on("confirmed", (entry: TxStatusEntry) => confirmed.push(entry));
  monitor.on("statusChange", (entry: TxStatusEntry) => changes.push(entry));
  monitor.start();
  return { monitor, store, receiptParams, confirmed, changes };
}

async function watchA(monitor: TxMonitor) {
  await monitor.watchTx(HASH_A, 1, {
    initialEntry: {
      from: `0x${"e".repeat(40)}`,
      to: `0x${"f".repeat(40)}`,
      value: "0x0",
    },
  });
  // Let the immediate poll and the memory-store upsert settle.
  await vi.advanceTimersByTimeAsync(10);
}

let active: TxMonitor | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  active?.stop();
  active = null;
  vi.useRealTimers();
});

describe("validation: wallet-engine/tx-monitor/receipt-identity-mismatch", () => {
  it("control: a matching receipt confirms A and stops polling", async () => {
    const f = setup(receiptFor(HASH_A));
    active = f.monitor;
    await watchA(f.monitor);
    expect(f.receiptParams[0]).toEqual([HASH_A]);
    expect(f.monitor.getTxStatus(HASH_A, 1)?.status).toBe("confirmed");
    expect(f.confirmed.map(({ hash }) => hash)).toEqual([HASH_A]);
    expect((await f.store.get(HASH_A, 1))?.blockHash).toBe(BLOCK_HASH);
    const polls = f.receiptParams.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.receiptParams.length).toBe(polls);
  });

  it("control: a null receipt leaves A pending and still polling", async () => {
    const f = setup(null);
    active = f.monitor;
    await watchA(f.monitor);
    expect(f.monitor.getTxStatus(HASH_A, 1)?.status).toBe("pending");
    expect(f.confirmed).toEqual([]);
    const polls = f.receiptParams.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.receiptParams.length).toBeGreaterThan(polls);
  });

  // wallet-engine/tx-monitor/receipt-identity-mismatch: getReceipt/pollOnce
  // pass the provider's receipt to handleReceipt without comparing its
  // transactionHash to the watched hash.
  it("a receipt for B returned to A's request does not confirm or annotate A", async () => {
    const f = setup(receiptFor(HASH_B));
    active = f.monitor;
    await watchA(f.monitor);
    expect(f.receiptParams[0]).toEqual([HASH_A]);

    expect(f.confirmed).toEqual([]);
    expect(f.monitor.getTxStatus(HASH_A, 1)?.status).not.toBe("confirmed");
    expect(f.monitor.getTxStatus(HASH_A, 1)?.blockHash).not.toBe(BLOCK_HASH);
    expect((await f.store.get(HASH_A, 1))?.blockHash).not.toBe(BLOCK_HASH);
  });

  // wallet-engine/tx-monitor/receipt-identity-mismatch: the mismatched
  // receipt also ends A's polling as terminal.
  it("a receipt for B returned to A's request does not stop A's polling", async () => {
    const f = setup(receiptFor(HASH_B));
    active = f.monitor;
    await watchA(f.monitor);
    const polls = f.receiptParams.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.receiptParams.length).toBeGreaterThan(polls);
  });

  // A mismatched receipt is "no receipt for A", never evidence that A was
  // dropped, even when the provider also cannot find A itself.
  it("a receipt for B does not mark A as dropped", async () => {
    const f = setup(receiptFor(HASH_B), false);
    active = f.monitor;
    await watchA(f.monitor);
    expect(f.monitor.getTxStatus(HASH_A, 1)?.status).toBe("pending");
    const polls = f.receiptParams.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.receiptParams.length).toBeGreaterThan(polls);
  });

  // Fail closed: a receipt that does not name its transaction is not
  // accepted as A's receipt.
  it("a receipt with no transactionHash field leaves A pending", async () => {
    const { transactionHash: _omitted, ...noHash } = receiptFor(HASH_A);
    const f = setup(noHash);
    active = f.monitor;
    await watchA(f.monitor);
    expect(f.confirmed).toEqual([]);
    expect(f.monitor.getTxStatus(HASH_A, 1)?.status).toBe("pending");
    expect((await f.store.get(HASH_A, 1))?.blockHash).not.toBe(BLOCK_HASH);
    const polls = f.receiptParams.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.receiptParams.length).toBeGreaterThan(polls);
  });

  it("a receipt whose transactionHash is not a string leaves A pending", async () => {
    const f = setup({ ...receiptFor(HASH_A), transactionHash: 1 });
    active = f.monitor;
    await watchA(f.monitor);
    expect(f.confirmed).toEqual([]);
    expect(f.monitor.getTxStatus(HASH_A, 1)?.status).toBe("pending");
    const polls = f.receiptParams.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.receiptParams.length).toBeGreaterThan(polls);
  });

  it("a receipt whose hash differs only in hex case still confirms A", async () => {
    const f = setup(receiptFor(HASH_A.replace(/a/g, "A").replace(/^0X/, "0x")));
    active = f.monitor;
    await watchA(f.monitor);
    expect(f.monitor.getTxStatus(HASH_A, 1)?.status).toBe("confirmed");
  });
});

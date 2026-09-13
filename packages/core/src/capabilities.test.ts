import { describe, expect, it, vi } from "vitest";
import {
  NO_CAPABILITIES,
  chooseExecutionStrategy,
  getAccountCapabilities,
} from "./capabilities";
import type { AccountCapabilities } from "./capabilities";

/**
 * The point of this layer is that a caller expresses "send these calls" and
 * never branches on EIP-5792, ERC-4337 or whatever replaces them. Two
 * properties carry that: a capability query must never take down the operation
 * it was meant to inform, and "the wallet said no" must stay distinguishable
 * from "the wallet has no way to say" — an older wallet may batch perfectly
 * well without being able to advertise it.
 */

const session = (chains: Record<string, string[]>) =>
  ({
    namespaces: Object.fromEntries(
      Object.entries(chains).map(([ns, c]) => [ns, { chains: c, accounts: [] }]),
    ),
  }) as never;

const evmSession = session({ eip155: ["eip155:1", "eip155:137"] });

const connector = (
  getCapabilities?: unknown,
): Parameters<typeof getAccountCapabilities>[0] =>
  ({ id: "test", getCapabilities }) as never;

describe("getAccountCapabilities", () => {
  it("reports nothing discovered when the connector cannot be asked", async () => {
    const caps = await getAccountCapabilities(connector(), evmSession);
    expect(caps).toEqual(NO_CAPABILITIES);
    expect(caps.discovered).toBe(false);
  });

  it("normalizes an advertised atomic batch", async () => {
    const caps = await getAccountCapabilities(
      connector(
        vi.fn(async () => ({
          "eip155:1": {
            atomicBatch: { supported: true, maxBatchSize: 8 },
            paymasterService: { supported: true },
          },
        })),
      ),
      evmSession,
    );
    expect(caps).toEqual({
      atomicBatch: true,
      maxBatchSize: 8,
      sponsoredTransactions: true,
      discovered: true,
    });
  });

  it("distinguishes a wallet that answered no from one that could not answer", async () => {
    const answered = await getAccountCapabilities(
      connector(
        vi.fn(async () => ({
          "eip155:1": { atomicBatch: { supported: false } },
        })),
      ),
      evmSession,
    );
    expect(answered).toMatchObject({ atomicBatch: false, discovered: true });

    const unasked = await getAccountCapabilities(connector(), evmSession);
    expect(unasked).toMatchObject({ atomicBatch: false, discovered: false });
  });

  it("defaults to the active chain", async () => {
    // chains[0] is the active chain by convention across every connector.
    const caps = await getAccountCapabilities(
      connector(
        vi.fn(async () => ({
          "eip155:1": { atomicBatch: { supported: true } },
          "eip155:137": { atomicBatch: { supported: false } },
        })),
      ),
      evmSession,
    );
    expect(caps.atomicBatch).toBe(true);
  });

  it("honours an explicitly requested chain", async () => {
    const caps = await getAccountCapabilities(
      connector(
        vi.fn(async () => ({
          "eip155:1": { atomicBatch: { supported: true } },
          "eip155:137": { atomicBatch: { supported: false } },
        })),
      ),
      evmSession,
      "eip155:137",
    );
    expect(caps.atomicBatch).toBe(false);
  });

  it("reports discovered-but-empty for a chain the wallet omitted", async () => {
    const caps = await getAccountCapabilities(
      connector(vi.fn(async () => ({ "eip155:999": {} }))),
      evmSession,
    );
    expect(caps).toMatchObject({ atomicBatch: false, discovered: true });
  });

  it("does not take the flow down when the query throws", async () => {
    // Asking what a wallet can do is not part of what the user asked for.
    const caps = await getAccountCapabilities(
      connector(
        vi.fn(async () => {
          throw new Error("wallet refused");
        }),
      ),
      evmSession,
    );
    expect(caps).toEqual(NO_CAPABILITIES);
  });

  it("survives a wallet returning nonsense", async () => {
    const caps = await getAccountCapabilities(
      connector(vi.fn(async () => null)),
      evmSession,
    );
    expect(caps.atomicBatch).toBe(false);
    // No answer at all is not an answer. Contrast with the omitted-chain case
    // above, which is discovered: the wallet was asked and reported nothing.
    expect(caps.discovered).toBe(false);
  });

  it("treats a facade that declines to route as not asked", async () => {
    // AppKit's Web3Client returns undefined synchronously when the connector
    // behind the session has no getCapabilities of its own.
    const caps = await getAccountCapabilities(
      { getCapabilities: () => undefined },
      evmSession,
    );
    expect(caps).toEqual(NO_CAPABILITIES);
  });

  it("works for a non-EVM namespace", async () => {
    const caps = await getAccountCapabilities(
      connector(
        vi.fn(async () => ({ "solana:abc": { atomicBatch: { supported: true } } })),
      ),
      session({ solana: ["solana:abc"] }),
    );
    expect(caps.atomicBatch).toBe(true);
  });

  it("reports nothing when the session has no chain at all", async () => {
    const caps = await getAccountCapabilities(
      connector(vi.fn(async () => ({}))),
      session({}),
    );
    expect(caps).toEqual(NO_CAPABILITIES);
  });
});

describe("chooseExecutionStrategy", () => {
  const caps = (over: Partial<AccountCapabilities> = {}): AccountCapabilities => ({
    atomicBatch: true,
    sponsoredTransactions: false,
    discovered: true,
    ...over,
  });

  it.each([0, 1])(
    "sends %i call sequentially even when batching is available",
    (count) => {
      // Batching a single call buys nothing and costs an extra approval.
      expect(chooseExecutionStrategy(caps(), count)).toBe("sequential");
    },
  );

  it("batches when the account supports it", () => {
    expect(chooseExecutionStrategy(caps(), 3)).toBe("atomic-batch");
  });

  it("falls back when the account does not support batching", () => {
    expect(chooseExecutionStrategy(caps({ atomicBatch: false }), 3)).toBe(
      "sequential",
    );
  });

  it("falls back rather than splitting past the advertised limit", () => {
    // Two batches are not atomic, which was the reason to batch at all.
    expect(chooseExecutionStrategy(caps({ maxBatchSize: 2 }), 3)).toBe(
      "sequential",
    );
  });

  it("batches at exactly the advertised limit", () => {
    expect(chooseExecutionStrategy(caps({ maxBatchSize: 3 }), 3)).toBe(
      "atomic-batch",
    );
  });

  it("treats an undiscovered wallet conservatively", () => {
    expect(chooseExecutionStrategy(NO_CAPABILITIES, 5)).toBe("sequential");
  });
});

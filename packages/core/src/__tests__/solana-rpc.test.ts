/// <reference types="vitest" />
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatSol,
  getSignatureStatus,
  getSolanaBalance,
  LAMPORTS_PER_SOL,
  parseSol,
  SolanaRpcError,
} from "../solana-rpc";

function rpcReturning(...responses: unknown[]) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => responses.shift() ?? { jsonrpc: "2.0", id: 1, result: {} },
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("SOL amounts", () => {
  // 0.1 is not representable in binary floating point. A balance that is
  // wrong in the last digits is a balance a user stops trusting.
  it("formats exactly, without floating point", () => {
    expect(formatSol(100_000_000n)).toBe("0.1");
    expect(formatSol(1n)).toBe("0.000000001");
    expect(formatSol(LAMPORTS_PER_SOL)).toBe("1");
    expect(formatSol(0n)).toBe("0");
    expect(formatSol(1_234_567_890_123n)).toBe("1234.567890123");
  });

  it("keeps a whole number whole", () => {
    expect(formatSol(2n * LAMPORTS_PER_SOL)).toBe("2");
  });

  it("round-trips through parse", () => {
    for (const amount of ["0.1", "1", "1234.567890123", "0.000000001"]) {
      expect(formatSol(parseSol(amount))).toBe(amount);
    }
  });

  // Rounding someone's amount without telling them is how a transfer sends
  // a different number than the one on screen.
  it("refuses precision finer than a lamport", () => {
    expect(() => parseSol("0.0000000001")).toThrow(/finer than one lamport/);
  });

  it("refuses a value that is not an amount", () => {
    expect(() => parseSol("abc")).toThrow(SolanaRpcError);
    expect(() => parseSol("")).toThrow(SolanaRpcError);
  });
});

describe("getSolanaBalance", () => {
  it("reads lamports and formats them", async () => {
    rpcReturning(
      { result: { value: 2_500_000_000 } },
      { result: { value: { lamports: 2_500_000_000 } } },
    );
    const balance = await getSolanaBalance("https://rpc.test", "Addr");
    expect(balance.lamports).toBe(2_500_000_000n);
    expect(balance.sol).toBe("2.5");
    expect(balance.exists).toBe(true);
  });

  // An address that has never been funded answers zero, exactly like an
  // account that was emptied. They are not the same thing.
  it("separates an empty account from one that does not exist", async () => {
    rpcReturning({ result: { value: 0 } }, { result: { value: null } });
    const missing = await getSolanaBalance("https://rpc.test", "Addr");
    expect(missing.lamports).toBe(0n);
    expect(missing.exists).toBe(false);

    rpcReturning({ result: { value: 0 } }, { result: { value: {} } });
    const emptied = await getSolanaBalance("https://rpc.test", "Addr");
    expect(emptied.exists).toBe(true);
  });

  it("surfaces an RPC error instead of reporting zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ error: { message: "Invalid param", code: -32602 } }),
      })),
    );
    await expect(getSolanaBalance("https://rpc.test", "bad")).rejects.toThrow(
      /Invalid param/,
    );
  });

  it("surfaces a transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    await expect(getSolanaBalance("https://rpc.test", "Addr")).rejects.toThrow(
      /HTTP 503/,
    );
  });
});

describe("getSignatureStatus", () => {
  it("reports a confirmed signature", async () => {
    rpcReturning({ result: { value: [{ confirmationStatus: "finalized" }] } });
    const s = await getSignatureStatus("https://rpc.test", "sig");
    expect(s).toEqual({ status: "finalized", error: null });
  });

  it("reports an on-chain failure with its reason", async () => {
    rpcReturning({
      result: { value: [{ err: { InstructionError: [0, "Custom"] } }] },
    });
    const s = await getSignatureStatus("https://rpc.test", "sig");
    expect(s.status).toBe("failed");
    expect(s.error).toContain("InstructionError");
  });

  // A signature the node has no record of may never have landed, or may have
  // aged out of its cache. Calling that "failed" tells a user their transfer
  // did not happen when it may well have.
  it("does not call an unknown signature a failure", async () => {
    rpcReturning({ result: { value: [null] } });
    const s = await getSignatureStatus("https://rpc.test", "sig");
    expect(s.status).toBe("unknown");
    expect(s.error).toBeNull();
  });
});

describe("framework boundary", () => {
  it("imports nothing from a framework", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(
      new URL("../solana-rpc.ts", import.meta.url),
      "utf8",
    );
    // The point of this file living in core/ is that a Vue or native binding
    // can use it unchanged. A React import would quietly undo that.
    expect(source).not.toMatch(/from "react"/);
    expect(source).not.toMatch(/from "vue"/);
  });
});

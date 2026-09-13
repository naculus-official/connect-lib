import { describe, expect, it, vi } from "vitest";
import {
  parseChainIdNumber,
  simulateERC20Transfer,
  simulateTransaction,
  type WalletSimContext,
} from "./wallet-simulation";

/**
 * Pre-signature simulation, previously 16.7% covered. The paths that matter
 * are the refusals: no wallet, no configured simulator, and a chain id that
 * cannot be represented as a JS number. Each of those must throw rather than
 * return a result the caller would read as "this transaction is fine".
 */

const ADDR = `0x${"11".repeat(20)}` as `0x${string}`;
const TOKEN = `0x${"22".repeat(20)}` as `0x${string}`;
const ok = { status: "success", provider: "eth_call" } as never;

const ctx = (over: Partial<WalletSimContext> = {}): WalletSimContext => ({
  address: ADDR,
  simManager: null,
  chainId: "eip155:1",
  ...over,
});

describe("parseChainIdNumber", () => {
  it.each([
    ["eip155:1", 1],
    ["eip155:137", 137],
    ["eip155:11155111", 11155111],
  ])("parses %s", (input, expected) => {
    expect(parseChainIdNumber(input)).toBe(expected);
  });

  it.each([
    "eip155:0",
    "eip155:01",
    "eip155:-1",
    "eip155:abc",
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "1",
    "",
  ])("rejects %p", (bad) => {
    expect(() => parseChainIdNumber(bad)).toThrow();
  });

  it("rejects a chain id beyond Number.MAX_SAFE_INTEGER", () => {
    // Silently rounding here would simulate against a different chain.
    expect(() => parseChainIdNumber("eip155:9007199254740993")).toThrow();
  });
});

describe("simulateTransaction", () => {
  const tx = { to: TOKEN, data: "0x", value: "0x0" };

  it("refuses when no wallet is loaded", async () => {
    await expect(
      simulateTransaction(ctx({ address: null }), tx),
    ).rejects.toThrow(/No wallet loaded/);
  });

  it("refuses when neither a manager nor a custom simulator is configured", async () => {
    // Returning a fake "success" here would put an unchecked transaction in
    // front of the user with a green light.
    await expect(simulateTransaction(ctx(), tx)).rejects.toThrow(
      /not configured/,
    );
  });

  it("prefers the SimulationManager and forwards the resolved chain id", async () => {
    const simulateTx = vi.fn(async () => ok);
    await simulateTransaction(
      ctx({
        simManager: { simulateTransaction: simulateTx } as never,
        rpcUrl: "https://rpc",
      }),
      tx,
    );
    expect(simulateTx).toHaveBeenCalledWith(
      tx,
      ADDR,
      expect.objectContaining({ chainId: 1, rpcUrl: "https://rpc" }),
    );
  });

  it("lets an explicit option override the session chain id", async () => {
    const simulateTx = vi.fn(async () => ok);
    await simulateTransaction(
      ctx({ simManager: { simulateTransaction: simulateTx } as never }),
      tx,
      { chainId: 137 },
    );
    expect(simulateTx).toHaveBeenCalledWith(
      tx,
      ADDR,
      expect.objectContaining({ chainId: 137 }),
    );
  });

  it("falls back to a custom simulator when no manager exists", async () => {
    const custom = vi.fn(async () => ok);
    await simulateTransaction(ctx({ customSimulate: custom }), tx);
    expect(custom).toHaveBeenCalled();
  });
});

describe("simulateERC20Transfer", () => {
  it("refuses when no wallet is loaded", async () => {
    await expect(
      simulateERC20Transfer(ctx({ address: null }), TOKEN, ADDR, "1"),
    ).rejects.toThrow(/No wallet loaded/);
  });

  it("refuses without a SimulationManager rather than using customSimulate", async () => {
    // customSimulate takes a raw tx; it cannot build ERC-20 calldata, so
    // silently routing there would simulate the wrong thing.
    await expect(
      simulateERC20Transfer(
        ctx({ customSimulate: vi.fn(async () => ok) }),
        TOKEN,
        ADDR,
        "1",
      ),
    ).rejects.toThrow(/SimulationManager not initialized/);
  });

  it("passes token, parties, chain and decimals through", async () => {
    const simulateErc20 = vi.fn(async () => ok);
    await simulateERC20Transfer(
      ctx({ simManager: { simulateERC20Transfer: simulateErc20 } as never }),
      TOKEN,
      ADDR,
      "1000000",
      { decimals: 6 },
    );
    expect(simulateErc20).toHaveBeenCalledWith(
      TOKEN,
      ADDR,
      ADDR,
      "1000000",
      1,
      6,
    );
  });
});

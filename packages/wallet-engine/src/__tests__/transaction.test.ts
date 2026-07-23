import { describe, it, expect } from "vitest";
import { buildTransaction, cloneForBumping, resolveChainId } from "../transaction";
import type { TransactionRequest } from "../signers/types";
import type { ResolvedFeeOptions } from "../fee-oracle";

// ── buildTransaction tests ────────────────────────────────────────

describe("buildTransaction", () => {
  const baseTx: TransactionRequest = {
    to: "0x" + "ab".repeat(20),
    value: "0xde0b6b3a7640000",
    data: "0x",
    gas: "0x5208",
    nonce: "0x5",
    chainId: 1,
  };

  it("applies EIP-1559 fees and clears gasPrice", () => {
    const fees: ResolvedFeeOptions = {
      type: "eip1559",
      maxFeePerGas: "0x59682f00",
      maxPriorityFeePerGas: "0x3b9aca00",
    };
    const tx = buildTransaction(baseTx, fees);

    expect(tx.maxFeePerGas).toBe("0x59682f00");
    expect(tx.maxPriorityFeePerGas).toBe("0x3b9aca00");
    expect(tx.gasPrice).toBeUndefined();
    expect(tx.to).toBe(baseTx.to);
    expect(tx.value).toBe(baseTx.value);
    expect(tx.nonce).toBe(baseTx.nonce);
  });

  it("applies Legacy fees and clears EIP-1559 fields", () => {
    const fees: ResolvedFeeOptions = {
      type: "legacy",
      gasPrice: "0x4a817c800",
    };
    const tx = buildTransaction(baseTx, fees);

    expect(tx.gasPrice).toBe("0x4a817c800");
    expect(tx.maxFeePerGas).toBeUndefined();
    expect(tx.maxPriorityFeePerGas).toBeUndefined();
  });

  it("preserves undefined fee fields when applying EIP-1559", () => {
    // baseTx has no gasPrice, only EIP-1559 set
    const eip1559Tx: TransactionRequest = { ...baseTx };
    const fees: ResolvedFeeOptions = {
      type: "eip1559",
      maxFeePerGas: "0x100",
      maxPriorityFeePerGas: "0x50",
    };
    const tx = buildTransaction(eip1559Tx, fees);
    expect(tx.gasPrice).toBeUndefined();
    expect(tx.maxFeePerGas).toBe("0x100");
  });

  it("handles minimal tx (to only)", () => {
    const fees: ResolvedFeeOptions = { type: "legacy", gasPrice: "0x100" };
    const tx = buildTransaction({ to: "0xabcd" }, fees);
    expect(tx.to).toBe("0xabcd");
    expect(tx.gasPrice).toBe("0x100");
    expect(tx.chainId).toBeUndefined(); // not in original
  });
});

// ── cloneForBumping tests ─────────────────────────────────────────

describe("cloneForBumping", () => {
  it("clones basic tx fields without fee fields", () => {
    const tx: TransactionRequest = {
      to: "0xabcd",
      value: "0x100",
      data: "0xdeadbeef",
      gas: "0x5208",
      nonce: "0x5",
      chainId: 1,
      maxFeePerGas: "0x59682f00",
      maxPriorityFeePerGas: "0x3b9aca00",
    };
    const clone = cloneForBumping(tx);
    expect(clone.to).toBe("0xabcd");
    expect(clone.value).toBe("0x100");
    expect(clone.data).toBe("0xdeadbeef");
    expect(clone.gas).toBe("0x5208");
    expect(clone.nonce).toBe("0x5");
    expect(clone.chainId).toBe(1);
    // Fee fields should NOT be copied
    expect(clone.maxFeePerGas).toBeUndefined();
    expect(clone.maxPriorityFeePerGas).toBeUndefined();
    expect(clone.gasPrice).toBeUndefined();
  });

  it("does not modify the original", () => {
    const tx: TransactionRequest = { to: "0xabcd", maxFeePerGas: "0x100" };
    const clone = cloneForBumping(tx);
    expect(tx.maxFeePerGas).toBe("0x100");
    expect(clone.maxFeePerGas).toBeUndefined();
  });
});

// ── resolveChainId tests ──────────────────────────────────────────

describe("resolveChainId", () => {
  it("uses tx.chainId if present", () => {
    expect(resolveChainId({ to: "0xabcd", chainId: 137 }, "eip155:1")).toBe(137);
  });

  it("parses from CAIP-2 chainId when tx.chainId is undefined", () => {
    expect(resolveChainId({ to: "0xabcd" }, "eip155:137")).toBe(137);
  });

  it("parses mainnet from CAIP-2", () => {
    expect(resolveChainId({ to: "0xabcd" }, "eip155:1")).toBe(1);
  });
});

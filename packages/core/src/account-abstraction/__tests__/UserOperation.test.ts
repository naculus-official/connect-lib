/**
 * Tests for UserOperation building, hashing, gas estimation, and error handling.
 *
 * Tests are unit-level and do not depend on RPC endpoints.
 * Integration tests that require bundler/chain access are conditionally skipped.
 */

import { ADDRESSES } from "@naculus/test-utils/test-constants";

import { describe, it, expect, vi } from "vitest";
import {
  buildUserOperation,
  buildCallData,
  hashUserOperation,
  signUserOperation,
  sendUserOperation,
  estimateUserOperationGas,
  encodeGasLimits,
} from "../user-operation";
import {
  type UserOperation,
  type Address,
  type Hex,
  type Call,
  DEFAULT_CALL_GAS_LIMIT,
  DEFAULT_VERIFICATION_GAS_LIMIT,
  DEFAULT_PRE_VERIFICATION_GAS,
  ENTRY_POINT_V0_7,
} from "../types";
import {
  AccountAbstractionError,
} from "../errors";

// ─── Fixtures ──────────────────────────────────────────────────────────

const TEST_SENDER = "0x1234567890123456789012345678901234567890" as Address;
const TEST_ENTRY_POINT = ENTRY_POINT_V0_7;
const TEST_CHAIN_ID = 11155111; // Sepolia
const TEST_TO = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as Address;

const MOCK_SIGNER = vi.fn(async (_hash: Hex): Promise<Hex> => {
  return "0x" + "ab".repeat(65) as Hex; // 65-byte signature (r+s+v)
});

// ─── buildUserOperation ────────────────────────────────────────────────

describe("buildUserOperation", () => {
  it("fills in defaults for missing fields", () => {
    const userOp = buildUserOperation({ sender: TEST_SENDER });
    expect(userOp.sender).toBe(TEST_SENDER);
    expect(userOp.nonce).toBe(0n);
    expect(userOp.initCode).toBe("0x");
    expect(userOp.callData).toBe("0x");
    expect(userOp.preVerificationGas).toBe(DEFAULT_PRE_VERIFICATION_GAS);
    expect(userOp.maxFeePerGas).toBe(0n);
    expect(userOp.maxPriorityFeePerGas).toBe(0n);
    expect(userOp.paymasterAndData).toBe("0x");
    expect(userOp.signature).toBe("0x");
  });

  it("preserves provided values", () => {
    const userOp = buildUserOperation({
      sender: TEST_SENDER,
      nonce: 42n,
      preVerificationGas: 100_000n,
      maxFeePerGas: 50_000_000_000n,
    });
    expect(userOp.sender).toBe(TEST_SENDER);
    expect(userOp.nonce).toBe(42n);
    expect(userOp.preVerificationGas).toBe(100_000n);
    expect(userOp.maxFeePerGas).toBe(50_000_000_000n);
  });

  it("sets accountGasLimits to defaults when not provided", () => {
    const userOp = buildUserOperation({ sender: TEST_SENDER });
    expect(userOp.accountGasLimits).toBeTruthy();
    expect(userOp.accountGasLimits).not.toBe("0x");
    expect(userOp.accountGasLimits.length).toBe(66); // 0x + 64 hex chars
  });
});

// ─── buildCallData ─────────────────────────────────────────────────────

describe("buildCallData", () => {
  it("throws for empty calls", () => {
    expect(() => buildCallData([])).toThrow(AccountAbstractionError);
    expect(() => buildCallData([])).toThrow("At least one call");
  });

  it("returns execute calldata for a single call", () => {
    const calls: Call[] = [
      { to: TEST_TO, value: 0n, data: "0x" as Hex },
    ];
    const callData = buildCallData(calls);
    expect(callData).toMatch(/^0x/);
    // Should contain execute selector (b61d27f6)
    expect(callData.includes("b61d27f6")).toBe(true);
  });

  it("returns executeBatch calldata for multiple calls", () => {
    const calls: Call[] = [
      { to: TEST_TO, value: 0n, data: "0xdeadbeef" as Hex },
      { to: "0x1111111111111111111111111111111111111111" as Address, value: 100n, data: "0x" as Hex },
    ];
    const callData = buildCallData(calls);
    expect(callData).toMatch(/^0x/);
    // Should contain executeBatch selector (47e1da2a)
    expect(callData.includes("47e1da2a")).toBe(true);
  });

  it("produces valid hex output", () => {
    const calls: Call[] = [
      { to: TEST_TO, value: 0n, data: "0x" as Hex },
    ];
    const callData = buildCallData(calls);
    // Remove 0x prefix and verify hex
    const hex = callData.slice(2);
    expect(/^[0-9a-f]*$/.test(hex)).toBe(true);
  });
});

// ─── hashUserOperation ─────────────────────────────────────────────────

describe("hashUserOperation", () => {
  it("produces a non-zero hash", async () => {
    const userOp = buildUserOperation({ sender: TEST_SENDER });
    const hash = await hashUserOperation(userOp, TEST_ENTRY_POINT, TEST_CHAIN_ID);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hash).not.toBe("0x" + "0".repeat(64));
  });

  it("produces different hashes for different senders", async () => {
    const userOp1 = buildUserOperation({ sender: TEST_SENDER });
    const userOp2 = buildUserOperation({ sender: "0x2222222222222222222222222222222222222222" as Address });

    const hash1 = await hashUserOperation(userOp1, TEST_ENTRY_POINT, TEST_CHAIN_ID);
    const hash2 = await hashUserOperation(userOp2, TEST_ENTRY_POINT, TEST_CHAIN_ID);

    expect(hash1).not.toBe(hash2);
  });

  it("produces different hashes for different nonces", async () => {
    const userOp1 = buildUserOperation({ sender: TEST_SENDER, nonce: 1n });
    const userOp2 = buildUserOperation({ sender: TEST_SENDER, nonce: 2n });

    const hash1 = await hashUserOperation(userOp1, TEST_ENTRY_POINT, TEST_CHAIN_ID);
    const hash2 = await hashUserOperation(userOp2, TEST_ENTRY_POINT, TEST_CHAIN_ID);

    expect(hash1).not.toBe(hash2);
  });

  it("produces different hashes for different callData", async () => {
    const userOp1 = buildUserOperation({ sender: TEST_SENDER, callData: "0x01" as Hex });
    const userOp2 = buildUserOperation({ sender: TEST_SENDER, callData: "0x02" as Hex });

    const hash1 = await hashUserOperation(userOp1, TEST_ENTRY_POINT, TEST_CHAIN_ID);
    const hash2 = await hashUserOperation(userOp2, TEST_ENTRY_POINT, TEST_CHAIN_ID);

    expect(hash1).not.toBe(hash2);
  });

  it("is deterministic (same input = same hash)", async () => {
    const userOp = buildUserOperation({ sender: TEST_SENDER, nonce: 42n });
    const hash1 = await hashUserOperation(userOp, TEST_ENTRY_POINT, TEST_CHAIN_ID);
    const hash2 = await hashUserOperation(userOp, TEST_ENTRY_POINT, TEST_CHAIN_ID);
    expect(hash1).toBe(hash2);
  });
});

// ─── signUserOperation ─────────────────────────────────────────────────

describe("signUserOperation", () => {
  it("calls the signer function with a hash", async () => {
    const signer = vi.fn(async (_hash: Hex): Promise<Hex> => {
      return "0x" + "cd".repeat(65) as Hex;
    });

    const userOp = buildUserOperation({ sender: TEST_SENDER });
    const signed = await signUserOperation(userOp, signer, TEST_ENTRY_POINT, TEST_CHAIN_ID);

    expect(signer).toHaveBeenCalledTimes(1);
    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("sets the signature on the returned UserOperation", async () => {
    const userOp = buildUserOperation({ sender: TEST_SENDER });
    const signed = await signUserOperation(userOp, MOCK_SIGNER, TEST_ENTRY_POINT, TEST_CHAIN_ID);

    expect(signed.signature).not.toBe("0x");
    expect(signed.signature).toBeTruthy();
    expect(signed.sender).toBe(userOp.sender);
    expect(signed.nonce).toBe(userOp.nonce);
  });

  it("throws AAError when signer fails", async () => {
    const failingSigner = vi.fn(async (): Promise<Hex> => {
      throw new Error("signer failed");
    });

    const userOp = buildUserOperation({ sender: TEST_SENDER });
    await expect(
      signUserOperation(userOp, failingSigner, TEST_ENTRY_POINT, TEST_CHAIN_ID)
    ).rejects.toThrow(AccountAbstractionError);
  });
});

// ─── sendUserOperation ─────────────────────────────────────────────────

describe("sendUserOperation", () => {
  it("throws AAError when bundler URL is empty", async () => {
    const userOp = buildUserOperation({ sender: TEST_SENDER });
    await expect(sendUserOperation(userOp, "", TEST_ENTRY_POINT)).rejects.toThrow(AccountAbstractionError);
    await expect(sendUserOperation(userOp, "", TEST_ENTRY_POINT)).rejects.toHaveProperty("code", "aa_no_bundler");
  });

  it("handles bundler errors gracefully", async () => {
    const userOp = buildUserOperation({ sender: TEST_SENDER });
    // Invalid bundler URL should either throw or return a response with error
    await expect(sendUserOperation(userOp, "https://invalid.bundler/rpc", TEST_ENTRY_POINT)).rejects.toThrow();
  });
});

// ─── estimateUserOperationGas ──────────────────────────────────────────

describe("estimateUserOperationGas", () => {
  it("throws AAError when bundler URL is empty", async () => {
    const userOp = buildUserOperation({ sender: TEST_SENDER });
    await expect(estimateUserOperationGas(userOp, TEST_ENTRY_POINT, "")).rejects.toThrow(AccountAbstractionError);
    await expect(estimateUserOperationGas(userOp, TEST_ENTRY_POINT, "")).rejects.toHaveProperty("code", "aa_no_bundler");
  });

  it("returns default values when bundler request fails", async () => {
    const userOp = buildUserOperation({ sender: TEST_SENDER });
    const estimate = await estimateUserOperationGas(userOp, TEST_ENTRY_POINT, "https://invalid.bundler/rpc");

    expect(estimate.callGasLimit).toBe(DEFAULT_CALL_GAS_LIMIT);
    expect(estimate.verificationGasLimit).toBe(DEFAULT_VERIFICATION_GAS_LIMIT);
    expect(estimate.preVerificationGas).toBe(DEFAULT_PRE_VERIFICATION_GAS);
  });
});

// ─── Edge Cases ────────────────────────────────────────────────────────

describe("UserOperation edge cases", () => {
  it("handles zero-valued calls", () => {
    const calls: Call[] = [
      { to: TEST_TO, value: 0n, data: "0x" as Hex },
    ];
    const callData = buildCallData(calls);
    expect(callData).toMatch(/^0x/);
  });

  it("handles calls with large values", () => {
    const calls: Call[] = [
      { to: TEST_TO, value: 10_000_000_000_000_000_000n, data: "0x" as Hex },
    ];
    const callData = buildCallData(calls);
    expect(callData).toMatch(/^0x/);
  });

  it("handles calls with long calldata", () => {
    const longData = "0x" + "ab".repeat(500) as Hex;
    const calls: Call[] = [
      { to: TEST_TO, value: 0n, data: longData },
    ];
    const callData = buildCallData(calls);
    expect(callData).toMatch(/^0x/);
  });

  it("handles batch of 5 calls", () => {
    const calls: Call[] = Array.from({ length: 5 }, (_, i) => ({
      to: `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
      value: BigInt(i * 100),
      data: "0x" as Hex,
    }));
    const callData = buildCallData(calls);
    expect(callData).toMatch(/^0x/);
    // Should use executeBatch
    expect(callData.includes("47e1da2a")).toBe(true);
  });

  it("hashUserOperation handles empty fields", async () => {
    const userOp = buildUserOperation({});
    const hash = await hashUserOperation(userOp, TEST_ENTRY_POINT, TEST_CHAIN_ID);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

// ─── encodeExecute ABI encoding ──────────────────────────────────────────

describe("encodeExecute — ABI data encoding", () => {
  it("short data (<256 bytes) has correct length in ABI encoding", () => {
    const data = "0xdeadbeef" as Hex;
    const callData = buildCallData([{ to: TEST_TO, value: 0n, data }]);
    const hex = callData.slice(2);
    // data length is the 5th word (selector 8B + to 64B + value 64B + offset 64B = 200B)
    const dataLenHex = hex.slice(200, 264);
    expect(parseInt(dataLenHex, 16)).toBe(4); // "deadbeef" = 4 bytes
    // raw data follows at offset 264, padded to 32 bytes
    expect(hex.slice(264, 272)).toBe("deadbeef");
  });

  it("long data (>255 bytes) does not truncate", () => {
    const longData = ("0x" + "ab".repeat(256)) as Hex;
    const callData = buildCallData([{ to: TEST_TO, value: 0n, data: longData }]);
    const hex = callData.slice(2);
    const dataLenHex = hex.slice(200, 264);
    expect(parseInt(dataLenHex, 16)).toBe(256);
    expect(hex.slice(264)).toBe("ab".repeat(256));
  });
});

// ─── encodeExecuteBatch ────────────────────────────────────────────────

describe("encodeExecuteBatch", () => {
  it("throws for 0 calls", () => {
    expect(() => buildCallData([])).toThrow(AccountAbstractionError);
  });

  it("encodes multiple calls with executeBatch selector", () => {
    const calls: Call[] = [
      { to: TEST_TO, value: 0n, data: "0x" as Hex },
      { to: "0x1111111111111111111111111111111111111111" as Address, value: 100n, data: "0xdeadbeef" as Hex },
    ];
    const callData = buildCallData(calls);
    expect(callData.includes("47e1da2a")).toBe(true);
    expect(callData.includes("deadbeef")).toBe(true);
    // Value 100 in hex = 0x64, padded to 32 bytes
    expect(callData.includes("0000000000000000000000000000000000000000000000000000000000000064")).toBe(true);
  });

  it("encodes batch with 3 calls", () => {
    const calls: Call[] = [
      { to: TEST_TO, value: 0n, data: "0x" as Hex },
      { to: "0x1111111111111111111111111111111111111111" as Address, value: 100n, data: "0xdeadbeef" as Hex },
      { to: "0x2222222222222222222222222222222222222222" as Address, value: 200n, data: "0x" as Hex },
    ];
    const callData = buildCallData(calls);
    expect(callData.includes("47e1da2a")).toBe(true);
    // Array length should be 3
    const hex = callData.slice(2);
    const toArrayLen = parseInt(hex.slice(200, 264), 16);
    expect(toArrayLen).toBe(3);
  });
});

// ─── hashUserOperation — EIP-712 compliance ─────────────────────────────

describe("hashUserOperation — EIP-712 compliance", () => {
  it("produces deterministic 32-byte hash for standard values", async () => {
    const userOp = buildUserOperation({ sender: TEST_SENDER, nonce: 1n, callData: "0x01" as Hex });
    const hash = await hashUserOperation(userOp, TEST_ENTRY_POINT, TEST_CHAIN_ID);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);

    const hash2 = await hashUserOperation(userOp, TEST_ENTRY_POINT, TEST_CHAIN_ID);
    expect(hash).toBe(hash2);
  });

  it("handles all zero/empty field values without throwing", async () => {
    const userOp: UserOperation = {
      sender: ADDRESSES.ZERO as Address,
      nonce: 0n,
      initCode: "0x" as Hex,
      callData: "0x" as Hex,
      accountGasLimits: ("0x" + "0".repeat(64)) as Hex,
      preVerificationGas: 0n,
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
      paymasterAndData: "0x" as Hex,
      signature: "0x" as Hex,
    };
    const hash = await hashUserOperation(userOp, TEST_ENTRY_POINT, TEST_CHAIN_ID);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("differs when entry point address changes (domain separator dependency)", async () => {
    const userOp = buildUserOperation({ sender: TEST_SENDER, nonce: 42n });
    const ep1 = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789" as Address;
    const ep2 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
    const hash1 = await hashUserOperation(userOp, ep1, TEST_CHAIN_ID);
    const hash2 = await hashUserOperation(userOp, ep2, TEST_CHAIN_ID);
    expect(hash1).not.toBe(hash2);
  });

  it("differs when chain ID changes", async () => {
    const userOp = buildUserOperation({ sender: TEST_SENDER, nonce: 42n });
    const hash1 = await hashUserOperation(userOp, TEST_ENTRY_POINT, 1);
    const hash2 = await hashUserOperation(userOp, TEST_ENTRY_POINT, 137);
    expect(hash1).not.toBe(hash2);
  });
});

// ─── BigInt hex rejection ───────────────────────────────────────────────

describe("parseInt with rejection on invalid hex", () => {
  it("BigInt rejects truly invalid hex strings", () => {
    expect(() => BigInt("0xGG")).toThrow();
    expect(() => BigInt("xyz")).toThrow();
  });

  it("BigInt accepts valid hex and decimal strings", () => {
    expect(() => BigInt("0xff")).not.toThrow();
    expect(() => BigInt("255")).not.toThrow();
    expect(() => BigInt("0x0")).not.toThrow();
  });

  it("encodeGasLimits with large bigints produces valid hex", () => {
    const encoded = encodeGasLimits(BigInt("0xFFFFFFFFFFFFFFFF"), BigInt("0xAAAAAAAAAAAAAAAA"));
    expect(encoded).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

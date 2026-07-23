import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  shouldUseEIP1559,
  validateFeeParams,
  applyMultiplier,
} from "../fee-oracle";
import type { ResolvedFeeOptions } from "../fee-oracle";
import { WalletError } from "../errors";

// ── shouldUseEIP1559 tests ─────────────────────────────────────────

describe("shouldUseEIP1559", () => {
  it("returns true when tx.type is 'eip1559'", () => {
    expect(shouldUseEIP1559({ type: "eip1559" })).toBe(true);
  });

  it("returns false when tx.type is 'legacy'", () => {
    expect(shouldUseEIP1559({ type: "legacy" })).toBe(false);
  });

  it("returns true when maxFeePerGas is present (even with gasPrice)", () => {
    expect(shouldUseEIP1559({ maxFeePerGas: "0x100", gasPrice: "0x100" })).toBe(true);
  });

  it("returns true when maxPriorityFeePerGas is present", () => {
    expect(shouldUseEIP1559({ maxPriorityFeePerGas: "0x100" })).toBe(true);
  });

  it("returns false when only gasPrice is present", () => {
    expect(shouldUseEIP1559({ gasPrice: "0x100" })).toBe(false);
  });

  it("returns true when no fee fields are present (auto-detect)", () => {
    expect(shouldUseEIP1559({})).toBe(true);
  });
});

// ── validateFeeParams tests ───────────────────────────────────────

describe("validateFeeParams", () => {
  describe("EIP-1559 fees", () => {
    it("passes validation for valid EIP-1559 fees", () => {
      const fees: ResolvedFeeOptions = {
        type: "eip1559",
        maxFeePerGas: "0x59682f00",     // 1.5 gwei
        maxPriorityFeePerGas: "0x3b9aca00", // 1 gwei
      };
      expect(() => validateFeeParams(fees)).not.toThrow();
    });

    it("throws when maxFeePerGas is zero", () => {
      const fees: ResolvedFeeOptions = {
        type: "eip1559",
        maxFeePerGas: "0x0",
        maxPriorityFeePerGas: "0x3b9aca00",
      };
      expect(() => validateFeeParams(fees)).toThrow(WalletError);
      expect(() => validateFeeParams(fees)).toThrow("maxFeePerGas must be greater than zero");
    });

    it("throws when maxPriorityFeePerGas is zero", () => {
      const fees: ResolvedFeeOptions = {
        type: "eip1559",
        maxFeePerGas: "0x59682f00",
        maxPriorityFeePerGas: "0x0",
      };
      expect(() => validateFeeParams(fees)).toThrow(WalletError);
      expect(() => validateFeeParams(fees)).toThrow("maxPriorityFeePerGas must be greater than zero");
    });

    it("throws when maxFeePerGas < maxPriorityFeePerGas", () => {
      const fees: ResolvedFeeOptions = {
        type: "eip1559",
        maxFeePerGas: "0x3b9aca00",     // 1 gwei
        maxPriorityFeePerGas: "0x59682f00", // 1.5 gwei
      };
      expect(() => validateFeeParams(fees)).toThrow(WalletError);
      expect(() => validateFeeParams(fees)).toThrow("maxFeePerGas must be greater than or equal to maxPriorityFeePerGas");
    });

    it("throws when maxFeePerGas equals maxPriorityFeePerGas (edge: allowed)", () => {
      const fees: ResolvedFeeOptions = {
        type: "eip1559",
        maxFeePerGas: "0x3b9aca00",
        maxPriorityFeePerGas: "0x3b9aca00",
      };
      // equal is allowed (maxFee >= maxPriority)
      expect(() => validateFeeParams(fees)).not.toThrow();
    });
  });

  describe("Legacy fees", () => {
    it("passes validation for valid gasPrice", () => {
      const fees: ResolvedFeeOptions = {
        type: "legacy",
        gasPrice: "0x4a817c800", // 20 gwei
      };
      expect(() => validateFeeParams(fees)).not.toThrow();
    });

    it("throws when gasPrice is zero", () => {
      const fees: ResolvedFeeOptions = {
        type: "legacy",
        gasPrice: "0x0",
      };
      expect(() => validateFeeParams(fees)).toThrow(WalletError);
      expect(() => validateFeeParams(fees)).toThrow("gasPrice must be greater than zero");
    });
  });
});

// ── applyMultiplier tests ─────────────────────────────────────────

describe("applyMultiplier", () => {
  it("increases value by 10% with 1.1 multiplier", () => {
    const result = applyMultiplier("0x100", 1.1);
    // 0x100 = 256, 256 * 110 / 100 = 281 = 0x119 (integer division)
    expect(result).toBe("0x119");
  });

  it("keeps value same with 1.0 multiplier", () => {
    const result = applyMultiplier("0x100", 1.0);
    expect(result).toBe("0x100");
  });

  it("doubles value with 2.0 multiplier", () => {
    const result = applyMultiplier("0x100", 2.0);
    expect(result).toBe("0x200");
  });

  it("handles large hex values", () => {
    const result = applyMultiplier("0x59682f00", 1.5);
    expect(BigInt(result)).toBe(BigInt("0x59682f00") * 150n / 100n);
  });

  it("works with 0x0 as input (outcome is 0x0)", () => {
    const result = applyMultiplier("0x0", 2.0);
    expect(result).toBe("0x0");
  });
});

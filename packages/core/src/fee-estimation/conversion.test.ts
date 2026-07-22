/**
 * Conversion utility tests — focuses on edge cases in string/bigint
 * arithmetic used for fee values, exchange rates, and display formatting.
 *
 * @see SRS-001 §6.3
 */

import { describe, expect, it } from "vitest";
import { parseBigInt, toDecString, toHumanReadable } from "./conversion";

// ─── parseBigInt ───────────────────────────────────────────────────────

describe("parseBigInt", () => {
  it("should parse a valid decimal string", () => {
    expect(parseBigInt("15000000000")).toBe(15000000000n);
  });

  it("should parse zero", () => {
    expect(parseBigInt("0")).toBe(0n);
  });

  it("should accept hex string (BigInt supports hex)", () => {
    // BigInt() accepts hex and negative strings natively
    expect(parseBigInt("0x1")).toBe(1n);
  });

  it("should accept negative number string (BigInt supports negatives)", () => {
    expect(parseBigInt("-1")).toBe(-1n);
  });

  it("should accept negative zero (equivalent to 0)", () => {
    expect(parseBigInt("-0")).toBe(0n);
  });
});

// ─── toDecString ───────────────────────────────────────────────────────

describe("toDecString", () => {
  it("should convert zero to string", () => {
    expect(toDecString(0n)).toBe("0");
  });

  it("should convert positive bigint", () => {
    expect(toDecString(15000000000n)).toBe("15000000000");
  });

  it("should convert very large bigint", () => {
    expect(toDecString(2n ** 128n)).toBe(
      "340282366920938463463374607431768211456",
    );
  });

  it("should convert negative bigint", () => {
    expect(toDecString(-15000000000n)).toBe("-15000000000");
  });

  it("should convert max bigint (approx)", () => {
    const maxUint256 = (1n << 256n) - 1n;
    const result = toDecString(maxUint256);
    expect(typeof result).toBe("string");
    expect(BigInt(result)).toBe(maxUint256);
  });
});

// ─── toHumanReadable ───────────────────────────────────────────────────

describe("toHumanReadable", () => {
  it("should format zero", () => {
    expect(toHumanReadable(0n)).toBe("0 gwei");
  });

  it("should format 1 wei with custom decimals", () => {
    // 1 wei = 0.000000001 gwei
    expect(toHumanReadable(1n)).toBe("0.000000001 gwei");
  });

  it("should format whole number with no remainder", () => {
    expect(toHumanReadable(25000000000n)).toBe("25 gwei");
  });

  it("should format with remainder trimmed", () => {
    expect(toHumanReadable(25100000000n)).toBe("25.1 gwei");
  });

  it("should format with ETH decimals", () => {
    expect(toHumanReadable(1000000000000000000n, 18, "ETH")).toBe("1 ETH");
  });

  it("should format 1 wei with ETH decimals", () => {
    const result = toHumanReadable(1n, 18, "ETH");
    expect(result).toBe("0.000000000000000001 ETH");
  });

  it("should handle max bigint value", () => {
    const maxBigInt = (1n << 256n) - 1n;
    const result = toHumanReadable(maxBigInt, 18, "ETH");
    expect(result).toContain("ETH");
    expect(typeof result).toBe("string");
  });

  it("should format normal gwei values", () => {
    expect(toHumanReadable(1_000_000_000n)).toBe("1 gwei");
    expect(toHumanReadable(15_000_000_000n)).toBe("15 gwei");
    expect(toHumanReadable(15_500_000_000n)).toBe("15.5 gwei");
  });
});

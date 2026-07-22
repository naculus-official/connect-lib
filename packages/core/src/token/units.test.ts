import { describe, expect, it } from "vitest";
import { ERC20TokenError } from "./errors";
import { formatUnits, parseUnits } from "./units";

describe("parseUnits", () => {
  it("should parse integer amount with 6 decimals (USDC)", () => {
    expect(parseUnits("1.5", 6)).toBe(1500000n);
    expect(parseUnits("0.01", 6)).toBe(10000n);
    expect(parseUnits("1", 6)).toBe(1000000n);
    expect(parseUnits("0", 6)).toBe(0n);
  });

  it("should parse integer amount with 18 decimals (DAI)", () => {
    expect(parseUnits("0.01", 18)).toBe(10000000000000000n);
    expect(parseUnits("1", 18)).toBe(1000000000000000000n);
    expect(parseUnits("100", 18)).toBe(100000000000000000000n);
  });

  it("should handle 0 decimals", () => {
    expect(parseUnits("100", 0)).toBe(100n);
    expect(parseUnits("0", 0)).toBe(0n);
  });

  it("should handle bigint input directly", () => {
    expect(parseUnits(1500000n, 6)).toBe(1500000n);
    expect(parseUnits(0n, 18)).toBe(0n);
  });

  it("should handle number input", () => {
    expect(parseUnits(1.5, 6)).toBe(1500000n);
    expect(parseUnits(100, 0)).toBe(100n);
  });

  it("should strip leading zeros", () => {
    expect(parseUnits("001.5", 6)).toBe(1500000n);
    expect(parseUnits("0.5", 6)).toBe(500000n);
  });

  it("should handle very large amounts", () => {
    const result = parseUnits("1000000", 18);
    expect(result).toBe(1000000000000000000000000n);
  });

  it("should throw on too many decimal places", () => {
    expect(() => parseUnits("1.1234567", 6)).toThrow(ERC20TokenError);
    expect(() => parseUnits("1.1234567", 6)).toThrow("has 7 decimal places");
  });

  it("should throw on NaN-like string", () => {
    expect(() => parseUnits("", 6)).toThrow(ERC20TokenError);
    expect(() => parseUnits(".", 6)).toThrow(ERC20TokenError);
    expect(() => parseUnits("abc", 6)).toThrow(ERC20TokenError);
  });

  it("should throw on negative amount", () => {
    expect(() => parseUnits("-1.5", 6)).toThrow(ERC20TokenError);
    expect(() => parseUnits("-100", 0)).toThrow(ERC20TokenError);
  });

  it("should throw on non-integer decimals", () => {
    expect(() => parseUnits("1", 6.5)).toThrow(ERC20TokenError);
    expect(() => parseUnits("1", -1)).toThrow(ERC20TokenError);
  });

  it("should throw on invalid number input", () => {
    expect(() => parseUnits(NaN, 6)).toThrow(ERC20TokenError);
    expect(() => parseUnits(Infinity, 6)).toThrow(ERC20TokenError);
  });

  it("should handle whole number string representation", () => {
    expect(parseUnits("100", 18)).toBe(100000000000000000000n);
  });

  it("should handle amount with leading and trailing spaces", () => {
    expect(parseUnits("  1.5  ", 6)).toBe(1500000n);
  });
});

describe("formatUnits", () => {
  it("should format 6 decimal tokens (USDC)", () => {
    expect(formatUnits(1500000n, 6)).toBe("1.5");
    expect(formatUnits(1n, 6)).toBe("0.000001");
    expect(formatUnits(1000000n, 6)).toBe("1");
    expect(formatUnits(0n, 6)).toBe("0");
  });

  it("should format 18 decimal tokens (DAI)", () => {
    expect(formatUnits(10000000000000000n, 18)).toBe("0.01");
    expect(formatUnits(1000000000000000000n, 18)).toBe("1");
    expect(formatUnits(1n, 18)).toBe("0.000000000000000001");
  });

  it("should handle 0 decimals", () => {
    expect(formatUnits(100n, 0)).toBe("100");
    expect(formatUnits(0n, 0)).toBe("0");
  });

  it("should strip trailing zeros in fractional part", () => {
    expect(formatUnits(1500000n, 6)).toBe("1.5");
    expect(formatUnits(1001000n, 6)).toBe("1.001");
  });

  it("should handle zero value", () => {
    expect(formatUnits(0n, 18)).toBe("0");
    expect(formatUnits(0n, 6)).toBe("0");
  });

  it("should handle large values", () => {
    expect(formatUnits(1000000000000000000000000n, 18)).toBe("1000000");
  });

  it("should handle values less than 1", () => {
    expect(formatUnits(1n, 18)).toBe("0.000000000000000001");
    expect(formatUnits(100n, 6)).toBe("0.0001");
  });

  it("should throw on invalid decimals", () => {
    expect(() => formatUnits(100n, -1)).toThrow(ERC20TokenError);
    expect(() => formatUnits(100n, 1.5)).toThrow(ERC20TokenError);
  });

  it("should handle negative amounts (edge case)", () => {
    expect(formatUnits(-1000000n, 6)).toBe("-1");
  });
});

describe("parseUnits ↔ formatUnits round-trip", () => {
  it("should round-trip common values", () => {
    const testCases = [
      { value: "1.5", decimals: 6 },
      { value: "0.01", decimals: 6 },
      { value: "100", decimals: 18 },
      { value: "0.000001", decimals: 18 },
      { value: "1234.5678", decimals: 18 },
      { value: "0", decimals: 6 },
      { value: "1", decimals: 0 },
    ];

    for (const { value, decimals } of testCases) {
      const raw = parseUnits(value, decimals);
      const formatted = formatUnits(raw, decimals);
      expect(formatted).toBe(value);
    }
  });
});

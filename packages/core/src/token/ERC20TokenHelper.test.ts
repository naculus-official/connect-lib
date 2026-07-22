import { ADDRESSES } from "@naculus/test-utils/test-constants";
import { describe, expect, it } from "vitest";
import { abiEncodeAddress, abiEncodeUint256 } from "./ERC20TokenHelper";
import { ERC20TokenError } from "./errors";

describe("abiEncodeAddress", () => {
  it("should left-pad address to 32 bytes (64 hex chars)", () => {
    const addr = "0x1234567890123456789012345678901234567890" as `0x${string}`;
    const result = abiEncodeAddress(addr);
    expect(result).toBe(
      "0x0000000000000000000000001234567890123456789012345678901234567890",
    );
  });

  it("should handle zero address", () => {
    const addr = ADDRESSES.ZERO as `0x${string}`;
    const result = abiEncodeAddress(addr);
    expect(result).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("should throw on invalid address format", () => {
    expect(() => abiEncodeAddress("0xshort" as `0x${string}`)).toThrow(
      ERC20TokenError,
    );
    expect(() => abiEncodeAddress("0xGGGG..." as `0x${string}`)).toThrow(
      ERC20TokenError,
    );
    expect(() => abiEncodeAddress("invalid" as `0x${string}`)).toThrow(
      ERC20TokenError,
    );
  });
});

describe("abiEncodeUint256", () => {
  it("should left-pad small values to 32 bytes", () => {
    expect(abiEncodeUint256(1n)).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    );
  });

  it("should encode zero", () => {
    expect(abiEncodeUint256(0n)).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("should encode large values without truncating", () => {
    const result = abiEncodeUint256(2n ** 255n);
    // 2^255 = 0x8000...0000 (with 32 zeroes)
    expect(result.startsWith("0x80")).toBe(true);
    expect(result.length).toBe(66); // 0x + 64 hex chars
  });

  it("should encode MAX_UINT256", () => {
    const result = abiEncodeUint256(2n ** 256n - 1n);
    expect(result).toBe(
      "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    );
  });

  it("should throw on negative value", () => {
    expect(() => abiEncodeUint256(-1n)).toThrow(ERC20TokenError);
  });
});

describe("abiFunctionSelector (manual verification)", () => {
  it("should compute transfer selector correctly", async () => {
    const { abiFunctionSelector } = await import("./ERC20TokenHelper");
    const selector = await abiFunctionSelector("transfer(address,uint256)");
    // Known selector for transfer(address,uint256): 0xa9059cbb
    expect(selector).toBe("0xa9059cbb");
  });

  it("should compute approve selector correctly", async () => {
    const { abiFunctionSelector } = await import("./ERC20TokenHelper");
    const selector = await abiFunctionSelector("approve(address,uint256)");
    // Known selector for approve(address,uint256): 0x095ea7b3
    expect(selector).toBe("0x095ea7b3");
  });

  it("should compute transferFrom selector correctly", async () => {
    const { abiFunctionSelector } = await import("./ERC20TokenHelper");
    const selector = await abiFunctionSelector(
      "transferFrom(address,address,uint256)",
    );
    // Known selector: 0x23b872dd
    expect(selector).toBe("0x23b872dd");
  });

  it("should compute allowance selector correctly", async () => {
    const { abiFunctionSelector } = await import("./ERC20TokenHelper");
    const selector = await abiFunctionSelector("allowance(address,address)");
    // Known selector: 0xdd62ed3e
    expect(selector).toBe("0xdd62ed3e");
  });

  it("should compute decimals selector correctly", async () => {
    const { abiFunctionSelector } = await import("./ERC20TokenHelper");
    const selector = await abiFunctionSelector("decimals()");
    // Known selector: 0x313ce567
    expect(selector).toBe("0x313ce567");
  });
});

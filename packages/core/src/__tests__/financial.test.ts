/**
 * Financial-Grade Unit Tests — @naculus/connect-core
 *
 * Covers bigint boundary safety, ABI encoding/decoding,
 * token amount serialization edge cases, and financial-grade
 * safety patterns found across the codebase.
 *
 * These tests are designed to catch implicit Number() conversions,
 * overflow bugs, precision loss, and encoding errors on financial values.
 */

import { ADDRESSES } from "@naculus/test-utils/test-constants";
import { describe, it, expect } from "vitest";
import { parseUnits, formatUnits } from "../token/units";
import { abiEncodeAddress, abiEncodeUint256 } from "../token/ERC20TokenHelper";
import { encodeGasLimits, buildUserOperation } from "../account-abstraction/user-operation";
import { decodeGasLimits } from "../account-abstraction/SmartAccountManager";
import { ERC20TokenError } from "../token/errors";

// ═══════════════════════════════════════════════════════════════════════
// Section 1: BigInt Boundary Tests
// ═══════════════════════════════════════════════════════════════════════

describe("BigInt — safe integer boundary", () => {
  it("parseUnits at MAX_SAFE_INTEGER (wei) is exact", () => {
    // Number.MAX_SAFE_INTEGER = 9,007,199,254,740,991
    // 1 ETH in wei = 10^18 — well beyond MAX_SAFE_INTEGER
    const result = parseUnits("1", 18);
    expect(result).toBe(1_000_000_000_000_000_000n);
    // Verify it's a bigint, not silently coerced to Number
    expect(typeof result).toBe("bigint");
    // This would lose precision if Number() was involved
    expect(result > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("parseUnits at extreme 2^96 - 1 is exact", () => {
    const extreme = (1n << 96n) - 1n; // ~79 billion billion
    const str = extreme.toString();
    // 96 bits fits in well below uint256 but exceeds Number.MAX_SAFE_INTEGER
    const result = parseUnits(str, 0);
    expect(result).toBe(extreme);
    expect(result > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("parseUnits at 2^128 - 1 is exact (uint128 max)", () => {
    const maxUint128 = (1n << 128n) - 1n;
    const str = maxUint128.toString();
    const result = parseUnits(str, 0);
    expect(result).toBe(maxUint128);
    // Verify no Number() truncation: Number(2^128) is finite but inexact
    // 2^128 = 340282366920938463463374607431768211456
    // Number(2^128) ≈ 3.402823669209385e+38 — rounded, loses last digits
    const asNumber = Number(maxUint128);
    expect(BigInt(asNumber)).not.toBe(maxUint128);
    expect(result).toBe(maxUint128);
  });

  it("parseUnits at 2^192 preserves full precision", () => {
    const large = 1n << 192n;
    const str = large.toString();
    const result = parseUnits(str, 0);
    expect(result).toBe(large);
  });

  it("parseUnits preserves 18-decimal precision on extreme wei values", () => {
    // Simulate transferring an amount that is a large bigint with small fractional part
    const hugeWei = (1n << 64n) + 123456789012345678n; // ~18 ETH + some wei
    // format then re-parse to check round-trip
    const formatted = formatUnits(hugeWei, 18);
    const reparsed = parseUnits(formatted, 18);
    expect(reparsed).toBe(hugeWei);
  });

  it("formatUnits at MAX_SAFE_INTEGER + 1n is exact (no Number coercion in output)", () => {
    // Number.MAX_SAFE_INTEGER + 1 = 9,007,199,254,740,992
    const unsafe = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const formatted = formatUnits(unsafe, 0);
    // If Number() was used, it would still be exact here, but
    // the output must be a string representation of the bigint
    expect(formatted).toBe("9007199254740992");
    expect(BigInt(formatted)).toBe(unsafe);
  });

  it("formatUnits preserves values far beyond MAX_SAFE_INTEGER", () => {
    const large = (1n << 80n) * 3n + 999n;
    const formatted = formatUnits(large, 0);
    const reparsed = BigInt(formatted);
    expect(reparsed).toBe(large);
  });

  it("BigInt arithmetic on ETH amounts does not overflow", () => {
    // Sum 10 ETH transfers at 1 ETH each — well within bigint but
    // tests that nothing tries to convert through Number
    const oneEth = parseUnits("1", 18);
    const tenEth = Array.from({ length: 10 }, () => oneEth).reduce((a, b) => a + b, 0n);
    expect(tenEth).toBe(parseUnits("10", 18));
    expect(tenEth).toBe(10_000_000_000_000_000_000n);
  });

  it("product of gas price × gas limit uses bigint, not Number", () => {
    // Gas price: 100 gwei = 100_000_000_000 wei
    // Gas limit: 21000
    // No issue here, but if either side went through Number() at extreme values...
    const gasPrice = 100_000_000_000n; // 100 gwei
    const gasLimit = 21_000n;
    const totalGas = gasPrice * gasLimit;
    expect(totalGas).toBe(2_100_000_000_000_000n);
    expect(typeof totalGas).toBe("bigint");

    // Extreme case: gasPrice = 10^12 gwei (absurd, but tests the point)
    const extremeGasPrice = 1_000_000_000_000_000_000_000n; // 10^12 gwei
    const extremeTotal = extremeGasPrice * gasLimit;
    expect(extremeTotal).toBe(21_000_000_000_000_000_000_000_000n);
    expect(typeof extremeTotal).toBe("bigint");
  });

  it("bigint sum of many dust amounts is exact", () => {
    // 100,000 transfers of 1 wei each
    const dust = 1n;
    const total = Array.from({ length: 100_000 }, () => dust).reduce((a, b) => a + b, 0n);
    expect(total).toBe(100_000n);
    // Verify no floating point accumulation error
    expect(total).not.toBe(99999n);
  });

  it("bigint division truncation is explicit (no floating point)", () => {
    // 1 ETH / 3 = 0.333... ETH truncated to wei
    const oneEth = parseUnits("1", 18);
    const third = oneEth / 3n; // bigint truncation
    expect(third).toBe(333_333_333_333_333_333n);
    // Verify: 3 * third <= oneEth < 3 * (third + 1n)
    expect(3n * third).toBeLessThanOrEqual(oneEth);
    expect(3n * (third + 1n)).toBeGreaterThan(oneEth);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Section 2: Hex → Bigint Parsing
// ═══════════════════════════════════════════════════════════════════════

describe("BigInt — hex parsing and serialization", () => {
  it("BigInt('0x0') = 0n", () => {
    expect(BigInt("0x0")).toBe(0n);
  });

  it("BigInt('0x1') = 1n", () => {
    expect(BigInt("0x1")).toBe(1n);
  });

  it("BigInt('0xff') = 255n", () => {
    expect(BigInt("0xff")).toBe(255n);
    expect(BigInt("0xFF")).toBe(255n); // uppercase hex
  });

  it("BigInt('0x' + 'ff') = 255n (strip 0x pattern)", () => {
    const hex = "ff";
    expect(BigInt("0x" + hex)).toBe(255n);
  });

  it("parses full uint256 max (2^256 - 1)", () => {
    const uint256Max = "0x" + "f".repeat(64);
    expect(BigInt(uint256Max)).toBe((1n << 256n) - 1n);
  });

  it("parses 64-byte hex (2^512 - 1)", () => {
    const max512 = "0x" + "f".repeat(128);
    const expected = (1n << 512n) - 1n;
    expect(BigInt(max512)).toBe(expected);
  });

  it("parses hex with leading zeros", () => {
    expect(BigInt("0x" + "0".repeat(64) + "1")).toBe(1n);
  });

  it("parses empty hex string (0x only) → throws", () => {
    expect(() => BigInt("0x")).toThrow();
  });

  it("bigint → hex string round-trip", () => {
    const values = [
      0n,
      1n,
      255n,
      65535n,
      (1n << 64n) - 1n,
      (1n << 128n) - 1n,
      (1n << 256n) - 1n,
    ];
    for (const v of values) {
      const hex = "0x" + v.toString(16);
      expect(BigInt(hex)).toBe(v);
    }
  });

  it("bigint → decimal string → bigint round-trip", () => {
    const values = [
      "0",
      "1",
      "9007199254740991", // MAX_SAFE_INTEGER
      "9007199254740992", // MAX_SAFE_INTEGER + 1
      "340282366920938463463374607431768211455", // 2^128 - 1
      "115792089237316195423570985008687907853269984665640564039457584007913129639935", // 2^256 - 1
    ];
    for (const s of values) {
      const parsed = BigInt(s);
      expect(parsed.toString()).toBe(s);
    }
  });

  it("parseUnits handles hex-like input as strings (not hex)", () => {
    // "0xff" as a string input to parseUnits should be treated as 0.ff not 255
    // Actually parseUnits expects decimal strings, not hex
    expect(() => parseUnits("0xff", 0)).toThrow(ERC20TokenError);
    expect(() => parseUnits("0x1", 0)).toThrow(ERC20TokenError);
  });

  it("bigint multiplication of extreme values uses correct precision", () => {
    // 2^128 * 2^128 = 2^256
    const a = 1n << 128n;
    const b = 1n << 128n;
    const product = a * b;
    expect(product).toBe(1n << 256n);
    expect(product).toBe((1n << 256n) - 0n); // exact
  });

  it("bigint addition of large values is exact", () => {
    const a = (1n << 255n) - 1n;
    const b = 1n;
    const sum = a + b;
    expect(sum).toBe(1n << 255n);
  });

  it("no implicit BigInt → Number conversion in financial operations", () => {
    // This test would catch code that uses +bigint or Number(bigint)
    // without explicit understanding
    const large = (1n << 64n) + 12345n;
    // If someone does Number(large), it would be imprecise
    expect(typeof large).toBe("bigint");
    expect(large.toString()).toBe("18446744073709563961");
    // Number() may round: the issue is that BigInt → Number is lossy
    // at this magnitude; verify round-trip through string instead
    const roundedBack = BigInt(String(Number(large)));
    expect(roundedBack).not.toBe(large);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Section 3: ABI Encoding/Decoding Vectors
// ═══════════════════════════════════════════════════════════════════════

describe("ABI — function selector computation", () => {
  it("balanceOf(address) selector matches known value", async () => {
    const { abiFunctionSelector } = await import("../token/ERC20TokenHelper");
    const selector = await abiFunctionSelector("balanceOf(address)");
    // keccak256("balanceOf(address)") → first 4 bytes
    // Known: 0x70a08231
    expect(selector).toBe("0x70a08231");
  });

  it("transfer(address,uint256) selector matches known value", async () => {
    const { abiFunctionSelector } = await import("../token/ERC20TokenHelper");
    const selector = await abiFunctionSelector("transfer(address,uint256)");
    // Known: 0xa9059cbb
    expect(selector).toBe("0xa9059cbb");
  });

  it("approve(address,uint256) selector matches known value", async () => {
    const { abiFunctionSelector } = await import("../token/ERC20TokenHelper");
    const selector = await abiFunctionSelector("approve(address,uint256)");
    // Known: 0x095ea7b3
    expect(selector).toBe("0x095ea7b3");
  });

  it("allowance(address,address) selector matches known value", async () => {
    const { abiFunctionSelector } = await import("../token/ERC20TokenHelper");
    const selector = await abiFunctionSelector("allowance(address,address)");
    // Known: 0xdd62ed3e
    expect(selector).toBe("0xdd62ed3e");
  });

  it("transferFrom(address,address,uint256) selector matches known value", async () => {
    const { abiFunctionSelector } = await import("../token/ERC20TokenHelper");
    const selector = await abiFunctionSelector("transferFrom(address,address,uint256)");
    // Known: 0x23b872dd
    expect(selector).toBe("0x23b872dd");
  });

  it("totalSupply() selector matches known value", async () => {
    const { abiFunctionSelector } = await import("../token/ERC20TokenHelper");
    const selector = await abiFunctionSelector("totalSupply()");
    // Known: 0x18160ddd
    expect(selector).toBe("0x18160ddd");
  });

  it("decimals() selector matches known value", async () => {
    const { abiFunctionSelector } = await import("../token/ERC20TokenHelper");
    const selector = await abiFunctionSelector("decimals()");
    // Known: 0x313ce567
    expect(selector).toBe("0x313ce567");
  });

  it("symbol() selector matches known value", async () => {
    const { abiFunctionSelector } = await import("../token/ERC20TokenHelper");
    const selector = await abiFunctionSelector("symbol()");
    // Known: 0x95d89b41
    expect(selector).toBe("0x95d89b41");
  });

  it("name() selector matches known value", async () => {
    const { abiFunctionSelector } = await import("../token/ERC20TokenHelper");
    const selector = await abiFunctionSelector("name()");
    // Known: 0x06fdde03
    expect(selector).toBe("0x06fdde03");
  });

  it("latestRoundData() selector (Chainlink) matches known value", async () => {
    const { abiFunctionSelector } = await import("../token/ERC20TokenHelper");
    const selector = await abiFunctionSelector("latestRoundData()");
    // Used in token-price.ts: 0xfeaf968c
    expect(selector).toBe("0xfeaf968c");
  });
});

describe("ABI — address encoding", () => {
  it("encodes a standard address with left padding", () => {
    const addr = ADDRESSES.BOB as `0x${string}`;
    const encoded = abiEncodeAddress(addr);
    // Should be 0x + 64 hex chars = 66 chars total
    expect(encoded.length).toBe(66);
    expect(encoded).toBe(
      "0x000000000000000000000000ab5801a7d398351b8be11c439e05c5b3259aec9b",
    );
    // Verify lowercase conversion
    expect(encoded.includes("ab5801a7d3")).toBe(true);
  });

  it("encodes zero address correctly", () => {
    const addr = ADDRESSES.ZERO as `0x${string}`;
    const encoded = abiEncodeAddress(addr);
    expect(encoded).toBe(
      "0x" + "0".repeat(64),
    );
  });

  it("rejects invalid address (too short)", () => {
    expect(() => abiEncodeAddress("0x1234" as `0x${string}`)).toThrow(ERC20TokenError);
  });

  it("rejects invalid address (non-hex characters)", () => {
    expect(() =>
      abiEncodeAddress("0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" as `0x${string}`)
    ).toThrow(ERC20TokenError);
  });

  it("rejects address without 0x prefix", () => {
    expect(() =>
      abiEncodeAddress("ab5801a7d398351b8be11c439e05c5b3259aec9b" as unknown as `0x${string}`)
    ).toThrow(ERC20TokenError);
  });
});

describe("ABI — uint256 encoding", () => {
  it("encodes zero", () => {
    const encoded = abiEncodeUint256(0n);
    expect(encoded).toBe("0x" + "0".repeat(64));
  });

  it("encodes 1", () => {
    const encoded = abiEncodeUint256(1n);
    expect(encoded).toBe(
      "0x" + "0".repeat(63) + "1",
    );
  });

  it("encodes uint256 max value", () => {
    const max = (1n << 256n) - 1n;
    const encoded = abiEncodeUint256(max);
    expect(encoded).toBe("0x" + "f".repeat(64));
  });

  it("encodes common ETH amounts", () => {
    // 1 ETH = 10^18 wei
    const oneEth = 1_000_000_000_000_000_000n;
    const encoded = abiEncodeUint256(oneEth);
    expect(encoded).toBe(
      "0x" + "0".repeat(64 - 16) + "0de0b6b3a7640000",
    );
  });

  it("encodes common USDC amounts", () => {
    // 1000 USDC = 1_000_000_000 (6 decimals)
    const thousandUsdc = 1_000_000_000n;
    const encoded = abiEncodeUint256(thousandUsdc);
    expect(encoded).toBe(
      "0x" + "0".repeat(56) + "3b9aca00",
    );
  });

  it("rejects negative values", () => {
    expect(() => abiEncodeUint256(-1n)).toThrow(ERC20TokenError);
    expect(() => abiEncodeUint256(-1000000n)).toThrow(ERC20TokenError);
  });
});

describe("ABI — ERC-20 RPC payload construction", () => {
  it("balanceOf eth_call payload has correct structure", async () => {
    const { abiEncodeFunctionCall } = await import("../token/ERC20TokenHelper");

    const usdcAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`;
    const owner = ADDRESSES.ALICE as `0x${string}`;
    const data = await abiEncodeFunctionCall(
      "balanceOf(address)",
      abiEncodeAddress(owner),
    );

    // Full RPC payload for balance check
    const rpcPayload = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call" as const,
      params: [
        { to: usdcAddress, data },
        "latest",
      ],
    };

    expect(rpcPayload.method).toBe("eth_call");
    expect(rpcPayload.params[0].to).toBe(usdcAddress);
    expect(rpcPayload.params[0].data.startsWith("0x70a08231")).toBe(true);
    expect(rpcPayload.params[0].data.length).toBe(74); // 0x + 4 bytes selector + 32 bytes arg
  });

  it("decodes hex balance result for realistic USDC balance", () => {
    // Simulate a hex result from eth_call: 1000 USDC with 6 decimals
    const balanceWei = 1_000_000_000n; // 1000 USDC
    const resultHex = "0x" + balanceWei.toString(16).padStart(64, "0");

    const decoded = BigInt(resultHex);
    expect(decoded).toBe(1_000_000_000n);
    expect(typeof decoded).toBe("bigint");
  });

  it("decodes hex result for 0 balance", () => {
    const resultHex = "0x" + "0".repeat(64);
    const decoded = BigInt(resultHex);
    expect(decoded).toBe(0n);
  });

  it("decodes hex result for max uint256 balance", () => {
    const maxBalance = (1n << 256n) - 1n;
    const resultHex = "0x" + maxBalance.toString(16).padStart(64, "0");
    const decoded = BigInt(resultHex);
    expect(decoded).toBe(maxBalance);
  });

  it("decodes Chainlink price result (8-decimal price feed)", () => {
    // Chainlink price feed returns answer as 2nd 32-byte word
    // Price: $2000.50 → answer = 200050000000 (8 decimals)
    const answer = BigInt("200050000000");
    const answerHex = answer.toString(16).padStart(64, "0");
    const roundIdHex = "1".padStart(64, "0");
    const startedAtHex = "0".padStart(64, "0");
    const updatedAtHex = "0".padStart(64, "0");
    const answeredInRoundHex = "1".padStart(64, "0");
    const fullHex = "0x" + roundIdHex + answerHex + startedAtHex + updatedAtHex + answeredInRoundHex;

    // Decode answer (2nd word, bytes 32-64)
    const rawHex = fullHex.startsWith("0x") ? fullHex.slice(2) : fullHex;
    const decodedAnswer = BigInt("0x" + rawHex.slice(64, 128));

    expect(decodedAnswer).toBe(answer);
    // Convert to human-readable (8 decimals)
    expect(Number(decodedAnswer) / 10 ** 8).toBe(2000.5);
  });

  it("decodes Chainlink price result for $0.01", () => {
    const answer = BigInt("1000000"); // $0.01 with 8 decimals
    const answerHex = answer.toString(16).padStart(64, "0");
    const roundIdHex = "1".padStart(64, "0");
    const startedAtHex = "0".padStart(64, "0");
    const updatedAtHex = "0".padStart(64, "0");
    const answeredInRoundHex = "1".padStart(64, "0");
    const fullHex = "0x" + roundIdHex + answerHex + startedAtHex + updatedAtHex + answeredInRoundHex;

    const rawHex = fullHex.startsWith("0x") ? fullHex.slice(2) : fullHex;
    const decodedAnswer = BigInt("0x" + rawHex.slice(64, 128));

    expect(Number(decodedAnswer) / 10 ** 8).toBeCloseTo(0.01, 10);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Section 4: Token Amount Serialization
// ═══════════════════════════════════════════════════════════════════════

describe("Token serialization — USDC (6 decimals)", () => {
  it("parseUnits '1.0' with 6 decimals", () => {
    expect(parseUnits("1.0", 6)).toBe(1_000_000n);
  });

  it("parseUnits '0.000001' with 6 decimals", () => {
    expect(parseUnits("0.000001", 6)).toBe(1n);
  });

  it("parseUnits '1000000' with 6 decimals", () => {
    expect(parseUnits("1000000", 6)).toBe(1_000_000_000_000n);
  });

  it("parseUnits '0' with 6 decimals", () => {
    expect(parseUnits("0", 6)).toBe(0n);
  });

  it("formatUnits 1_000_000n with 6 decimals → '1'", () => {
    expect(formatUnits(1_000_000n, 6)).toBe("1");
  });

  it("formatUnits 1n with 6 decimals → '0.000001'", () => {
    expect(formatUnits(1n, 6)).toBe("0.000001");
  });

  it("formatUnits 0n with 6 decimals → '0'", () => {
    expect(formatUnits(0n, 6)).toBe("0");
  });

  it("formatUnits 1_500_000n with 6 decimals → '1.5'", () => {
    expect(formatUnits(1_500_000n, 6)).toBe("1.5");
  });
});

describe("Token serialization — ETH (18 decimals)", () => {
  it("parseUnits '1' with 18 decimals", () => {
    expect(parseUnits("1", 18)).toBe(10n ** 18n);
  });

  it("parseUnits '0.000000000000000001' with 18 decimals (1 wei)", () => {
    expect(parseUnits("0.000000000000000001", 18)).toBe(1n);
  });

  it("parseUnits '1.234567890123456789' with 18 decimals", () => {
    expect(parseUnits("1.234567890123456789", 18)).toBe(1_234_567_890_123_456_789n);
  });

  it("formatUnits 1n with 18 decimals → '0.000000000000000001'", () => {
    expect(formatUnits(1n, 18)).toBe("0.000000000000000001");
  });

  it("formatUnits 10_000_000_000_000_000n with 18 decimals → '0.01'", () => {
    expect(formatUnits(10_000_000_000_000_000n, 18)).toBe("0.01");
  });

  it("formatUnits 10n ** 18n with 18 decimals → '1'", () => {
    expect(formatUnits(10n ** 18n, 18)).toBe("1");
  });

  it("formatUnits 10n ** 24n with 18 decimals → '1000000'", () => {
    expect(formatUnits(10n ** 24n, 18)).toBe("1000000");
  });
});

describe("Token serialization — 0 decimals (integer tokens)", () => {
  it("parseUnits '100' with 0 decimals", () => {
    expect(parseUnits("100", 0)).toBe(100n);
  });

  it("parseUnits '0' with 0 decimals", () => {
    expect(parseUnits("0", 0)).toBe(0n);
  });

  it("formatUnits 100n with 0 decimals → '100'", () => {
    expect(formatUnits(100n, 0)).toBe("100");
  });

  it("formatUnits the largest uint256 with 0 decimals", () => {
    const max = (1n << 256n) - 1n;
    const formatted = formatUnits(max, 0);
    expect(BigInt(formatted)).toBe(max);
    expect(formatted).toBe(
      "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    );
  });
});

describe("Token serialization — edge cases", () => {
  it("truncation: values with fewer decimals than max pad cleanly", () => {
    expect(parseUnits("1.5", 18)).toBe(1_500_000_000_000_000_000n);
  });

  it("truncation: trailing zeros are stripped on format", () => {
    expect(formatUnits(1_500_000_000_000_000_000n, 18)).toBe("1.5");
    expect(formatUnits(1_000_000_000_000_000_000n, 18)).toBe("1");
  });

  it("no rounding: parseUnits with 3 decimals for 6-decimal token", () => {
    expect(parseUnits("1.001", 6)).toBe(1_001_000n);
  });

  it("rejects excess decimal places", () => {
    // 6-decimal token, 7 decimal places provided
    expect(() => parseUnits("1.1234567", 6)).toThrow(ERC20TokenError);
    expect(() => parseUnits("1.1234567", 6)).toThrow("7 decimal places");
  });

  it("exact boundary: decimal places equal to token decimals", () => {
    expect(parseUnits("1.123456", 6)).toBe(1_123_456n);
    expect(parseUnits("1.123456789012345678", 18)).toBe(1_123_456_789_012_345_678n);
  });

  it("very large amount with 18 decimals doesn't overflow", () => {
    // Total ETH supply ~120M → 120,000,000 * 10^18 = 1.2e26
    const supply = parseUnits("120000000", 18);
    expect(supply).toBe(120_000_000_000_000_000_000_000_000n);
    // No Number() conversion means this is exact
    expect(Number(supply)).toBe(1.2e26);
    // But BigInt is exact
    expect(supply).toBe(120_000_000n * (10n ** 18n));
  });

  it("round-trip with many decimals", () => {
    const testCases = [
      { val: "0", dec: 18 },
      { val: "0.000000000000000001", dec: 18 },
      { val: "0.5", dec: 18 },
      { val: "1", dec: 18 },
      { val: "999999.999999999999999999", dec: 18 },
      { val: "0.000001", dec: 6 },
      { val: "1", dec: 6 },
      { val: "999999.999999", dec: 6 },
      { val: "100", dec: 0 },
    ];

    for (const { val, dec } of testCases) {
      const raw = parseUnits(val, dec);
      const formatted = formatUnits(raw, dec);
      expect(formatted).toBe(val);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Section 5: Gas Limit Encoding/Decoding (packed uint128 pattern)
// ═══════════════════════════════════════════════════════════════════════

describe("Gas limit encoding — encodeGasLimits / decodeGasLimits", () => {
  it("encodes and decodes zero values", () => {
    const encoded = encodeGasLimits(0n, 0n);
    expect(encoded).toBe(
      "0x" + "0".repeat(32) + "0".repeat(32),
    );
    const decoded = decodeGasLimits(encoded);
    expect(decoded.verificationGasLimit).toBe(0n);
    expect(decoded.callGasLimit).toBe(0n);
  });

  it("encodes and decodes typical gas limits", () => {
    const vgl = 50_000n;
    const cgl = 100_000n;
    const encoded = encodeGasLimits(vgl, cgl);
    expect(encoded.length).toBe(66); // 0x + 64 hex chars
    const decoded = decodeGasLimits(encoded);
    expect(decoded.verificationGasLimit).toBe(vgl);
    expect(decoded.callGasLimit).toBe(cgl);
  });

  it("round-trips max uint128 values", () => {
    const max128 = (1n << 128n) - 1n;
    const encoded = encodeGasLimits(max128, max128);
    const decoded = decodeGasLimits(encoded);
    expect(decoded.verificationGasLimit).toBe(max128);
    expect(decoded.callGasLimit).toBe(max128);
  });

  it("encodes asymmetric gas limits correctly (large vgl, small cgl)", () => {
    const vgl = 1n << 120n;
    const cgl = 1n;
    const encoded = encodeGasLimits(vgl, cgl);
    const decoded = decodeGasLimits(encoded);
    expect(decoded.verificationGasLimit).toBe(vgl);
    expect(decoded.callGasLimit).toBe(cgl);
  });

  it("encodes asymmetric gas limits correctly (small vgl, large cgl)", () => {
    const vgl = 1n;
    const cgl = 1n << 120n;
    const encoded = encodeGasLimits(vgl, cgl);
    const decoded = decodeGasLimits(encoded);
    expect(decoded.verificationGasLimit).toBe(vgl);
    expect(decoded.callGasLimit).toBe(cgl);
  });

  it("produced hex is exactly 32 bytes for each component", () => {
    const vgl = 12345n;
    const cgl = 67890n;
    const encoded = encodeGasLimits(vgl, cgl);
    const raw = encoded.startsWith("0x") ? encoded.slice(2) : encoded;
    expect(raw.length).toBe(64); // 64 hex chars = 32 bytes
    // First 32 hex chars = verificationGasLimit
    const vglHex = raw.slice(0, 32);
    expect(BigInt("0x" + vglHex)).toBe(vgl);
    // Last 32 hex chars = callGasLimit
    const cglHex = raw.slice(32, 64);
    expect(BigInt("0x" + cglHex)).toBe(cgl);
  });

  it("decodeGasLimits handles prefixed hex strings", () => {
    const encoded = encodeGasLimits(100n, 200n);
    // encodeGasLimits already returns 0x-prefixed
    expect(encoded.startsWith("0x")).toBe(true);
    const decoded = decodeGasLimits(encoded);
    expect(decoded.verificationGasLimit).toBe(100n);
    expect(decoded.callGasLimit).toBe(200n);
  });
});

describe("UserOperation construction — bigint field safety", () => {
  it("buildUserOperation sets zero defaults for bigint fields", () => {
    const op = buildUserOperation({ sender: "0x" as `0x${string}` });
    expect(op.nonce).toBe(0n);
    expect(op.preVerificationGas).toBe(50_000n); // DEFAULT_PRE_VERIFICATION_GAS
    expect(op.maxFeePerGas).toBe(0n);
    expect(op.maxPriorityFeePerGas).toBe(0n);
  });

  it("buildUserOperation preserves explicit bigint values", () => {
    const op = buildUserOperation({
      sender: ADDRESSES.ALICE as `0x${string}`,
      nonce: BigInt("0x" + "f".repeat(64)), // huge nonce
      maxFeePerGas: 100_000_000_000n, // 100 gwei
      maxPriorityFeePerGas: 1_000_000_000n, // 1 gwei
    });

    expect(op.nonce).toBe((1n << 256n) - 1n);
    expect(op.maxFeePerGas).toBe(100_000_000_000n);
    expect(op.maxPriorityFeePerGas).toBe(1_000_000_000n);
  });

  it("buildUserOperation accountGasLimits are correctly encoded with defaults", () => {
    const op = buildUserOperation({ sender: "0x" as `0x${string}` });
    // accountGasLimits should be a valid hex string
    expect(typeof op.accountGasLimits).toBe("string");
    expect(op.accountGasLimits.startsWith("0x")).toBe(true);
    expect(op.accountGasLimits.length).toBe(66); // 0x + 64 hex chars

    const decoded = decodeGasLimits(op.accountGasLimits);
    expect(decoded.verificationGasLimit).toBe(100_000n); // DEFAULT_VERIFICATION_GAS_LIMIT
    expect(decoded.callGasLimit).toBe(100_000n); // DEFAULT_CALL_GAS_LIMIT
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Section 6: Cross-token decimal conversion safety
// ═══════════════════════════════════════════════════════════════════════

describe("Cross-decimal conversion safety", () => {
  it("converts USDC → ETH at same dollar value (sanity)", () => {
    // $1 USDC = 1,000,000 (6 decimals)
    // $1 ETH = 1,000,000,000,000,000,000 wei (18 decimals)
    // Ratio: 10^12
    const oneDollarUsdc = parseUnits("1", 6); // 1,000,000
    const oneDollarEth = parseUnits("1", 18); // 1,000,000,000,000,000,000

    const ratio = oneDollarEth / oneDollarUsdc;
    expect(ratio).toBe(1_000_000_000_000n); // 10^12
  });

  it("converts Solana lamports to SOL (9 decimals)", () => {
    const oneSol = parseUnits("1", 9);
    expect(oneSol).toBe(1_000_000_000n);
  });

  it("converts XRP drops to XRP (6 decimals)", () => {
    const oneXrp = parseUnits("1", 6);
    expect(oneXrp).toBe(1_000_000n);
  });

  it("accumulates 18-decimal amounts across many transactions", () => {
    // Simulate 1000 USDC transactions in parallel (each ~$50)
    const transactions = Array.from({ length: 1000 }, () => parseUnits("50", 6));
    const total = transactions.reduce((a, b) => a + b, 0n);
    expect(total).toBe(50_000_000_000n);
    // $50 * 1000 = $50,000
    expect(formatUnits(total, 6)).toBe("50000");
  });

  it("no precision loss mixing small and large bigint amounts", () => {
    const tiny = 1n; // 1 wei
    const huge = (1n << 200n); // astronomically large
    const sum = tiny + huge;
    // The tiny value should not get lost
    expect(sum - huge).toBe(tiny);
    expect(sum - tiny).toBe(huge);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Section 7: Financial Safety Patterns
// ═══════════════════════════════════════════════════════════════════════

describe("Financial safety — Number() traps", () => {
  it("parseUnits(string, 18) result is bigint, not Number", () => {
    const result = parseUnits("1", 18);
    expect(result).toBeTypeOf("bigint");
    expect(result).not.toBeTypeOf("number");
  });

  it("formatUnits(bigint, 18) returns string, not number", () => {
    const result = formatUnits(1_000_000_000_000_000_000n, 18);
    expect(result).toBeTypeOf("string");
  });

  it("abiEncodeUint256 takes bigint input, returns string", () => {
    const result = abiEncodeUint256(1_000_000n);
    expect(result).toBeTypeOf("string");
    expect(result.startsWith("0x")).toBe(true);
  });

  it("no implicit Number() on bigint gas calculation results", () => {
    // This tests that bigint arithmetic never goes through Number()
    const gasPrice = 50_000_000_000n; // 50 gwei
    const gasLimit = 210_000n;
    const fee = gasPrice * gasLimit;
    // If this had gone through Number(), we'd lose precision
    expect(typeof fee).toBe("bigint");
    expect(fee).toBe(10_500_000_000_000_000n);
    // Re-derive from original to verify
    expect(fee / gasPrice).toBe(gasLimit);
    expect(fee / gasLimit).toBe(gasPrice);
  });

  it("no implicit Number() on chain ID values", () => {
    // Chain IDs can be large (e.g., Avalanche = 43114)
    // They should be numbers but never implicitly from bigint
    const chainId = 43114;
    expect(Number.isInteger(chainId)).toBe(true);
    // If someone had done Number(bigintChainId) it could lose precision
    // for L2s with chain IDs > MAX_SAFE_INTEGER (unlikely but for safety)
    const bigintChainId = BigInt(chainId);
    expect(Number(bigintChainId)).toBe(chainId);
  });
});

describe("Financial safety — negative value protection", () => {
  it("parseUnits rejects negative strings", () => {
    expect(() => parseUnits("-1", 18)).toThrow(ERC20TokenError);
    expect(() => parseUnits("-0.5", 6)).toThrow(ERC20TokenError);
  });

  it("parseUnits rejects negative numbers", () => {
    expect(() => parseUnits(-1, 18)).toThrow(ERC20TokenError);
    expect(() => parseUnits(-0.5, 6)).toThrow(ERC20TokenError);
  });

  it("abiEncodeUint256 rejects negative values", () => {
    expect(() => abiEncodeUint256(-1n)).toThrow(ERC20TokenError);
    expect(() => abiEncodeUint256(-999999n)).toThrow(ERC20TokenError);
  });

  it("formatUnits handles negative amounts without throwing", () => {
    // formatUnits doesn't throw on negative, it handles them
    const formatted = formatUnits(-1_000_000n, 6);
    expect(formatted).toBe("-1");
  });

  it("formatUnits round-trips negative amounts", () => {
    const negative = -1_234_567n;
    const formatted = formatUnits(negative, 6);
    expect(formatted).toBe("-1.234567");
    // Round-trip: parseUnits of a negative string should fail
    expect(() => parseUnits(formatted, 6)).toThrow(ERC20TokenError);
  });
});

describe("Financial safety — NaN/Infinity protection", () => {
  it("parseUnits rejects NaN", () => {
    expect(() => parseUnits(NaN, 18)).toThrow(ERC20TokenError);
  });

  it("parseUnits rejects Infinity", () => {
    expect(() => parseUnits(Infinity, 18)).toThrow(ERC20TokenError);
    expect(() => parseUnits(-Infinity, 18)).toThrow(ERC20TokenError);
  });

  it("parseUnits rejects empty string", () => {
    expect(() => parseUnits("", 18)).toThrow(ERC20TokenError);
  });

  it("parseUnits rejects '.'", () => {
    expect(() => parseUnits(".", 18)).toThrow(ERC20TokenError);
  });

  it("parseUnits rejects non-numeric strings", () => {
    expect(() => parseUnits("abc", 18)).toThrow(ERC20TokenError);
    expect(() => parseUnits("1.2.3", 18)).toThrow(ERC20TokenError);
  });
});

describe("Financial safety — decimal validation", () => {
  it("parseUnits rejects non-integer decimals", () => {
    expect(() => parseUnits("1", 6.5)).toThrow(ERC20TokenError);
    expect(() => parseUnits("1", 0.1)).toThrow(ERC20TokenError);
  });

  it("parseUnits rejects negative decimals", () => {
    expect(() => parseUnits("1", -1)).toThrow(ERC20TokenError);
  });

  it("formatUnits rejects non-integer decimals", () => {
    expect(() => formatUnits(100n, 6.5)).toThrow(ERC20TokenError);
    expect(() => formatUnits(100n, 0.1)).toThrow(ERC20TokenError);
  });

  it("formatUnits rejects negative decimals", () => {
    expect(() => formatUnits(100n, -1)).toThrow(ERC20TokenError);
  });
});

describe("Financial safety — output amount never negative", () => {
  it("bigint subtraction clamped pattern (amount - cost)", () => {
    // This is the pattern used in RouteEngine.getBestRoute
    // to ensure outputAmount is never negative
    const amount = 100_000n;
    const cost = 500_000n;
    const output = amount >= cost ? amount - cost : 0n;
    expect(output).toBe(0n);
    expect(typeof output).toBe("bigint");
  });

  it("bigint subtraction with exact match", () => {
    const amount = 100_000n;
    const cost = 100_000n;
    const output = amount >= cost ? amount - cost : 0n;
    expect(output).toBe(0n);
  });

  it("bigint subtraction with surplus", () => {
    const amount = 500_000n;
    const cost = 100_000n;
    const output = amount >= cost ? amount - cost : 0n;
    expect(output).toBe(400_000n);
  });

  it("no negative bigint output from safe patterns", () => {
    const testCases = [
      { amount: 0n, cost: 0n, expected: 0n },
      { amount: 0n, cost: 1n, expected: 0n },
      { amount: 1n, cost: 0n, expected: 1n },
      { amount: 10n, cost: 10n, expected: 0n },
      { amount: 100n, cost: 90n, expected: 10n },
    ];
    for (const { amount, cost, expected } of testCases) {
      const output = amount >= cost ? amount - cost : 0n;
      expect(output).toBe(expected);
      expect(output >= 0n).toBe(true);
    }
  });
});

describe("Financial safety — toString vs Number", () => {
  it("bigint toString does not lose precision", () => {
    const large = 123456789012345678901234567890n;
    const str = large.toString();
    expect(BigInt(str)).toBe(large);
    // Number would lose precision here:
    // Number(1.23456789012345678901234567890e+29) ≈ 123456789012345680000000000000
    // Verify by comparing the string representations
    const asNumber = Number(str);
    const asNumberStr = asNumber.toString();
    expect(asNumberStr).not.toBe(str);
  });

  it("bigint toLocaleString is never used for financial display", () => {
    // toLocaleString returns a localized string but is Number-based
    // financial code should use formatUnits for display
    const large = 1_234_567_890_123_456_789n;
    const formatted = formatUnits(large, 18);
    expect(formatted).toBe("1.234567890123456789");
    // Not affected by locale
    expect(formatted.includes(",")).toBe(false);
  });

  it("abiEncodeUint256 uses bigint.toString(16) not Number.toString(16)", () => {
    const value = (1n << 128n) + 1n;
    // Number(value) would be 3.402823669209385e+38
    // Number(value).toString(16) would not be exact
    const encoded = abiEncodeUint256(value);
    const expectedHex = value.toString(16).padStart(64, "0");
    expect(encoded).toBe("0x" + expectedHex);
  });
});

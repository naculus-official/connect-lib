import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abiEncodeAddress,
  abiEncodeUint256,
  decodeERC20String,
  encodeERC20Approve,
  encodeERC20Transfer,
  getERC20Decimals,
  getERC20TokenInfo,
  getSelector,
  parseUnits,
} from "./erc20-utils";

const TOKEN = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const word = (value: bigint | number): string =>
  BigInt(value).toString(16).padStart(64, "0");

function dynamicString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .padEnd(Math.ceil(bytes.length / 32) * 64, "0");
  return `0x${word(32)}${word(bytes.length)}${hex}`;
}

afterEach(() => vi.restoreAllMocks());

describe("wallet-engine ERC-20 helpers", () => {
  it("validates ABI address and uint256 bounds", () => {
    expect(() => abiEncodeAddress("0x123" as `0x${string}`)).toThrow();
    expect(() => abiEncodeUint256(-1n)).toThrow();
    expect(() => abiEncodeUint256(1n << 256n)).toThrow();
  });

  it("decodes dynamic and legacy metadata strings", () => {
    expect(decodeERC20String(dynamicString("USD Coin"))).toBe("USD Coin");
    expect(decodeERC20String(`0x${"55534443".padEnd(64, "0")}`)).toBe("USDC");
  });

  it("rejects an out-of-range decimals response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: `0x${word(256n)}` }),
      }),
    );
    await expect(
      getERC20Decimals("https://rpc.example", TOKEN),
    ).rejects.toThrow("out-of-range decimals");
  });

  it("does not query a different chain through a stale wallet context", async () => {
    await expect(
      getERC20TokenInfo(
        {
          chainId: "eip155:1",
          rpcUrl: "https://rpc.example",
          sendTransaction: vi.fn(),
        },
        137,
        TOKEN,
      ),
    ).rejects.toMatchObject({ code: "chain_mismatch" });
  });
});

// ─── Payment-critical coverage ────────────────────────────────────────
//
// This module encodes the calldata that moves user funds, and it had one
// tested export out of fourteen (41.4% statements over 54 branches). The
// cases below target the paths where a defect costs money rather than
// throwing: unit conversion, ABI word alignment, and selector derivation.

describe("parseUnits — amount conversion", () => {
  it.each([
    ["1", 18, 1_000000000000000000n],
    ["1.5", 6, 1_500000n],
    ["0.000001", 6, 1n],
    ["0", 18, 0n],
    ["0.0", 6, 0n],
    [".5", 6, 500000n],
    ["1.", 6, 1_000000n],
    ["007", 6, 7_000000n],
    ["1000000000000", 18, 1_000000000000_000000000000000000n],
  ])("converts %s at %i decimals", (amount, decimals, expected) => {
    expect(parseUnits(amount as string, decimals as number)).toBe(expected);
  });

  it("refuses to silently truncate more precision than the token has", () => {
    // Truncating here would quietly send less than the caller asked for.
    expect(() => parseUnits("0.0000001", 6)).toThrow(/decimal places/);
    expect(() => parseUnits("1.123456789", 6)).toThrow(/decimal places/);
  });

  it.each(["-1", "1e6", "1,5", "0x10", "1.2.3", "", ".", " ", "abc"])(
    "rejects malformed amount %p",
    (bad) => {
      expect(() => parseUnits(bad, 18)).toThrow();
    },
  );

  it.each([-1, 256, 1.5, Number.NaN])("rejects decimals %p", (d) => {
    expect(() => parseUnits("1", d as number)).toThrow(/Decimals/);
  });

  it("keeps full precision for values beyond Number.MAX_SAFE_INTEGER", () => {
    // 2^53 wei would lose precision through a float; bigint must not.
    const raw = parseUnits("9007199.254740993", 9);
    expect(raw).toBe(9007199_254740993n);
  });
});

describe("ABI word encoding", () => {
  it("left-pads an address to a full 32-byte word", () => {
    const w = abiEncodeAddress(`0x${"ab".repeat(20)}` as `0x${string}`);
    expect(w).toHaveLength(64);
    expect(w.endsWith("ab".repeat(20))).toBe(true);
    expect(w.slice(0, 24)).toBe("0".repeat(24));
  });

  it("lowercases so a checksummed address encodes identically", () => {
    const lower = abiEncodeAddress(
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    );
    const checksummed = abiEncodeAddress(
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    );
    expect(lower).toBe(checksummed);
  });

  it.each(["0x", "0xzz", `0x${"ab".repeat(19)}`, `0x${"ab".repeat(21)}`])(
    "rejects malformed address %p",
    (bad) => {
      expect(() => abiEncodeAddress(bad as `0x${string}`)).toThrow();
    },
  );

  it("encodes uint256 across the full range", () => {
    expect(abiEncodeUint256(0n)).toBe("0".repeat(64));
    expect(abiEncodeUint256(1n)).toBe(`${"0".repeat(63)}1`);
    expect(abiEncodeUint256((1n << 256n) - 1n)).toBe("f".repeat(64));
  });

  it("rejects values outside uint256", () => {
    expect(() => abiEncodeUint256(-1n)).toThrow(/uint256/);
    expect(() => abiEncodeUint256(1n << 256n)).toThrow(/uint256/);
  });
});

describe("ERC-20 calldata", () => {
  const TO = `0x${"11".repeat(20)}` as `0x${string}`;

  it("derives the canonical transfer selector", async () => {
    // 0xa9059cbb is transfer(address,uint256); derived, never hard-coded.
    await expect(getSelector("transfer(address,uint256)")).resolves.toBe(
      "0xa9059cbb",
    );
  });

  it("derives the canonical approve selector", async () => {
    await expect(getSelector("approve(address,uint256)")).resolves.toBe(
      "0x095ea7b3",
    );
  });

  it("builds transfer calldata of exactly 4 + 32 + 32 bytes", async () => {
    const data = await encodeERC20Transfer(TO, 1_000000n);
    expect(data).toHaveLength(2 + 8 + 64 + 64);
    expect(data.slice(0, 10)).toBe("0xa9059cbb");
    expect(data.slice(10, 74).endsWith("11".repeat(20))).toBe(true);
    expect(BigInt(`0x${data.slice(74)}`)).toBe(1_000000n);
  });

  it("builds approve calldata of exactly 4 + 32 + 32 bytes", async () => {
    const data = await encodeERC20Approve(TO, (1n << 256n) - 1n);
    expect(data).toHaveLength(2 + 8 + 64 + 64);
    expect(data.slice(0, 10)).toBe("0x095ea7b3");
    expect(BigInt(`0x${data.slice(74)}`)).toBe((1n << 256n) - 1n);
  });

  it("propagates encoding rejections instead of emitting short calldata", async () => {
    await expect(
      encodeERC20Transfer("0xdead" as `0x${string}`, 1n),
    ).rejects.toThrow();
    await expect(encodeERC20Transfer(TO, -1n)).rejects.toThrow();
  });
});

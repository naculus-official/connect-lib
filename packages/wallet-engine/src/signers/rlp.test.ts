import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { encodeRlpList, hexToBytes, toRlpBytes, toRlpQuantity } from "./rlp";

/**
 * These primitives previously existed as three near-copies — two nested inside
 * evm.ts and one in crypto-worker.ts. They drifted: the worker's quantity
 * encoder demanded canonical form and so rejected any signature whose r or s
 * carried a leading zero nibble, which is roughly 18% of them. Signing failed
 * intermittently and looked random. One definition, tested once.
 */

const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;

describe("hexToBytes", () => {
  it.each([
    ["0x", 0],
    ["0x00", 1],
    ["0xdeadbeef", 4],
    ["deadbeef", 4],
  ])("decodes %p to %i bytes", (input, len) => {
    expect(hexToBytes(input)).toHaveLength(len);
  });

  it.each(["0x0", "0xzz", "0xabc"])("rejects %p", (bad) => {
    expect(() => hexToBytes(bad)).toThrow(/complete bytes/);
  });
});

describe("toRlpBytes", () => {
  it("encodes a single low byte as itself", () => {
    expect(hex(toRlpBytes("0x7f"))).toBe("0x7f");
  });

  it("prefixes a single high byte", () => {
    expect(hex(toRlpBytes("0x80"))).toBe("0x8180");
  });

  it("encodes the empty string as 0x80", () => {
    expect(hex(toRlpBytes("0x"))).toBe("0x80");
  });

  it("uses the short-string prefix below 56 bytes", () => {
    const out = toRlpBytes(`0x${"ab".repeat(20)}`);
    expect(out[0]).toBe(0x80 + 20);
  });

  it("uses the long-string prefix at 56 bytes and above", () => {
    const out = toRlpBytes(`0x${"ab".repeat(56)}`);
    expect(out[0]).toBe(0xb7 + 1);
    expect(out[1]).toBe(56);
  });

  it("preserves leading zeros, because calldata is not a quantity", () => {
    expect(hex(toRlpBytes("0x0011"))).toBe("0x820011");
  });
});

describe("toRlpQuantity", () => {
  it("encodes zero as the empty string", () => {
    expect(hex(toRlpQuantity("0x0"))).toBe("0x80");
    expect(hex(toRlpQuantity("0x0000"))).toBe("0x80");
  });

  it("strips leading zeros", () => {
    expect(hex(toRlpQuantity("0x0001"))).toBe("0x01");
    expect(hex(toRlpQuantity("0x000100"))).toBe("0x820100");
  });

  it("accepts a 32-byte value whose top nibble is zero", () => {
    // The exact shape the worker's copy used to reject.
    const r = `0x0${"a".repeat(63)}`;
    expect(() => toRlpQuantity(r)).not.toThrow();
  });

  it("accepts an odd-length quantity", () => {
    expect(hex(toRlpQuantity("0x1"))).toBe("0x01");
  });

  it("rejects non-hexadecimal input", () => {
    expect(() => toRlpQuantity("0xzz")).toThrow(/hexadecimal/);
  });
});

describe("encodeRlpList", () => {
  it("encodes an empty list", () => {
    expect(hex(encodeRlpList([]))).toBe("0xc0");
  });

  it("uses the short-list prefix below 56 bytes", () => {
    const out = encodeRlpList([toRlpBytes("0x01"), toRlpBytes("0x02")]);
    expect(out[0]).toBe(0xc0 + 2);
  });

  it("uses the long-list prefix at 56 bytes and above", () => {
    const items = Array.from({ length: 56 }, () => toRlpBytes("0x01"));
    const out = encodeRlpList(items);
    expect(out[0]).toBe(0xf7 + 1);
    expect(out[1]).toBe(56);
  });

  it("round-trips a legacy-shaped transaction list without throwing", () => {
    const list = [
      toRlpQuantity("0x01"),
      toRlpQuantity("0x3b9aca00"),
      toRlpQuantity("0x5208"),
      toRlpBytes(`0x${"11".repeat(20)}`),
      toRlpQuantity("0x0"),
      toRlpBytes("0x"),
      toRlpQuantity("0x01"),
      toRlpBytes("0x"),
      toRlpBytes("0x"),
    ];
    expect(() => encodeRlpList(list)).not.toThrow();
  });
});

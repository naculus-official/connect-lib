import { describe, expect, it } from "vitest";
import { normalizeEip155ChainId, requireEip155ChainId } from "./caip";

describe("normalizeEip155ChainId", () => {
  it.each([
    ["eip155:1", "eip155:1"],
    ["eip155:8453", "eip155:8453"],
    ["eip155:01", "eip155:1"],
    ["0x1", "eip155:1"],
    ["0x2105", "eip155:8453"],
    ["0X2105", "eip155:8453"],
    ["137", "eip155:137"],
    [String(Number.MAX_SAFE_INTEGER), `eip155:${Number.MAX_SAFE_INTEGER}`],
  ])("reads %j as %s", (input, expected) => {
    expect(normalizeEip155ChainId(input)).toBe(expected);
  });

  it.each([
    "eip155:0",
    "0x0",
    "0",
    "eip155:-1",
    "-1",
    "eip155:",
    "eip155:0x1",
    "eip155:1.5",
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "0x",
    "1e3",
    " 1",
    "",
    String(Number.MAX_SAFE_INTEGER + 2),
    `0x${(2n ** 64n).toString(16)}`,
    1,
    null,
    undefined,
  ])("refuses %j", (input) => {
    expect(normalizeEip155ChainId(input)).toBeUndefined();
  });
});

describe("requireEip155ChainId", () => {
  it("returns a canonical EIP-155 chain ID", () => {
    expect(requireEip155ChainId("eip155:10")).toBe("eip155:10");
  });

  it.each([
    "eip155:0",
    "eip155:01",
    "0x1",
    "1",
    "eip155:",
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    `eip155:${Number.MAX_SAFE_INTEGER + 2}`,
  ])("refuses %j", (input) => {
    expect(() => requireEip155ChainId(input)).toThrow(
      /Invalid EIP-155 chain ID/,
    );
  });
});

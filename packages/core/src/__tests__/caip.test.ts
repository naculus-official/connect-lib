import { describe, expect, it } from "vitest";
import {
  eip155Reference,
  isEvmAddress,
  namespaceOf,
  parseCaip10,
} from "../caip";

const SOLANA_CHAIN = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_ADDRESS = "HAgk14CToKGpm4rGCyVc5J8mQCGGvaJfYSxUJZ8AXfBW";

describe("parseCaip10", () => {
  it("reads an EVM account", () => {
    expect(parseCaip10(`eip155:1:0x${"11".repeat(20)}`)).toEqual({
      namespace: "eip155",
      chainId: "eip155:1",
      address: `0x${"11".repeat(20)}`,
    });
  });

  it("reads a Solana account", () => {
    expect(parseCaip10(`${SOLANA_CHAIN}:${SOLANA_ADDRESS}`)).toEqual({
      namespace: "solana",
      chainId: SOLANA_CHAIN,
      address: SOLANA_ADDRESS,
    });
  });

  // Session account lists are data from a wallet. One malformed entry should
  // not take down the account list around it.
  it("answers null for anything that is not a CAIP-10 account", () => {
    for (const bad of ["", "eip155:1", "0xabc", ":::", "not-a-chain:x"]) {
      expect(parseCaip10(bad)).toBeNull();
    }
  });

  it("takes the address from the end, not from index 2", () => {
    // The address is the last segment by definition; slicing the front keeps
    // this correct for a reference that itself contains a colon.
    const account = parseCaip10(`eip155:1:0x${"ab".repeat(20)}`);
    expect(account?.address).toBe(`0x${"ab".repeat(20)}`);
  });
});

describe("eip155Reference", () => {
  it("reads a decimal EIP-155 reference", () => {
    expect(eip155Reference("eip155:137")).toBe(137);
  });

  // The bug this replaces: parseInt on a base58 reference answers 5, because
  // base58 begins with a digit often enough.
  it("refuses a Solana chain rather than parsing a number out of it", () => {
    expect(eip155Reference(SOLANA_CHAIN)).toBeNull();
    expect(Number.parseInt(SOLANA_CHAIN.split(":")[1], 10)).toBe(5);
  });

  it("refuses a bare number with no namespace", () => {
    expect(eip155Reference("1")).toBeNull();
  });

  it("refuses a reference that is not a positive decimal", () => {
    expect(eip155Reference("eip155:0x89")).toBeNull();
    expect(eip155Reference("eip155:0")).toBeNull();
    expect(eip155Reference("eip155:")).toBeNull();
  });
});

describe("namespaceOf", () => {
  it("reads a namespace from a chain or an account", () => {
    expect(namespaceOf("eip155:1")).toBe("eip155");
    expect(namespaceOf(`${SOLANA_CHAIN}:${SOLANA_ADDRESS}`)).toBe("solana");
    expect(namespaceOf("xrpl:0")).toBe("xrpl");
  });

  it("answers null for something unreadable", () => {
    expect(namespaceOf("nonsense")).toBeNull();
  });
});

describe("isEvmAddress", () => {
  it("matches a 20-byte hex address", () => {
    expect(isEvmAddress(`0x${"11".repeat(20)}`)).toBe(true);
  });

  it("rejects anything else, including a Solana address", () => {
    expect(isEvmAddress(SOLANA_ADDRESS)).toBe(false);
    expect(isEvmAddress(`0x${"11".repeat(19)}`)).toBe(false);
    expect(isEvmAddress("")).toBe(false);
  });
});

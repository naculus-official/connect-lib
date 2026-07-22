import { describe, it, expect } from "vitest";
import { isValidAddress, isZeroAddress, isBurnAddress } from "./address-validation";

describe("isZeroAddress", () => {
  it("returns true for all-zero address", () => {
    expect(isZeroAddress("0x0000000000000000000000000000000000000000")).toBe(true);
  });
  it("returns false for a normal address", () => {
    expect(isZeroAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe(false);
  });
  it("returns false for empty string", () => {
    expect(isZeroAddress("")).toBe(false);
  });
});

describe("isBurnAddress", () => {
  it("returns true for dead prefix", () => {
    expect(isBurnAddress("0xdead000000000000000000000000000000000000")).toBe(true);
  });
  it("returns true for zero address (also a burn sink)", () => {
    expect(isBurnAddress("0x0000000000000000000000000000000000000000")).toBe(true);
  });
  it("returns false for a normal address", () => {
    expect(isBurnAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe(false);
  });
});

describe("isValidAddress", () => {
  it("accepts valid EVM checksummed address", () => {
    expect(isValidAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe(true);
  });
  it("rejects short EVM address", () => {
    expect(isValidAddress("0x1234")).toBe(false);
  });
  it("rejects invalid hex characters", () => {
    expect(isValidAddress("0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toBe(false);
  });
  it("accepts valid Solana base58 address", () => {
    expect(isValidAddress("7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtPb", "solana")).toBe(true);
  });
  it("rejects short Solana address", () => {
    expect(isValidAddress("abc", "solana")).toBe(false);
  });
  it("accepts valid XRPL classic address", () => {
    expect(isValidAddress("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", "xrpl")).toBe(true);
  });
  it("rejects invalid XRPL address (wrong prefix)", () => {
    expect(isValidAddress("xHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", "xrpl")).toBe(false);
  });
  it("returns false for non-string input", () => {
    expect(isValidAddress("", "eip155")).toBe(false);
  });
});

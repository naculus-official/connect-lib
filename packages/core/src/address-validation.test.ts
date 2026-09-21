import { describe, expect, it } from "vitest";
import {
  isBurnAddress,
  isChecksumAddress,
  isValidAddress,
  isZeroAddress,
  toChecksumAddress,
} from "./address-validation";

// All eight vectors in ERC-55 § Test Cases, including the intentional
// all-uppercase and all-lowercase checksummed examples.
const EIP55_VECTORS = [
  "0x52908400098527886E0F7030069857D2E4169EE7",
  "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
  "0xde709f2102306220921060314715629080e2fb77",
  "0x27b1fdb04752bbc536007a920d24acb045561c26",
  "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
  "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
] as const;

describe("EIP-55 checksum addresses", () => {
  it.each(EIP55_VECTORS)(
    "encodes and validates the official vector %s",
    (address) => {
      expect(toChecksumAddress(address.toLowerCase())).toBe(address);
      expect(isChecksumAddress(address)).toBe(true);
    },
  );

  it("rejects incorrect casing without changing permissive EVM shape validation", () => {
    const incorrect = "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    expect(isValidAddress(incorrect, "eip155")).toBe(true);
    expect(isChecksumAddress(incorrect)).toBe(false);
    expect(toChecksumAddress(incorrect)).toBe(EIP55_VECTORS[4]);
  });

  it.each([
    "",
    "0x1234",
    `0x${"f".repeat(41)}`,
    `0x${"z".repeat(40)}`,
    `0X${"a".repeat(40)}`,
    `eip155:1:0x${"a".repeat(40)}`,
    ` 0x${"a".repeat(40)}`,
  ])("fails closed on malformed input %s", (address) => {
    expect(isChecksumAddress(address)).toBe(false);
    expect(() => toChecksumAddress(address)).toThrow("Invalid EVM address");
  });

  it("rejects non-string runtime input", () => {
    expect(isChecksumAddress(null as unknown as string)).toBe(false);
    expect(() => toChecksumAddress(null as unknown as string)).toThrow(
      "Invalid EVM address",
    );
  });
});

describe("isZeroAddress", () => {
  it("returns true for all-zero address", () => {
    expect(isZeroAddress("0x0000000000000000000000000000000000000000")).toBe(
      true,
    );
  });
  it("returns false for a normal address", () => {
    expect(isZeroAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe(
      false,
    );
  });
  it("returns false for empty string", () => {
    expect(isZeroAddress("")).toBe(false);
  });
});

describe("isBurnAddress", () => {
  it("returns true for dead prefix", () => {
    expect(isBurnAddress("0xdead000000000000000000000000000000000000")).toBe(
      true,
    );
  });
  it("returns true for zero address (also a burn sink)", () => {
    expect(isBurnAddress("0x0000000000000000000000000000000000000000")).toBe(
      true,
    );
  });
  it("returns false for a normal address", () => {
    expect(isBurnAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe(
      false,
    );
  });
});

describe("isValidAddress", () => {
  it("accepts valid EVM checksummed address", () => {
    expect(isValidAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe(
      true,
    );
  });
  it("rejects short EVM address", () => {
    expect(isValidAddress("0x1234")).toBe(false);
  });
  it("rejects invalid hex characters", () => {
    expect(isValidAddress("0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toBe(
      false,
    );
  });
  it("rejects unsupported namespaces instead of accepting arbitrary addresses", () => {
    expect(isValidAddress("anything", "unknown")).toBe(false);
  });
  it("accepts valid Solana base58 address", () => {
    expect(
      isValidAddress("7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtPb", "solana"),
    ).toBe(true);
  });
  it("rejects short Solana address", () => {
    expect(isValidAddress("abc", "solana")).toBe(false);
  });
  it("accepts valid XRPL classic address", () => {
    expect(isValidAddress("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", "xrpl")).toBe(
      true,
    );
  });
  it("accepts valid XRPL X-address and destination-tag form", () => {
    expect(
      isValidAddress("X7d3eHCXzwBeWrZec1yT24iZerQjYLeTFXz1GU9RBnWr7gZ", "xrpl"),
    ).toBe(true);
    expect(
      isValidAddress("rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY-495", "xrpl"),
    ).toBe(true);
  });
  it("rejects invalid XRPL address (wrong prefix)", () => {
    expect(isValidAddress("xHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", "xrpl")).toBe(
      false,
    );
  });
  it("returns false for non-string input", () => {
    expect(isValidAddress("", "eip155")).toBe(false);
  });
});

describe("isBurnAddress — unified with appkit-core destination semantics", () => {
  it("covers sinks, vanity prefixes, and dead anywhere; not an ordinary address", () => {
    for (const burn of [
      "0x0000000000000000000000000000000000000001",
      "0x000000000000000000000000000000000000dEaD",
      "0xdeaf000000000000000000000000000000000000",
      "0x00dead000000000000000000000000000000abcd",
    ]) {
      expect(isBurnAddress(burn)).toBe(true);
    }
    expect(isBurnAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe(
      false,
    );
  });
});

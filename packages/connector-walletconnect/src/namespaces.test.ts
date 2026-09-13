import { describe, expect, it } from "vitest";
import { buildCAIP10, parseCAIP10, resolveCAIP10 } from "./namespaces";

describe("CAIP-10 helpers", () => {
  it("keeps the EIP-155 0x address prefix", () => {
    const address = "0x" + "Ab".repeat(20);
    expect(buildCAIP10("eip155", "1", address)).toBe(`eip155:1:${address}`);
    expect(buildCAIP10("eip155", "1", address.slice(2))).toBe(
      `eip155:1:${address}`,
    );
  });

  it("resolves a plain EVM address to a standards-compliant account ID", () => {
    const address = "0x" + "12".repeat(20);
    expect(
      resolveCAIP10(address, {
        eip155: { chains: ["eip155:1"], accounts: [] },
      }),
    ).toBe(`eip155:1:${address}`);
  });

  it("accepts the CAIP-10 chain 0 off-chain EOA form", () => {
    const address = "0x" + "34".repeat(20);
    expect(buildCAIP10("eip155", "0", address)).toBe(`eip155:0:${address}`);
    expect(parseCAIP10(`eip155:0:${address}`)).toEqual({
      namespace: "eip155",
      chainId: "0",
      address,
    });
  });

  it("rejects malformed EIP-155 account IDs instead of guessing", () => {
    expect(() => buildCAIP10("eip155", "1", "0x1234")).toThrow();
    expect(() => resolveCAIP10("0x" + "12".repeat(20), {})).toThrow(
      "without a matching namespace",
    );
  });
});

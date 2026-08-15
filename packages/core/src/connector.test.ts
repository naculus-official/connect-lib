import { describe, expect, it } from "vitest";
import { extractAccounts } from "./connector";
import type { SessionNamespace } from "./session";

describe("extractAccounts", () => {
  it("should extract accounts from all namespaces", () => {
    const namespaces = {
      eip155: {
        chains: ["eip155:1"],
        accounts: ["eip155:1:0x123", "eip155:1:0x456"],
        methods: [],
        events: [],
      } as SessionNamespace,
      solana: {
        chains: ["solana:1"],
        accounts: ["solana:1:abc123"],
        methods: [],
        events: [],
      } as SessionNamespace,
    };

    const accounts = extractAccounts(namespaces);

    expect(accounts).toHaveLength(3);
    expect(accounts).toContain("eip155:1:0x123");
    expect(accounts).toContain("eip155:1:0x456");
    expect(accounts).toContain("solana:1:abc123");
  });

  it("should return empty array when no namespaces", () => {
    const accounts = extractAccounts({});
    expect(accounts).toHaveLength(0);
  });
});


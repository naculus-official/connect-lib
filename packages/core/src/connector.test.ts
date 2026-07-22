import { describe, expect, it } from "vitest";
import {
  extractAccounts,
  getChainsFromNamespaces,
  getEventsFromNamespaces,
  getMethodsFromNamespaces,
} from "./connector";
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

describe("getChainsFromNamespaces", () => {
  it("should extract unique chains from all namespaces", () => {
    const namespaces = {
      eip155: {
        chains: ["eip155:1", "eip155:5"],
        accounts: [],
        methods: [],
        events: [],
      } as SessionNamespace,
      solana: {
        chains: ["solana:1"],
        accounts: [],
        methods: [],
        events: [],
      } as SessionNamespace,
    };

    const chains = getChainsFromNamespaces(namespaces);

    expect(chains).toHaveLength(3);
    expect(chains).toContain("eip155:1");
    expect(chains).toContain("eip155:5");
    expect(chains).toContain("solana:1");
  });
});

describe("getMethodsFromNamespaces", () => {
  it("should extract unique methods from all namespaces", () => {
    const namespaces = {
      eip155: {
        chains: [],
        accounts: [],
        methods: ["eth_requestAccounts", "personal_sign"],
        events: [],
      } as SessionNamespace,
    };

    const methods = getMethodsFromNamespaces(namespaces);

    expect(methods).toHaveLength(2);
    expect(methods).toContain("eth_requestAccounts");
    expect(methods).toContain("personal_sign");
  });
});

describe("getEventsFromNamespaces", () => {
  it("should extract unique events from all namespaces", () => {
    const namespaces = {
      eip155: {
        chains: [],
        accounts: [],
        methods: [],
        events: ["accountsChanged", "chainChanged"],
      } as SessionNamespace,
    };

    const events = getEventsFromNamespaces(namespaces);

    expect(events).toHaveLength(2);
    expect(events).toContain("accountsChanged");
    expect(events).toContain("chainChanged");
  });
});

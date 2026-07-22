import { describe, expect, it } from "vitest";
import type { CAIP25NamespaceProposal, CAIP25SessionProposal } from "./caip25";
import {
  isValidCAIP2,
  validateCAIP25Namespace,
  validateCAIP25Proposal,
} from "./caip25";

describe("isValidCAIP2", () => {
  it("should accept valid CAIP-2 chain IDs", () => {
    expect(isValidCAIP2("eip155:1")).toBe(true);
    expect(isValidCAIP2("eip155:11155111")).toBe(true);
    expect(isValidCAIP2("solana:0")).toBe(true);
    expect(isValidCAIP2("xrpl:0")).toBe(true);
    expect(isValidCAIP2("cosmos:cosmoshub-4")).toBe(true);
  });

  it("should reject invalid CAIP-2 chain IDs", () => {
    expect(isValidCAIP2("")).toBe(false);
    expect(isValidCAIP2("no-colon")).toBe(false);
    expect(isValidCAIP2(":empty")).toBe(false);
    expect(isValidCAIP2("eip155:")).toBe(false);
    expect(isValidCAIP2("eip 155:1")).toBe(false);
  });
});

describe("validateCAIP25Namespace", () => {
  it("should return no errors for valid required namespace", () => {
    const errors = validateCAIP25Namespace(
      "eip155",
      {
        chains: ["eip155:1", "eip155:137"],
        methods: ["personal_sign", "eth_sendTransaction"],
        events: ["accountsChanged", "chainChanged"],
      },
      true,
    );
    expect(errors).toHaveLength(0);
  });

  it("should return error when required namespace has no chains", () => {
    const errors = validateCAIP25Namespace(
      "eip155",
      {
        chains: [],
        methods: ["personal_sign"],
        events: ["accountsChanged"],
      },
      true,
    );
    expect(errors).toContain('Namespace "eip155": chains are required');
  });

  it("should return error when required namespace has no methods", () => {
    const errors = validateCAIP25Namespace(
      "solana",
      {
        chains: ["solana:0"],
        methods: [],
        events: ["accountChanged"],
      },
      true,
    );
    expect(errors).toContain('Namespace "solana": methods are required');
  });

  it("should return error when events array is missing", () => {
    const errors = validateCAIP25Namespace(
      "eip155",
      {
        chains: ["eip155:1"],
        methods: ["personal_sign"],
      } as CAIP25NamespaceProposal,
      true,
    );
    expect(errors).toContain('Namespace "eip155": events array is required');
  });

  it("should return error for invalid CAIP-2 chain", () => {
    const errors = validateCAIP25Namespace(
      "eip155",
      {
        chains: ["eip155:1", "bad-chain"],
        methods: ["personal_sign"],
        events: ["accountsChanged"],
      },
      true,
    );
    expect(errors).toContain(
      'Namespace "eip155": invalid CAIP-2 chain "bad-chain"',
    );
  });

  it("should allow optional namespaces without chains", () => {
    const errors = validateCAIP25Namespace(
      "eip155",
      {
        methods: ["personal_sign"],
        events: ["accountsChanged"],
      } as CAIP25NamespaceProposal,
      false,
    );
    expect(errors).toHaveLength(0);
  });

  it("should allow optional namespaces without methods", () => {
    const errors = validateCAIP25Namespace(
      "eip155",
      {
        chains: ["eip155:137"],
        events: ["accountsChanged"],
      } as CAIP25NamespaceProposal,
      false,
    );
    expect(errors).toHaveLength(0);
  });
});

describe("validateCAIP25Proposal", () => {
  it("should return valid for a complete proposal", () => {
    const proposal: CAIP25SessionProposal = {
      requiredNamespaces: {
        eip155: {
          chains: ["eip155:1"],
          methods: ["personal_sign"],
          events: ["accountsChanged"],
        },
      },
    };
    const result = validateCAIP25Proposal(proposal);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should return error for empty requiredNamespaces", () => {
    const result = validateCAIP25Proposal({
      requiredNamespaces: {},
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "requiredNamespaces is required and cannot be empty",
    );
  });

  it("should return error for missing requiredNamespaces", () => {
    const result = validateCAIP25Proposal({} as CAIP25SessionProposal);
    expect(result.valid).toBe(false);
  });

  it("should return errors for invalid required namespace", () => {
    const proposal: CAIP25SessionProposal = {
      requiredNamespaces: {
        eip155: {
          chains: ["invalid"],
          methods: [],
          events: ["accountsChanged"],
        },
      },
    };
    const result = validateCAIP25Proposal(proposal);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("should validate multiple namespaces", () => {
    const proposal: CAIP25SessionProposal = {
      requiredNamespaces: {
        eip155: {
          chains: ["eip155:1"],
          methods: ["personal_sign"],
          events: ["accountsChanged"],
        },
        solana: {
          chains: ["solana:0"],
          methods: ["solana_signMessage"],
          events: ["accountChanged"],
        },
      },
    };
    const result = validateCAIP25Proposal(proposal);
    expect(result.valid).toBe(true);
  });

  it("should produce warnings for optional namespaces not in required", () => {
    const proposal: CAIP25SessionProposal = {
      requiredNamespaces: {
        eip155: {
          chains: ["eip155:1"],
          methods: ["personal_sign"],
          events: ["accountsChanged"],
        },
      },
      optionalNamespaces: {
        solana: {
          chains: [],
          methods: ["solana_signMessage"],
        } as CAIP25NamespaceProposal,
      },
    };
    const result = validateCAIP25Proposal(proposal);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("should not warn for optional namespaces that exist in required", () => {
    const proposal: CAIP25SessionProposal = {
      requiredNamespaces: {
        eip155: {
          chains: ["eip155:1"],
          methods: ["personal_sign"],
          events: ["accountsChanged"],
        },
      },
      optionalNamespaces: {
        eip155: {
          chains: ["eip155:137"],
          methods: ["personal_sign"],
          events: ["accountsChanged"],
        },
      },
    };
    const result = validateCAIP25Proposal(proposal);
    expect(result.valid).toBe(true);
  });

  it("should collect all errors across all namespaces", () => {
    const proposal: CAIP25SessionProposal = {
      requiredNamespaces: {
        eip155: {
          chains: [],
          methods: [],
          events: [],
        },
        solana: {
          chains: [],
          methods: [],
          events: [],
        },
      },
    };
    const result = validateCAIP25Proposal(proposal);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });
});

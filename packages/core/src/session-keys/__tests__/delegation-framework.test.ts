import { describe, expect, it } from "vitest";
import {
  ANY_DELEGATE,
  buildDelegation,
  caveatsFromScope,
  DELEGATION_FRAMEWORK,
  delegationHash,
  delegationSigningDigest,
  delegationTypedData,
  ROOT_AUTHORITY,
} from "../delegation-framework";
import type { SessionKeyScope } from "../types";

/**
 * Independent vectors: terms from MetaMask's own @metamask/delegation-core
 * 3.0.0 (`create*Terms`), the struct hash from its `hashDelegation`, and the
 * EIP-712 digest from viem 2.56.5 `hashTypedData` — computed in a throwaway
 * script outside this repo's dependencies. The same comparison over 7 chains
 * × 2 scopes (112 checks) matched on 2026-09-25.
 */
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const PAYEE = "0x2222222222222222222222222222222222222222" as const;
const OWNER = "0xe239cdc5fbe977a8a141b72194d3cf8c41bc5bc6" as const;
const KEY = "0x742d35cc6634c0532925a3b844bc9e7595f2bd18" as const;
const E = DELEGATION_FRAMEWORK.enforcers;

const paymentScope: SessionKeyScope = {
  mode: "eip7702",
  expiry: 1_790_000_000,
  allowedContracts: [USDC],
  allowedMethods: ["0xa9059cbb"],
  tokenAllowances: { [USDC]: 5_000_000n },
  allowedRecipients: [PAYEE],
  maxTxCount: 20,
};

const EXPECTED_TERMS = [
  "0x000000000000000000000000000000000000000000000000000000006ab13b80",
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "0xa9059cbb",
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000000004c4b40",
  "0x0000000000000000000000000000000000000000000000000000000000000000",
  "0x00000000000000000000000000000000000000000000000000000000000000040000000000000000000000002222222222222222222222222222222222222222",
  "0x0000000000000000000000000000000000000000000000000000000000000014",
  "0x742d35cc6634c0532925a3b844bc9e7595f2bd18",
];

describe("delegation framework: encoding", () => {
  it("encodes a payment scope exactly as MetaMask's own builders do", () => {
    const caveats = caveatsFromScope(paymentScope, 8453, {
      delegator: OWNER,
      delegate: KEY,
    });
    expect(caveats.map((c) => c.enforcer)).toEqual([
      E.timestamp,
      E.allowedTargets,
      E.allowedMethods,
      E.erc20TransferAmount,
      E.valueLte,
      E.allowedCalldata,
      E.limitedCalls,
      E.redeemer,
    ]);
    expect(caveats.map((c) => c.terms.toLowerCase())).toEqual(EXPECTED_TERMS);
    expect(caveats.every((c) => c.args === "0x")).toBe(true);
  });

  it("hashes and digests the delegation as the framework and viem do", () => {
    const delegation = buildDelegation({
      delegator: OWNER,
      delegate: KEY,
      scope: paymentScope,
      chainId: 8453,
      salt: 12345n,
    });
    expect(delegation.authority).toBe(ROOT_AUTHORITY);
    expect(delegationHash(delegation)).toBe(
      "0xd32458e56ef36142d9daa136683d37ce3e6aca1050606cf173e5bce19d17475b",
    );
    expect(delegationSigningDigest(delegation)).toBe(
      "0x2812e665c586d4fc1d1a69a5f6a1034e64d298512eb3ca13673fc65c6e311648",
    );
    // The typed data a wallet signs names the same domain and message.
    const typed = delegationTypedData(delegation);
    expect(typed.domain).toEqual({
      name: "DelegationManager",
      version: "1",
      chainId: 8453,
      verifyingContract: DELEGATION_FRAMEWORK.delegationManager,
    });
    expect(typed.message.salt).toBe("12345");
  });

  it("signs only for the chain the scope was checked against", () => {
    const base = buildDelegation({
      delegator: OWNER,
      delegate: KEY,
      scope: paymentScope,
      chainId: 8453,
      salt: 1n,
    });
    const sepolia = buildDelegation({
      delegator: OWNER,
      delegate: KEY,
      scope: paymentScope,
      chainId: 84532,
      salt: 1n,
    });
    expect(delegationSigningDigest(base)).not.toBe(
      delegationSigningDigest(sepolia),
    );
    expect(delegationTypedData(sepolia).domain.chainId).toBe(84532);
    // A delegation re-labelled for another chain is not signable there
    // unless that chain is supported; its scope was never checked for it.
    expect(() => delegationSigningDigest({ ...base, chainId: 56 })).toThrow(
      expect.objectContaining({ code: "session_key_invalid_input" }),
    );
  });

  it("encodes native value limits for a non-token scope", () => {
    const caveats = caveatsFromScope(
      {
        mode: "eip7702",
        expiry: 1_800_000_000,
        allowedContracts: [PAYEE],
        allowedMethods: ["0x12345678"],
        maxValuePerTx: 10n ** 16n,
        maxTotalValue: 10n ** 17n,
      },
      1,
      { delegator: OWNER, delegate: KEY },
    );
    expect(caveats.map((c) => c.enforcer)).toEqual([
      E.timestamp,
      E.allowedTargets,
      E.allowedMethods,
      E.valueLte,
      E.nativeTokenTransferAmount,
      E.redeemer,
    ]);
  });

  it("uses a random salt by default", () => {
    const input = {
      delegator: OWNER,
      delegate: KEY,
      scope: paymentScope,
      chainId: 8453,
    } as const;
    expect(buildDelegation(input).salt).not.toBe(buildDelegation(input).salt);
  });
});

describe("delegation framework: refusals", () => {
  const cases: Array<[string, Partial<SessionKeyScope>, number, RegExp]> = [
    ["an offchain scope", { mode: "offchain" }, 8453, /mode/],
    ["an unsupported chain", {}, 56, /not a supported/],
    [
      "a chain outside allowedChainIds",
      { allowedChainIds: [1] },
      8453,
      /allowedChainIds/,
    ],
    [
      "no allowedContracts",
      { allowedContracts: [] },
      8453,
      /allowedContracts is required/,
    ],
    [
      "no allowedMethods",
      { allowedMethods: [] },
      8453,
      /no on-chain deny-list/,
    ],
    [
      "a forbidden selector",
      { allowedMethods: ["0x095ea7b3"] },
      8453,
      /forbidden/,
    ],
    [
      "a malformed selector",
      { allowedMethods: ["0xa9059c"] },
      8453,
      /4-byte selector/,
    ],
    [
      "two token allowances",
      { tokenAllowances: { [USDC]: 1n, [PAYEE]: 1n } },
      8453,
      /more than one token/,
    ],
    [
      "two recipients",
      { allowedRecipients: [PAYEE, OWNER] },
      8453,
      /more than one recipient/,
    ],
    [
      "a recipient without a token",
      {
        tokenAllowances: {},
        allowedContracts: [PAYEE],
        allowedMethods: ["0x12345678"],
      },
      8453,
      /needs a single token/,
    ],
    [
      "a token scope that also allows other contracts",
      { allowedContracts: [USDC, PAYEE] },
      8453,
      /exactly \[token\]/,
    ],
    [
      "a token scope with another method",
      { allowedMethods: ["0xa9059cbb", "0x23b872dd"] },
      8453,
      /transfer\(\) only/,
    ],
    [
      "a zero token allowance",
      { tokenAllowances: { [USDC]: 0n } },
      8453,
      /positive/,
    ],
    ["no expiry", { expiry: 0 }, 8453, /expiry/],
    ["a zero call limit", { maxTxCount: 0 }, 8453, /maxTxCount/],
  ];

  it.each(cases)("refuses %s", (_name, override, chainId, reason) => {
    expect(() =>
      caveatsFromScope(
        { ...paymentScope, ...override } as SessionKeyScope,
        chainId,
        { delegator: OWNER, delegate: KEY },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "session_key_invalid_input",
        details: expect.stringMatching(reason),
      }),
    );
  });

  it.each([
    ["an open delegation", ANY_DELEGATE],
    ["the zero address", "0x0000000000000000000000000000000000000000"],
    ["the delegator itself", OWNER],
    ["a malformed address", "0x1234"],
  ])("refuses %s as delegate", (_name, delegate) => {
    expect(() =>
      buildDelegation({
        delegator: OWNER,
        delegate: delegate as `0x${string}`,
        scope: paymentScope,
        chainId: 8453,
      }),
    ).toThrow(expect.objectContaining({ code: "session_key_invalid_input" }));
  });

  it.each([
    ["the owner's own account", OWNER],
    ["the DelegationManager", DELEGATION_FRAMEWORK.delegationManager],
  ])("refuses %s as an allowed contract", (_name, target) => {
    // A redemption calling either escapes every caveat.
    expect(() =>
      buildDelegation({
        delegator: OWNER,
        delegate: KEY,
        scope: {
          mode: "eip7702",
          expiry: 1_800_000_000,
          allowedContracts: [PAYEE, target as `0x${string}`],
          allowedMethods: ["0xe9ae5c53"],
          maxTotalValue: 1n,
        },
        chainId: 8453,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "session_key_invalid_input",
        details: expect.stringMatching(/cannot be an allowed contract/),
      }),
    );
  });

  it("applies a configured forbidden-selector list", () => {
    const scope: SessionKeyScope = {
      mode: "eip7702",
      expiry: 1_800_000_000,
      allowedContracts: [PAYEE],
      allowedMethods: ["0xd505accf"],
      maxTotalValue: 1n,
    };
    expect(
      caveatsFromScope(scope, 8453, { delegator: OWNER, delegate: KEY }),
    ).toHaveLength(5);
    expect(() =>
      caveatsFromScope(scope, 8453, {
        delegator: OWNER,
        delegate: KEY,
        forbiddenMethods: ["0xD505ACCF"],
      }),
    ).toThrow(
      expect.objectContaining({ details: expect.stringMatching(/forbidden/) }),
    );
  });

  it("requires a native value limit on a non-token scope", () => {
    expect(() =>
      caveatsFromScope(
        {
          mode: "eip7702",
          expiry: 1_800_000_000,
          allowedContracts: [PAYEE],
          allowedMethods: ["0x12345678"],
        },
        8453,
        { delegator: OWNER, delegate: KEY },
      ),
    ).toThrow(
      expect.objectContaining({
        details: expect.stringMatching(/native value limit/),
      }),
    );
  });

  it("refuses non-bigint amounts and an out-of-range salt", () => {
    expect(() =>
      caveatsFromScope(
        {
          ...paymentScope,
          tokenAllowances: { [USDC]: 1.5 as unknown as bigint },
        },
        8453,
        { delegator: OWNER, delegate: KEY },
      ),
    ).toThrow(expect.objectContaining({ code: "session_key_invalid_input" }));
    expect(() =>
      buildDelegation({
        delegator: OWNER,
        delegate: KEY,
        scope: paymentScope,
        chainId: 8453,
        salt: 1n << 256n,
      }),
    ).toThrow(
      expect.objectContaining({ details: expect.stringMatching(/salt/) }),
    );
  });

  it("accepts any supported chain when allowedChainIds is empty", () => {
    expect(() =>
      caveatsFromScope({ ...paymentScope, allowedChainIds: [] }, 137, {
        delegator: OWNER,
        delegate: KEY,
      }),
    ).not.toThrow();
  });

  it.each([
    ["Permit2 approve", "0x87517c45"],
    ["EntryPoint withdrawTo", "0x205c2878"],
  ])("refuses %s in this mode", (_name, selector) => {
    expect(() =>
      caveatsFromScope(
        {
          mode: "eip7702",
          expiry: 1_800_000_000,
          allowedContracts: [PAYEE],
          allowedMethods: [selector],
          maxTotalValue: 1n,
        },
        8453,
        { delegator: OWNER, delegate: KEY },
      ),
    ).toThrow(
      expect.objectContaining({ details: expect.stringMatching(/forbidden/) }),
    );
  });

  it("requires the delegator, so no path skips the self-target check", () => {
    expect(() => caveatsFromScope(paymentScope, 8453, {} as never)).toThrow(
      expect.objectContaining({
        details: expect.stringMatching(/delegator is required/),
      }),
    );
  });

  it("returns a frozen delegation that cannot be relabelled in place", () => {
    const delegation = buildDelegation({
      delegator: OWNER,
      delegate: KEY,
      scope: paymentScope,
      chainId: 8453,
    });
    expect(Object.isFrozen(delegation)).toBe(true);
    expect(Object.isFrozen(delegation.caveats)).toBe(true);
    expect(() => {
      (delegation as { chainId: number }).chainId = 1;
    }).toThrow(TypeError);
  });

  it("pins the session key as the only redeemer", () => {
    // A re-delegation the key could be tricked into signing names another
    // redeemer; RedeemerEnforcer makes the root delegation refuse it.
    const caveats = caveatsFromScope(paymentScope, 8453, {
      delegator: OWNER,
      delegate: KEY,
    });
    expect(caveats.at(-1)).toEqual({
      enforcer: E.redeemer,
      terms: KEY,
      args: "0x",
    });
    expect(() =>
      caveatsFromScope(paymentScope, 8453, { delegator: OWNER } as never),
    ).toThrow(
      expect.objectContaining({
        details: expect.stringMatching(/delegate is required/),
      }),
    );
  });
});

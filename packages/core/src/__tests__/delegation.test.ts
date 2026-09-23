import { describe, expect, it, vi } from "vitest";
import {
  delegateAccount,
  type PrepareDelegationInput,
  prepareDelegationAuthorization,
  REVOKE_DELEGATE,
  readDelegation,
  revokeDelegation,
  type SelfDelegationRequest,
  UNKNOWN_DELEGATION,
} from "../delegation";
import type { UniversalWalletSession } from "../session";

const DELEGATE = "0x1234567890abcdef1234567890abcdef12345678";
const DELEGATED_CODE = `0xef0100${DELEGATE.slice(2)}`;

describe("readDelegation", () => {
  it("reads the delegate out of a delegation designator", () => {
    expect(readDelegation(DELEGATED_CODE)).toEqual({
      delegated: true,
      delegate: DELEGATE,
    });
  });

  it("is case-insensitive about the prefix", () => {
    expect(
      readDelegation(DELEGATED_CODE.toUpperCase().replace("0X", "0x"))
        .delegated,
    ).toBe(true);
  });

  it("reports an empty account as not delegated", () => {
    expect(readDelegation("0x")).toEqual({ delegated: false, delegate: null });
  });

  it("reports ordinary contract code as not delegated", () => {
    expect(readDelegation(`0x60806040${"ab".repeat(64)}`).delegated).toBe(
      false,
    );
  });

  // 23 bytes of ordinary code is not a delegation. Contracts that short are
  // vanishingly rare but nothing rules them out.
  it("does not match 23 bytes that lack the prefix", () => {
    expect(readDelegation(`0xdeadbe${"11".repeat(20)}`).delegated).toBe(false);
  });

  // The spec allows delegating to the zero address to clear a delegation.
  it("treats a cleared delegation as not delegated", () => {
    expect(readDelegation(`0xef0100${"0".repeat(40)}`)).toEqual({
      delegated: false,
      delegate: null,
    });
  });

  // Treating a failed read as "no delegation" is how an account that can
  // batch gets sent down the path for one that cannot.
  it("answers unknown for anything that was not read as code", () => {
    for (const bad of [undefined, null, "", "not-hex", "0xzz", 42, {}]) {
      expect(readDelegation(bad)).toEqual(UNKNOWN_DELEGATION);
    }
  });

  it("answers unknown for an odd-length hex string", () => {
    expect(readDelegation("0xabc").delegated).toBeNull();
  });
});

describe("prepareDelegationAuthorization", () => {
  const ACCOUNT = "0xe239cdc5fbe977a8a141B72194D3CF8c41bC5BC6";
  const IMPL = "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
  const base = (
    over: Partial<PrepareDelegationInput> = {},
  ): PrepareDelegationInput => ({
    account: ACCOUNT,
    chainId: "eip155:1",
    delegate: IMPL,
    allowlist: [IMPL],
    sender: "relayer",
    getTransactionCount: async () => "0x7",
    ...over,
  });

  it("uses the pending nonce when someone else sends the type-4 transaction", async () => {
    await expect(prepareDelegationAuthorization(base())).resolves.toEqual({
      account: ACCOUNT,
      chainId: "eip155:1",
      address: IMPL,
      nonce: "0x7",
    });
  });

  it("adds one when the account sends the type-4 transaction itself", async () => {
    const request = await prepareDelegationAuthorization(
      base({ sender: "self" }),
    );
    expect(request.nonce).toBe("0x8");
    // The transaction's own nonce comes from the same read.
    expect(request.transactionNonce).toBe("0x7");
  });

  it("returns no transaction nonce when a relayer sends", async () => {
    const request = await prepareDelegationAuthorization(base());
    expect(request.transactionNonce).toBeUndefined();
  });

  it.each([undefined, "Self", "sponsor"])(
    "refuses an unknown sender %#",
    async (sender) => {
      await expect(
        prepareDelegationAuthorization(
          base({ sender: sender as PrepareDelegationInput["sender"] }),
        ),
      ).rejects.toMatchObject({ code: "invalid_input" });
    },
  );

  it("accepts a bigint nonce", async () => {
    const request = await prepareDelegationAuthorization(
      base({ getTransactionCount: async () => 7n }),
    );
    expect(request.nonce).toBe("0x7");
  });

  it("reports a failed nonce read as rpc_error", async () => {
    await expect(
      prepareDelegationAuthorization(
        base({
          getTransactionCount: async () => {
            throw new Error("socket hang up");
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "rpc_error" });
  });

  it("reads the nonce for the delegating account, pending", async () => {
    const calls: unknown[][] = [];
    await prepareDelegationAuthorization(
      base({
        getTransactionCount: async (...args) => {
          calls.push(args);
          return 7;
        },
      }),
    );
    expect(calls).toEqual([[ACCOUNT, "pending"]]);
  });

  it("refuses a delegate outside the allowlist, and allows nothing by default", async () => {
    await expect(
      prepareDelegationAuthorization(base({ allowlist: [] })),
    ).rejects.toMatchObject({ code: "method_not_allowed" });
    await expect(
      prepareDelegationAuthorization(
        base({ allowlist: ["0x1111111111111111111111111111111111111111"] }),
      ),
    ).rejects.toMatchObject({ code: "method_not_allowed" });
  });

  it("ignores malformed allowlist entries", async () => {
    await expect(
      prepareDelegationAuthorization(
        base({ allowlist: [` ${IMPL}`, `${IMPL}\n`, "0X" + IMPL.slice(2)] }),
      ),
    ).rejects.toMatchObject({ code: "method_not_allowed" });
  });

  it("matches allowlist entries case-insensitively", async () => {
    await expect(
      prepareDelegationAuthorization(base({ allowlist: [IMPL.toLowerCase()] })),
    ).resolves.toMatchObject({ address: IMPL });
  });

  it("always allows revoking, even with an empty allowlist", async () => {
    await expect(
      prepareDelegationAuthorization(
        base({ delegate: REVOKE_DELEGATE, allowlist: [] }),
      ),
    ).resolves.toMatchObject({ address: REVOKE_DELEGATE });
  });

  it.each([
    "eip155:0",
    "eip155:01",
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "1",
  ])("refuses chain %s", async (chainId) => {
    await expect(
      prepareDelegationAuthorization(base({ chainId })),
    ).rejects.toMatchObject({
      code: "invalid_chain",
    });
  });

  it.each([undefined, null, "", "7", "0x", -1, 1.5, Number.NaN, {}])(
    "fails closed on an unreadable nonce %#",
    async (count) => {
      await expect(
        prepareDelegationAuthorization(
          base({ getTransactionCount: async () => count }),
        ),
      ).rejects.toMatchObject({ code: "rpc_error" });
    },
  );

  it("accepts the largest nonce EIP-7702 can carry", async () => {
    const request = await prepareDelegationAuthorization(
      base({
        sender: "self",
        getTransactionCount: async () => "0xfffffffffffffffd",
      }),
    );
    expect(request.nonce).toBe("0xfffffffffffffffe");
  });

  it("refuses a nonce that EIP-7702 cannot carry", async () => {
    await expect(
      prepareDelegationAuthorization(
        base({
          sender: "self",
          getTransactionCount: async () => "0xfffffffffffffffe",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses malformed addresses", async () => {
    await expect(
      prepareDelegationAuthorization(base({ account: "0x1234" })),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      prepareDelegationAuthorization(
        base({ delegate: "0x1234", allowlist: ["0x1234"] }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("delegateAccount", () => {
  const ACCOUNT = "0xe239cdc5fbe977a8a141B72194D3CF8c41bC5BC6";
  const IMPL = "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
  const HASH = `0x${"ab".repeat(32)}` as const;
  const session = { id: "embedded-1" } as unknown as UniversalWalletSession;

  function connector() {
    const sendDelegation = vi.fn(
      async (_s: UniversalWalletSession, request: SelfDelegationRequest) => ({
        hash: HASH,
        authorization: {
          ...request,
          yParity: 0 as const,
          r: `0x${"11".repeat(32)}` as const,
          s: `0x${"22".repeat(32)}` as const,
        },
      }),
    );
    return { sendDelegation };
  }

  const input = (over: Record<string, unknown> = {}) => ({
    account: ACCOUNT as `0x${string}`,
    chainId: "eip155:1",
    delegate: IMPL as `0x${string}`,
    allowlist: [IMPL],
    getTransactionCount: async () => "0x6",
    session,
    ...over,
  });

  it("sends a self-sponsored request: transaction nonce, authorization one above", async () => {
    const c = connector();
    const sent = await delegateAccount({ ...input(), connector: c });
    expect(sent.hash).toBe(HASH);
    expect(c.sendDelegation).toHaveBeenCalledWith(session, {
      account: ACCOUNT,
      chainId: "eip155:1",
      address: IMPL,
      nonce: "0x7",
      transactionNonce: "0x6",
    });
  });

  it("refuses a connector without sendDelegation before reading the nonce", async () => {
    const getTransactionCount = vi.fn(async () => "0x6");
    await expect(
      delegateAccount({
        ...input({ getTransactionCount }),
        connector: {},
      }),
    ).rejects.toMatchObject({ code: "method_unsupported" });
    expect(getTransactionCount).not.toHaveBeenCalled();
  });

  it("refuses a delegate outside the allowlist without calling the connector", async () => {
    const c = connector();
    await expect(
      delegateAccount({ ...input({ allowlist: [] }), connector: c }),
    ).rejects.toMatchObject({ code: "method_not_allowed" });
    expect(c.sendDelegation).not.toHaveBeenCalled();
  });

  it("revokes to address(0) whatever the allowlist", async () => {
    const c = connector();
    await revokeDelegation({
      account: ACCOUNT,
      chainId: "eip155:1",
      getTransactionCount: async () => "0x6",
      session,
      connector: c,
    });
    expect(c.sendDelegation.mock.calls[0]?.[1].address).toBe(REVOKE_DELEGATE);
  });
});

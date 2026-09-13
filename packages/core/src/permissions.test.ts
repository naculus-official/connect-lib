import { describe, expect, it, vi } from "vitest";
import {
  extractAccountsFromPermissions,
  getPermissions,
  hasPermission,
  requestPermissions,
} from "./permissions";
import type { WalletPermission } from "./permissions";

/**
 * EIP-2255 permission handling gates which accounts a dApp may see. It had no
 * test file at all (42.1% statements, reached only incidentally), so the
 * cases where it returns "nothing" — an unsupported wallet, an empty grant, a
 * missing caveat — were never pinned down. Those are precisely the paths a
 * caller must be able to distinguish from "permission granted".
 */

const provider = (impl: () => Promise<unknown>) => ({ request: vi.fn(impl) });

const ethAccounts = (accounts: string[]): WalletPermission =>
  ({
    parentCapability: "eth_accounts",
    caveats: [{ type: "restrictReturnedAccounts", value: accounts }],
  }) as WalletPermission;

describe("getPermissions", () => {
  it("returns the granted permissions", async () => {
    const p = provider(async () => [ethAccounts(["0xabc"])]);
    await expect(getPermissions(p)).resolves.toHaveLength(1);
    expect(p.request).toHaveBeenCalledWith({ method: "wallet_getPermissions" });
  });

  it("returns null when the wallet does not implement EIP-2255", async () => {
    // Rejecting must not propagate: a wallet without the method is a normal
    // outcome, not an error the caller should have to catch.
    await expect(
      getPermissions(provider(async () => Promise.reject(new Error("no method")))),
    ).resolves.toBeNull();
  });

  it.each([[[]], [null], [undefined]])(
    "returns null for an empty grant (%p)",
    async (value) => {
      await expect(
        getPermissions(provider(async () => value)),
      ).resolves.toBeNull();
    },
  );
});

describe("requestPermissions", () => {
  it("asks for eth_accounts specifically", async () => {
    const p = provider(async () => [ethAccounts(["0xabc"])]);
    await requestPermissions(p);
    expect(p.request).toHaveBeenCalledWith({
      method: "wallet_requestPermissions",
      params: [{ eth_accounts: {} }],
    });
  });

  it("propagates a user rejection rather than swallowing it", async () => {
    // Unlike getPermissions, this one is user-initiated: a rejection is a
    // decision the caller needs to see.
    await expect(
      requestPermissions(provider(async () => Promise.reject(new Error("User rejected")))),
    ).rejects.toThrow(/User rejected/);
  });
});

describe("extractAccountsFromPermissions", () => {
  it("reads the restricted account list", () => {
    expect(
      extractAccountsFromPermissions([ethAccounts(["0xabc", "0xdef"])]),
    ).toEqual(["0xabc", "0xdef"]);
  });

  it("returns empty when eth_accounts was never granted", () => {
    expect(
      extractAccountsFromPermissions([
        { parentCapability: "endowment:permitted-chains" } as WalletPermission,
      ]),
    ).toEqual([]);
  });

  it.each([
    ["no caveats", { parentCapability: "eth_accounts" }],
    ["unrelated caveat", { parentCapability: "eth_accounts", caveats: [{ type: "other", value: ["0xabc"] }] }],
    ["non-array value", { parentCapability: "eth_accounts", caveats: [{ type: "restrictReturnedAccounts", value: "0xabc" }] }],
  ])("returns empty rather than guessing when the caveat is %s", (_l, perm) => {
    expect(extractAccountsFromPermissions([perm as WalletPermission])).toEqual([]);
  });
});

describe("hasPermission", () => {
  it("reports a granted capability", () => {
    expect(hasPermission([ethAccounts(["0xabc"])], "eth_accounts")).toBe(true);
  });

  it("reports an ungranted capability", () => {
    expect(hasPermission([ethAccounts(["0xabc"])], "endowment:x")).toBe(false);
  });

  it("treats null as not granted", () => {
    // getPermissions returns null for wallets without EIP-2255; that must not
    // read as "permitted".
    expect(hasPermission(null, "eth_accounts")).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NameResolver } from "../NameResolver";
import { ENSProvider } from "../providers/ens";

const accountA = "0x1111111111111111111111111111111111111111";
const accountB = "0x2222222222222222222222222222222222222222";
const resolver = "0x3333333333333333333333333333333333333333";
const zeroWord = `0x${"0".repeat(64)}` as `0x${string}`;

function encodeAddress(address: string): `0x${string}` {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function encodeString(value: string): `0x${string}` {
  const valueHex = Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const offset = "20".padStart(64, "0");
  const length = (valueHex.length / 2).toString(16).padStart(64, "0");
  return `0x${offset}${length}${valueHex.padEnd(64, "0")}`;
}

function queueRpcResults(...results: Array<`0x${string}`>): void {
  for (const result of results) {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result }),
    } as Response);
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = vi.fn();
});

describe("ENS reverse/forward account binding", () => {
  it("accepts a reverse name only when its forward address matches", async () => {
    // Fingerprint: core/resolver/ens/reverse-name-primary-without-forward-binding
    queueRpcResults(
      encodeAddress(resolver),
      encodeString("owner.eth"),
      encodeAddress(resolver),
      encodeAddress(accountA),
    );

    const result = await new ENSProvider("https://rpc.invalid").lookupAddress(
      accountA,
    );

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(result).toEqual({
      name: "owner.eth",
      chainType: "eip155",
      isPrimary: true,
    });
  });

  it("rejects a reverse name that resolves forward to another account", async () => {
    // Fingerprint: core/resolver/ens/reverse-name-primary-without-forward-binding
    queueRpcResults(
      encodeAddress(resolver),
      encodeString("victim.eth"),
      encodeAddress(resolver),
      encodeAddress(accountB),
    );

    const result = await new ENSProvider("https://rpc.invalid").lookupAddress(
      accountA,
    );

    expect(result).toBeNull();
  });

  it("rejects a reverse name when forward resolution fails", async () => {
    // Fingerprint: core/resolver/ens/reverse-name-primary-without-forward-binding
    queueRpcResults(
      encodeAddress(resolver),
      encodeString("unresolved.eth"),
      zeroWord,
    );

    const result = await new ENSProvider("https://rpc.invalid").lookupAddress(
      accountA,
    );

    expect(result).toBeNull();
  });

  it("does not expose or cache a mismatched canonical name", async () => {
    // Fingerprint: core/resolver/ens/reverse-name-primary-without-forward-binding
    queueRpcResults(
      encodeAddress(resolver),
      encodeString("victim.eth"),
      encodeAddress(resolver),
      encodeAddress(accountB),
    );
    const nameResolver = new NameResolver({
      providers: { ens: { rpcUrl: "https://rpc.invalid" } },
    });

    const first = await nameResolver.lookupAddress(accountA, "eip155:1");
    const second = await nameResolver.lookupAddress(accountA, "eip155:1");

    expect([first, second]).toEqual([null, null]);
  });

  it("returns null for an empty reverse name", async () => {
    queueRpcResults(encodeAddress(resolver), encodeString(""));

    await expect(
      new ENSProvider("https://rpc.invalid").lookupAddress(accountA),
    ).resolves.toBeNull();
  });

  it("returns null for a missing or zero reverse resolver", async () => {
    queueRpcResults(zeroWord);

    await expect(
      new ENSProvider("https://rpc.invalid").lookupAddress(accountA),
    ).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns null for a malformed reverse-name response", async () => {
    queueRpcResults(encodeAddress(resolver), "0x1234");

    await expect(
      new ENSProvider("https://rpc.invalid").lookupAddress(accountA),
    ).resolves.toBeNull();
  });
});

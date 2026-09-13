import { afterEach, describe, expect, it, vi } from "vitest";
import { ERC20TokenHelper } from "./ERC20TokenHelper";

const TOKEN = {
  address: "0x1111111111111111111111111111111111111111" as `0x${string}`,
  chainId: 1,
};

const word = (value: bigint | number): string =>
  BigInt(value).toString(16).padStart(64, "0");

function dynamicString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .padEnd(Math.ceil(bytes.length / 32) * 64, "0");
  return `0x${word(32)}${word(bytes.length)}${hex}`;
}

function bytes32String(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .padEnd(64, "0");
  return `0x${hex}`;
}

afterEach(() => vi.restoreAllMocks());

describe("ERC20TokenHelper metadata decoding", () => {
  it("supports both ABI strings and legacy bytes32 metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as {
          params: [{ data: string }];
        };
        const selector = body.params[0].data.slice(0, 10);
        const result =
          selector === "0x06fdde03"
            ? dynamicString("USD Coin")
            : selector === "0x95d89b41"
              ? bytes32String("USDC")
              : selector === "0x313ce567"
                ? `0x${word(6n)}`
                : `0x${word(1_000_000n)}`;
        return { ok: true, json: async () => ({ result }) } as Response;
      }),
    );

    await expect(
      ERC20TokenHelper.getTokenInfo(TOKEN, { rpcUrl: "https://rpc.example" }),
    ).resolves.toMatchObject({ name: "USD Coin", symbol: "USDC", decimals: 6 });
  });

  it("rejects an out-of-range decimals() response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: `0x${word(256n)}` }),
      }),
    );

    await expect(
      ERC20TokenHelper.getDecimals(
        { ...TOKEN },
        { rpcUrl: "https://rpc.example" },
      ),
    ).rejects.toThrow("out-of-range uint8");
  });

  it("preserves encoding errors from malformed eth_call results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: "0x0" }),
      }),
    );

    await expect(
      ERC20TokenHelper.getTokenInfo(TOKEN, {
        rpcUrl: "https://rpc.example",
      }),
    ).rejects.toMatchObject({ code: "encoding_error" });
  });

  it("does not treat a missing eth_getCode result as deployed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      }),
    );

    await expect(
      ERC20TokenHelper.isTokenDeployed(TOKEN, {
        rpcUrl: "https://rpc.example",
      }),
    ).rejects.toMatchObject({ code: "rpc_error" });
  });
});

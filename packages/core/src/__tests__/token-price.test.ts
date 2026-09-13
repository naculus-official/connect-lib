/**
 * token-price Tests
 *
 * Validates getNativeTokenPriceUsd:
 * - Returns null for unsupported chains
 * - Returns null when no RPC URL provided
 * - Error handling (network failure returns null)
 * - Chainlink ABI-decimal price decoding and round validity
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getNativeTokenPriceUsd } from "../token-price";

function mockAggregator(latestResult: string, decimals = 8): void {
  const decimalsResult = "0x" + BigInt(decimals).toString(16).padStart(64, "0");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const body = JSON.parse((init?.body ?? "{}") as string) as {
      params?: [{ data?: string }];
    };
    const result =
      body.params?.[0]?.data === "0x313ce567" ? decimalsResult : latestResult;
    return {
      ok: true,
      json: () => Promise.resolve({ jsonrpc: "2.0", id: 1, result }),
    } as Response;
  });
}

describe("getNativeTokenPriceUsd", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null for unsupported chain", async () => {
    const price = await getNativeTokenPriceUsd(
      "eip155:999999",
      "https://rpc.example.com",
    );
    expect(price).toBeNull();
  });

  it("returns null for malformed CAIP-2 chain IDs", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const price = await getNativeTokenPriceUsd(
      "eip155:1foo",
      "https://rpc.example.com",
    );
    expect(price).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null when no RPC URL is provided", async () => {
    const price = await getNativeTokenPriceUsd("eip155:1", undefined);
    expect(price).toBeNull();
  });

  it("returns null when RPC URL is empty string", async () => {
    const price = await getNativeTokenPriceUsd("eip155:1", "");
    expect(price).toBeNull();
  });

  it("returns null when RPC URL is null", async () => {
    const price = await getNativeTokenPriceUsd(
      "eip155:1",
      null as unknown as string,
    );
    expect(price).toBeNull();
  });

  it("returns null on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

    const price = await getNativeTokenPriceUsd(
      "eip155:1",
      "https://rpc.example.com",
    );
    expect(price).toBeNull();
  });

  it("returns null on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    const price = await getNativeTokenPriceUsd(
      "eip155:1",
      "https://rpc.example.com",
    );
    expect(price).toBeNull();
  });

  it("returns null on JSON RPC error response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ error: { code: -32000, message: "rate limited" } }),
    } as Response);

    const price = await getNativeTokenPriceUsd(
      "eip155:1",
      "https://rpc.example.com",
    );
    expect(price).toBeNull();
  });

  it("returns null when result is missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: "2.0", id: 1 }),
    } as Response);

    const price = await getNativeTokenPriceUsd(
      "eip155:1",
      "https://rpc.example.com",
    );
    expect(price).toBeNull();
  });

  it("correctly decodes Chainlink 8-decimal price", async () => {
    // Simulate a price of $2000.50 → answer = 200050000000 (8 decimals)
    // Ethereum mainnet feed: 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419
    // The RPC result format: hex-encoded bytes starting with roundId (uint80, padded to 32 bytes),
    // then answer (int256, 32 bytes). The answer is the 2nd 32-byte word starting at offset 64.
    const answerHex = BigInt("200050000000").toString(16).padStart(64, "0"); // $2000.50 with 8 decimals
    const roundIdHex = "1".padStart(64, "0");
    const startedAtHex = "0".padStart(64, "0");
    const updatedAtHex = "1".padStart(64, "0");
    const answeredInRoundHex = "1".padStart(64, "0");
    const hexResult =
      "0x" +
      roundIdHex +
      answerHex +
      startedAtHex +
      updatedAtHex +
      answeredInRoundHex;

    mockAggregator(hexResult);

    const price = await getNativeTokenPriceUsd(
      "eip155:1",
      "https://rpc.example.com",
    );
    expect(price).toBe(2000.5);
  });

  it("correctly decodes Chainlink price with zero value", async () => {
    const answerHex = "0".padStart(64, "0");
    const roundIdHex = "1".padStart(64, "0");
    const startedAtHex = "0".padStart(64, "0");
    const updatedAtHex = "1".padStart(64, "0");
    const answeredInRoundHex = "1".padStart(64, "0");
    const hexResult =
      "0x" +
      roundIdHex +
      answerHex +
      startedAtHex +
      updatedAtHex +
      answeredInRoundHex;

    mockAggregator(hexResult);

    const price = await getNativeTokenPriceUsd(
      "eip155:1",
      "https://rpc.example.com",
    );
    expect(price).toBeNull();
  });

  it("correctly decodes small Chainlink price values", async () => {
    // Small price: $0.01 → answer = 1000000 (8 decimals, 1 cent)
    const answerHex = BigInt("1000000").toString(16).padStart(64, "0");
    const roundIdHex = "1".padStart(64, "0");
    const startedAtHex = "0".padStart(64, "0");
    const updatedAtHex = "1".padStart(64, "0");
    const answeredInRoundHex = "1".padStart(64, "0");
    const hexResult =
      "0x" +
      roundIdHex +
      answerHex +
      startedAtHex +
      updatedAtHex +
      answeredInRoundHex;

    mockAggregator(hexResult);

    const price = await getNativeTokenPriceUsd(
      "eip155:1",
      "https://rpc.example.com",
    );
    expect(price).toBeCloseTo(0.01, 10);
  });

  it("supports Optimism chain (eip155:10)", async () => {
    const answerHex = BigInt("180000000000").toString(16).padStart(64, "0"); // $1800
    const roundIdHex = "1".padStart(64, "0");
    const startedAtHex = "0".padStart(64, "0");
    const updatedAtHex = "1".padStart(64, "0");
    const answeredInRoundHex = "1".padStart(64, "0");
    const hexResult =
      "0x" +
      roundIdHex +
      answerHex +
      startedAtHex +
      updatedAtHex +
      answeredInRoundHex;

    mockAggregator(hexResult);

    const price = await getNativeTokenPriceUsd(
      "eip155:10",
      "https://rpc.example.com",
    );
    expect(price).toBe(1800);
  });

  it("supports Polygon chain (eip155:137)", async () => {
    const answerHex = BigInt("85000000").toString(16).padStart(64, "0"); // $0.85 → POL
    const roundIdHex = "1".padStart(64, "0");
    const startedAtHex = "0".padStart(64, "0");
    const updatedAtHex = "1".padStart(64, "0");
    const answeredInRoundHex = "1".padStart(64, "0");
    const hexResult =
      "0x" +
      roundIdHex +
      answerHex +
      startedAtHex +
      updatedAtHex +
      answeredInRoundHex;

    mockAggregator(hexResult);

    const price = await getNativeTokenPriceUsd(
      "eip155:137",
      "https://rpc.example.com",
    );
    expect(price).toBe(0.85);
  });

  it("uses the feed's decimals() value instead of assuming 8", async () => {
    const answerHex = BigInt("200050000").toString(16).padStart(64, "0");
    const word = (value: string) => value.padStart(64, "0");
    const latest =
      "0x" + [word("1"), answerHex, word("0"), word("1"), word("1")].join("");
    mockAggregator(latest, 6);

    await expect(
      getNativeTokenPriceUsd("eip155:1", "https://rpc.example.com"),
    ).resolves.toBe(200.05);
  });

  it("rejects negative answers and incomplete rounds", async () => {
    const word = (value: string) => value.padStart(64, "0");
    const negative =
      "0x" +
      [word("1"), "f".repeat(64), word("0"), word("1"), word("1")].join("");
    mockAggregator(negative);
    await expect(
      getNativeTokenPriceUsd("eip155:1", "https://rpc.example.com"),
    ).resolves.toBeNull();

    const incomplete =
      "0x" + [word("2"), word("1"), word("0"), word("1"), word("1")].join("");
    mockAggregator(incomplete);
    await expect(
      getNativeTokenPriceUsd("eip155:1", "https://rpc.example.com"),
    ).resolves.toBeNull();
  });

  it("can enforce an explicit freshness policy", async () => {
    const word = (value: string) => value.padStart(64, "0");
    const stale =
      "0x" +
      [word("1"), word("200000000000"), word("0"), word("1"), word("1")].join(
        "",
      );
    mockAggregator(stale);
    await expect(
      getNativeTokenPriceUsd("eip155:1", "https://rpc.example.com", {
        maxAgeSeconds: 60,
      }),
    ).resolves.toBeNull();
  });

  it("sends correct eth_call payload to RPC", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jsonrpc: "2.0", id: 1, result: "0x" }),
    } as Response);

    await getNativeTokenPriceUsd("eip155:1", "https://rpc.example.com");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://rpc.example.com",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: expect.stringContaining("eth_call"),
      }),
    );

    const callBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(callBody.method).toBe("eth_call");
    expect(callBody.params[0].to).toBe(
      "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
    );
    expect(callBody.params[0].data).toBe("0xfeaf968c"); // latestRoundData selector
    expect(callBody.params[1]).toBe("latest");
  });
});

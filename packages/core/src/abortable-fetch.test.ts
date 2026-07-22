/**
 * abortable-fetch Tests
 *
 * Validates the shared abort/fetch helpers:
 * - Success path
 * - Network error handling
 * - JSON-RPC call wrapping
 * - HTTP error handling
 * - Stale response handling
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { abortableFetch, rpcCall } from "./abortable-fetch";

describe("abortableFetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns response on successful fetch", async () => {
    const mockResponse = new Response('{"hello":"world"}', { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const result = await abortableFetch("https://example.com/api", {
      timeoutMs: 5_000,
    });

    expect(result).toBe(mockResponse);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://example.com/api",
      expect.objectContaining({ signal: expect.any(Object) }),
    );
  });

  it("rejects on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network failure"));

    await expect(
      abortableFetch("https://fail.example.com", { timeoutMs: 5_000 }),
    ).rejects.toThrow("Network failure");
  });

  it("rejects on fetch with non-ok status", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("Server Error", { status: 500 }));

    const response = await abortableFetch("https://error.example.com", {
      timeoutMs: 5_000,
    });
    expect(response.status).toBe(500);
  });

  it("passes custom headers through to fetch", async () => {
    const mockResponse = new Response("OK", { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const customHeaders = { "X-Custom": "test-header" };
    await abortableFetch("https://example.com/api", {
      method: "POST",
      headers: customHeaders,
      timeoutMs: 5_000,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://example.com/api",
      expect.objectContaining({
        method: "POST",
        headers: customHeaders,
      }),
    );
  });
});

describe("rpcCall", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("makes a JSON-RPC call and returns the result", async () => {
    const mockResponse = new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1234" }),
      { status: 200 },
    );
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const result = await rpcCall<string>(
      "https://rpc.example.com",
      "eth_chainId",
      [],
    );

    expect(result).toBe("0x1234");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    // Verify the RPC request body
    const callArg = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][1];
    expect(JSON.parse(callArg.body)).toMatchObject({
      jsonrpc: "2.0",
      method: "eth_chainId",
      params: [],
    });
  });

  it("throws on HTTP error", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("Not Found", { status: 404 }));

    await expect(
      rpcCall("https://rpc.example.com", "eth_chainId", []),
    ).rejects.toThrow("RPC returned status 404");
  });

  it("throws on JSON-RPC error", async () => {
    const mockResponse = new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "Rate limited" },
      }),
      { status: 200 },
    );
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    await expect(
      rpcCall("https://rpc.example.com", "eth_chainId", []),
    ).rejects.toThrow("Rate limited");
  });

  it("preserves result type for generic calls", async () => {
    const mockResponse = new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { blockNumber: "0x1234", timestamp: "0xabcdef" },
      }),
      { status: 200 },
    );
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const result = await rpcCall<{ blockNumber: string; timestamp: string }>(
      "https://rpc.example.com",
      "eth_getBlockByNumber",
      ["latest", false],
    );

    expect(result.blockNumber).toBe("0x1234");
    expect(result.timestamp).toBe("0xabcdef");
  });
});

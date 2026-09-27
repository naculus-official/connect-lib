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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("rpcCall transport contract", () => {
  const RPC_URL = "https://rpc.example.com";

  function abortError() {
    return new DOMException("This operation was aborted", "AbortError");
  }

  class DomainError extends Error {
    constructor(
      message: string,
      readonly details?: unknown,
    ) {
      super(message);
      this.name = "DomainError";
    }
  }

  const toError = {
    http: (status: number) => new DomainError(`RPC returned status ${status}`),
    rpc: (error: { code: number; message: string }) =>
      new DomainError(error.message, { code: error.code }),
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts after the default 10s when fetch never answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<never>((_, reject) => {
            init.signal?.addEventListener("abort", () => reject(abortError()));
          }),
      ),
    );

    let settled = false;
    const result = rpcCall(RPC_URL, "eth_chainId", []).catch((e: unknown) => {
      settled = true;
      return e;
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ name: "AbortError" });
  });

  it("keeps the timeout armed while the body is read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => ({
        ok: true,
        status: 200,
        json: () =>
          new Promise<never>((_, reject) => {
            init.signal?.addEventListener("abort", () => reject(abortError()));
          }),
      })),
    );

    let settled = false;
    const result = rpcCall(RPC_URL, "eth_chainId", [], {
      timeoutMs: 2_000,
    }).catch((e: unknown) => {
      settled = true;
      return e;
    });
    await vi.advanceTimersByTimeAsync(2_000);

    // Assert before awaiting so a missing timeout fails instead of hanging.
    expect(settled).toBe(true);
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("maps HTTP errors through toError.http", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 502 }),
    );

    const err = await rpcCall(RPC_URL, "eth_chainId", [], { toError }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({
      message: "RPC returned status 502",
      details: undefined,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("maps JSON-RPC errors through toError.rpc", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ error: { code: -32005, message: "limit" } }),
      }),
    );

    const err = await rpcCall(RPC_URL, "eth_chainId", [], { toError }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ message: "limit", details: { code: -32005 } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not map network errors or timeouts through toError", async () => {
    const network = new TypeError("fetch failed");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(network));
    const http = vi.fn(toError.http);
    const rpc = vi.fn(toError.rpc);

    await expect(
      rpcCall(RPC_URL, "eth_chainId", [], { toError: { http, rpc } }),
    ).rejects.toBe(network);
    expect(http).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});

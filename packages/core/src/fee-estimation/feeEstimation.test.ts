import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeeEstimationError, isFeeEstimationError } from "./errors";
import {
  clearChainFeeEstimators,
  estimateFees,
  estimateMaxPriorityFeePerGas,
  getChainId,
  getFeeData,
  getGasPrice,
  getLatestBaseFee,
  registerChainFeeEstimator,
  unregisterChainFeeEstimator,
} from "./feeEstimation";
import type {
  ChainFeeEstimator,
  FeeValuesEIP1559,
  FeeValuesLegacy,
} from "./types";

// ─── Helper: create a mock fetch that returns JSON ─────────────────────

function mockRpcResponse(
  result: unknown,
  error?: { code: number; message: string },
) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () =>
      error
        ? { jsonrpc: "2.0", id: 1, error }
        : { jsonrpc: "2.0", id: 1, result },
  });
}

function mockRpcError(status: number) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
  });
}

// ─── Fee Values ────────────────────────────────────────────────────────

describe("estimateMaxPriorityFeePerGas", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should return the suggested priority fee as bigint", async () => {
    globalThis.fetch = mockRpcResponse("0x3b9aca00"); // 1 gwei
    const result = await estimateMaxPriorityFeePerGas(
      "https://eth.llamarpc.com",
    );
    expect(result).toBe(1_000_000_000n);
  });

  it("should throw FeeEstimationError if RPC returns an error", async () => {
    globalThis.fetch = mockRpcResponse(null, {
      code: -32601,
      message: "Method not found",
    });
    await expect(
      estimateMaxPriorityFeePerGas("https://eth.llamarpc.com"),
    ).rejects.toThrow(FeeEstimationError);
  });

  it("should throw FeeEstimationError if HTTP request fails", async () => {
    globalThis.fetch = mockRpcError(500);
    await expect(
      estimateMaxPriorityFeePerGas("https://bad.example.com"),
    ).rejects.toThrow(FeeEstimationError);
  });
});

describe("getLatestBaseFee", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should return base fee when block has it", async () => {
    globalThis.fetch = mockRpcResponse({
      baseFeePerGas: "0x3b9aca00", // 1 gwei
    });
    const result = await getLatestBaseFee("https://eth.llamarpc.com");
    expect(result).toBe(1_000_000_000n);
  });

  it("should return null when block has no baseFeePerGas (pre-London)", async () => {
    globalThis.fetch = mockRpcResponse({});
    const result = await getLatestBaseFee("https://prelondon.example.com");
    expect(result).toBeNull();
  });

  it("should return null when block is falsy", async () => {
    globalThis.fetch = mockRpcResponse(null);
    const result = await getLatestBaseFee("https://eth.llamarpc.com");
    expect(result).toBeNull();
  });
});

describe("getGasPrice", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should return gas price as bigint", async () => {
    globalThis.fetch = mockRpcResponse("0x9502f900"); // 2.5 gwei
    const result = await getGasPrice("https://eth.llamarpc.com");
    expect(result).toBe(2_500_000_000n);
  });
});

describe("getChainId", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should return chain ID as a bigint", async () => {
    globalThis.fetch = mockRpcResponse("0x1"); // Ethereum mainnet
    const result = await getChainId("https://eth.llamarpc.com");
    expect(result).toBe(1n);
  });

  it("should handle large chain IDs correctly", async () => {
    globalThis.fetch = mockRpcResponse("0x89"); // 137 = Polygon
    const result = await getChainId("https://polygon-rpc.com");
    expect(result).toBe(137n);
  });

  it("should handle chain IDs beyond MAX_SAFE_INTEGER", async () => {
    globalThis.fetch = mockRpcResponse("0xDEADBEEFCAFE"); // 244837814094590
    const result = await getChainId("https://custom-rpc.com");
    expect(result).toBe(244837814094590n);
  });

  it("should throw FeeEstimationError on RPC error", async () => {
    globalThis.fetch = mockRpcError(500);
    await expect(getChainId("https://bad.example.com")).rejects.toThrow(
      FeeEstimationError,
    );
  });

  it("should throw FeeEstimationError on RPC method error", async () => {
    globalThis.fetch = mockRpcResponse(null, {
      code: -32601,
      message: "Method not found",
    });
    await expect(getChainId("https://eth.llamarpc.com")).rejects.toThrow(
      FeeEstimationError,
    );
  });
});

describe("getFeeData", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should detect EIP-1559 support and return fee data", async () => {
    globalThis.fetch = mockRpcResponse({
      baseFeePerGas: "0x3b9aca00",
    });
    // Second call for eth_maxPriorityFeePerGas
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: { baseFeePerGas: "0x3b9aca00" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: "0x59682f00", // 1.5 gwei
        }),
      });

    const result = await getFeeData("https://eth.llamarpc.com");
    expect(result.eip1559).toBe(true);
    expect(result.latestBaseFee).toBe(1_000_000_000n);
    expect(result.recommendedPriorityFee).toBe(1_500_000_000n);
  });

  it("should return eip1559=true without priority fee when method is unsupported", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: { baseFeePerGas: "0x3b9aca00" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: "Method not found" },
        }),
      });

    const result = await getFeeData("https://eth.llamarpc.com");
    expect(result.eip1559).toBe(true);
    expect(result.latestBaseFee).toBe(1_000_000_000n);
    expect(result.recommendedPriorityFee).toBeUndefined();
  });

  it("should detect legacy chain when no base fee", async () => {
    globalThis.fetch = mockRpcResponse({}); // No baseFeePerGas
    const result = await getFeeData("https://legacy.example.com");
    expect(result.eip1559).toBe(false);
    expect(result.latestBaseFee).toBeUndefined();
    expect(result.recommendedPriorityFee).toBeUndefined();
  });
});

// ─── estimateFees ──────────────────────────────────────────────────────

describe("estimateFees", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearChainFeeEstimators();
  });

  it("should return EIP-1559 fee values for an EIP-1559 chain (auto mode)", async () => {
    // Order: eth_maxPriorityFeePerGas → eth_getBlockByNumber
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x59682f00" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: { baseFeePerGas: "0x3b9aca00" },
        }),
      });

    const fees = await estimateFees({ rpcUrl: "https://eth.llamarpc.com" });
    expect(fees.type).toBe("eip1559");
    const eip1559Fees = fees as FeeValuesEIP1559;
    expect(eip1559Fees.maxPriorityFeePerGas).toBe(1_500_000_000n);
    // maxFeePerGas = baseFee * 2 + priorityFee = 2_000_000_000 + 1_500_000_000
    expect(eip1559Fees.maxFeePerGas).toBe(3_500_000_000n);
  });

  it("should apply baseFeeMultiplier", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x59682f00" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: { baseFeePerGas: "0x3b9aca00" },
        }),
      });

    const fees = (await estimateFees({
      rpcUrl: "https://eth.llamarpc.com",
      baseFeeMultiplier: 3n,
    })) as FeeValuesEIP1559;

    // maxFeePerGas = baseFee * 3 + priorityFee = 3_000_000_000 + 1_500_000_000
    expect(fees.maxFeePerGas).toBe(4_500_000_000n);
  });

  it("should apply maxPriorityFeePerGas override", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x59682f00" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: { baseFeePerGas: "0x3b9aca00" },
        }),
      });

    const fees = (await estimateFees({
      rpcUrl: "https://eth.llamarpc.com",
      maxPriorityFeePerGas: 2_000_000_000n,
    })) as FeeValuesEIP1559;

    expect(fees.maxPriorityFeePerGas).toBe(2_000_000_000n);
    // maxFeePerGas = baseFee * 2 + 2gwei = 2_000_000_000 + 2_000_000_000
    expect(fees.maxFeePerGas).toBe(4_000_000_000n);
  });

  it("should return legacy fee values for a pre-London chain", async () => {
    // eth_maxPriorityFeePerGas fails → fallback to eth_gasPrice
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: "Method not found" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x9502f900" }),
      });

    const fees = await estimateFees({ rpcUrl: "https://legacy.example.com" });
    expect(fees.type).toBe("legacy");
    const legacyFees = fees as FeeValuesLegacy;
    expect(legacyFees.gasPrice).toBe(2_500_000_000n);
  });

  it("should return legacy when forced type=legacy", async () => {
    globalThis.fetch = mockRpcResponse("0x9502f900");
    const fees = await estimateFees({
      rpcUrl: "https://eth.llamarpc.com",
      type: "legacy",
    });
    expect(fees.type).toBe("legacy");
    expect((fees as FeeValuesLegacy).gasPrice).toBe(2_500_000_000n);
  });

  it("should return EIP-1559 when forced type=eip1559", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x59682f00" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: { baseFeePerGas: "0x3b9aca00" },
        }),
      });

    const fees = await estimateFees({
      rpcUrl: "https://eth.llamarpc.com",
      type: "eip1559",
    });
    expect(fees.type).toBe("eip1559");
  });

  it("should throw FeeEstimationError when forced eip1559 but no base fee", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x59682f00" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: {},
        }),
      });

    await expect(
      estimateFees({ rpcUrl: "https://example.com", type: "eip1559" }),
    ).rejects.toThrow(FeeEstimationError);
  });

  it("should throw FeeEstimationError when all strategies fail", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: "Method not found" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32000, message: "chain unavailable" },
        }),
      });

    await expect(
      estimateFees({ rpcUrl: "https://broken.example.com" }),
    ).rejects.toThrow(FeeEstimationError);
  });
});

// ─── Chain Estimator Registry ──────────────────────────────────────────

describe("chain-specific estimator registry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearChainFeeEstimators();
  });

  it("should use registered estimator before built-in logic", async () => {
    const customEstimator: ChainFeeEstimator = {
      chainId: "eip155:10",
      estimateFees: async () => ({
        type: "eip1559" as const,
        maxFeePerGas: 100_000_000n,
        maxPriorityFeePerGas: 10_000_000n,
      }),
    };

    registerChainFeeEstimator(customEstimator);

    const fees = await estimateFees({
      rpcUrl: "https://optimism.llamarpc.com",
      chainId: "eip155:10",
    });
    expect(fees.type).toBe("eip1559");
    expect((fees as FeeValuesEIP1559).maxFeePerGas).toBe(100_000_000n);
  });

  it("should fall through when registered estimator throws", async () => {
    const failingEstimator: ChainFeeEstimator = {
      chainId: "eip155:10",
      estimateFees: async () => {
        throw new Error("Custom estimator failure");
      },
    };

    registerChainFeeEstimator(failingEstimator);

    // Falls through to built-in logic → should detect EIP-1559
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x59682f00" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: { baseFeePerGas: "0x3b9aca00" },
        }),
      });

    const fees = await estimateFees({
      rpcUrl: "https://optimism.llamarpc.com",
      chainId: "eip155:10",
    });
    expect(fees.type).toBe("eip1559");
  });

  it("unregisterChainFeeEstimator should remove an estimator", () => {
    const estimator: ChainFeeEstimator = {
      chainId: "eip155:137",
      estimateFees: async () => ({ type: "legacy", gasPrice: 0n }),
    };
    registerChainFeeEstimator(estimator);
    unregisterChainFeeEstimator("eip155:137");
    // Should not find the estimator anymore → fall through
    // (We don't mock fetch here, so it will throw, but we confirm no TypeError from estimator)
  });

  it("clearChainFeeEstimators should remove all estimators", () => {
    const est1: ChainFeeEstimator = {
      chainId: "eip155:1",
      estimateFees: async () => ({ type: "legacy", gasPrice: 1n }),
    };
    const est2: ChainFeeEstimator = {
      chainId: "eip155:137",
      estimateFees: async () => ({ type: "legacy", gasPrice: 2n }),
    };
    registerChainFeeEstimator(est1);
    registerChainFeeEstimator(est2);
    clearChainFeeEstimators();
    // registry is now empty
  });
});

// ─── FeeEstimationError ────────────────────────────────────────────────

describe("FeeEstimationError", () => {
  it("should create error with code and default message", () => {
    const err = new FeeEstimationError("fee_estimation_failed");
    expect(err.code).toBe("fee_estimation_failed");
    expect(err.name).toBe("FeeEstimationError");
    expect(err.message).toBe("fee_estimation_failed");
  });

  it("should create error with custom message and details", () => {
    const err = new FeeEstimationError("fee_rpc_error", "RPC call failed", {
      status: 500,
    });
    expect(err.code).toBe("fee_rpc_error");
    expect(err.message).toBe("RPC call failed");
    expect(err.details).toEqual({ status: 500 });
  });
});

describe("isFeeEstimationError", () => {
  it("should return true for matching code", () => {
    const err = new FeeEstimationError("fee_estimation_failed");
    expect(isFeeEstimationError(err, "fee_estimation_failed")).toBe(true);
  });

  it("should return false for non-matching code", () => {
    const err = new FeeEstimationError("fee_estimation_failed");
    expect(isFeeEstimationError(err, "fee_rpc_error")).toBe(false);
  });

  it("should return false for non-FeeEstimationError", () => {
    expect(isFeeEstimationError(new Error("regular"))).toBe(false);
    expect(isFeeEstimationError(null)).toBe(false);
    expect(isFeeEstimationError({})).toBe(false);
  });
});

// ─── RPC transport regression (#13 dedupe) ─────────────────────────────
//
// Pins the observable transport contract of the fee-estimation RPC helper so
// routing it through the shared transport cannot change what callers see:
// request shape, the 10s timeout (covering the body read), and which errors
// are wrapped in FeeEstimationError versus passed through untouched.

describe("fee-estimation RPC transport", () => {
  const RPC_URL = "https://rpc.example.com";
  const realFetch = globalThis.fetch;

  function abortError() {
    return new DOMException("This operation was aborted", "AbortError");
  }

  /** fetch that never answers until its signal aborts */
  function hangingFetch() {
    return vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<never>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(abortError()));
        }),
    ) as unknown as typeof fetch;
  }

  /** fetch that answers headers but whose body never finishes until abort */
  function hangingBodyFetch() {
    return vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      json: () =>
        new Promise<never>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(abortError()));
        }),
    })) as unknown as typeof fetch;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
  });

  it("POSTs a JSON-RPC 2.0 envelope with an abort signal", async () => {
    const spy = mockRpcResponse("0x1");
    globalThis.fetch = spy;

    await getGasPrice(RPC_URL);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RPC_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_gasPrice",
      params: [],
    });
  });

  it("wraps a non-ok HTTP status in FeeEstimationError(fee_rpc_error)", async () => {
    globalThis.fetch = mockRpcError(503);

    const err = await getGasPrice(RPC_URL).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FeeEstimationError);
    expect(err).toMatchObject({
      name: "FeeEstimationError",
      code: "fee_rpc_error",
      message: "RPC returned status 503",
      details: undefined,
    });
  });

  it("wraps a JSON-RPC error in FeeEstimationError with the rpc code", async () => {
    globalThis.fetch = mockRpcResponse(null, {
      code: -32601,
      message: "method not found",
    });

    const err = await getGasPrice(RPC_URL).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FeeEstimationError);
    expect(err).toMatchObject({
      code: "fee_rpc_error",
      message: "method not found",
      details: { code: -32601 },
    });
  });

  it("passes network errors through unwrapped", async () => {
    const network = new TypeError("fetch failed");
    globalThis.fetch = vi.fn().mockRejectedValue(network);

    await expect(getGasPrice(RPC_URL)).rejects.toBe(network);
  });

  it("aborts a request that has not answered after 10s", async () => {
    globalThis.fetch = hangingFetch();

    let settled = false;
    const result = getGasPrice(RPC_URL).catch((e: unknown) => {
      settled = true;
      return e;
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const err = await result;
    expect(err).not.toBeInstanceOf(FeeEstimationError);
    expect(err).toMatchObject({ name: "AbortError" });
  });

  it("keeps the 10s timeout armed while the body is read", async () => {
    globalThis.fetch = hangingBodyFetch();

    let settled = false;
    const result = getGasPrice(RPC_URL).catch((e: unknown) => {
      settled = true;
      return e;
    });
    await vi.advanceTimersByTimeAsync(10_000);

    // Assert before awaiting so a missing timeout fails instead of hanging.
    expect(settled).toBe(true);
    expect(await result).toMatchObject({ name: "AbortError" });
  });

  it("clears the timeout on success and on every error path", async () => {
    globalThis.fetch = mockRpcResponse("0x1");
    await getGasPrice(RPC_URL);
    expect(vi.getTimerCount()).toBe(0);

    globalThis.fetch = mockRpcError(500);
    await getGasPrice(RPC_URL).catch(() => {});
    expect(vi.getTimerCount()).toBe(0);

    globalThis.fetch = mockRpcResponse(null, { code: -1, message: "x" });
    await getGasPrice(RPC_URL).catch(() => {});
    expect(vi.getTimerCount()).toBe(0);

    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("down"));
    await getGasPrice(RPC_URL).catch(() => {});
    expect(vi.getTimerCount()).toBe(0);
  });

  it("surfaces a timed-out legacy fallback as fee_estimation_failed", async () => {
    globalThis.fetch = hangingFetch();

    const result = estimateFees({ rpcUrl: RPC_URL }).catch((e: unknown) => e);
    // eth_maxPriorityFeePerGas times out, then eth_gasPrice times out
    await vi.advanceTimersByTimeAsync(20_000);

    const err = await result;
    expect(isFeeEstimationError(err, "fee_estimation_failed")).toBe(true);
    expect((err as FeeEstimationError).details).toMatchObject({
      error: { name: "AbortError" },
    });
  });
});

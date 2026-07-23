/**
 * Tests for PaymasterService
 *
 * Tests cover:
 * - Paymaster type handling
 * - Error cases for empty/missing config
 * - Sponsor info tracking
 * - isSponsored checks
 *
 * RPC-dependent tests are conditional.
 */

import { ADDRESSES } from "@naculus/test-utils/test-constants";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PaymasterService, createPaymasterService, type PaymasterServiceConfig } from "../paymaster";
import { buildUserOperation } from "../user-operation";
import { type Address, type PaymasterConfig } from "../types";
import { AccountAbstractionError } from "../errors";

// ─── Fixtures ──────────────────────────────────────────────────────────

const TEST_SENDER = "0x1234567890123456789012345678901234567890" as Address;

function createServiceConfig(overrides: Partial<PaymasterServiceConfig> = {}): PaymasterServiceConfig {
  return {
    url: "https://api.pimlico.io/v2/11155111/rpc?apikey=test",
    type: "verifying",
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("PaymasterService", () => {
  describe("constructor", () => {
    it("creates a service with valid config", () => {
      const service = new PaymasterService(createServiceConfig());
      expect(service).toBeInstanceOf(PaymasterService);
    });

    it("creates a service with sponsor type", () => {
      const service = new PaymasterService(createServiceConfig({ type: "sponsor" }));
      expect(service).toBeInstanceOf(PaymasterService);
    });

    it("creates a service with token type", () => {
      const service = new PaymasterService(createServiceConfig({
        type: "token",
        policy: { token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address },
      }));
      expect(service).toBeInstanceOf(PaymasterService);
    });

    it("creates a service with custom type", () => {
      const service = new PaymasterService(createServiceConfig({ type: "custom" }));
      expect(service).toBeInstanceOf(PaymasterService);
    });
  });

  describe("sponsorInfo", () => {
    it("initially returns null", () => {
      const service = new PaymasterService(createServiceConfig());
      expect(service.sponsorInfo).toBeNull();
    });
  });

  describe("isSponsored", () => {
    it("returns false when paymaster request fails", async () => {
      const service = new PaymasterService(createServiceConfig({
        url: "https://invalid.paymaster/rpc",
      }));
      const userOp = buildUserOperation({ sender: TEST_SENDER });
      const result = await service.isSponsored(userOp);
      expect(result).toBe(false);
    });

    it("returns false for uninitiated service (error on RPC)", async () => {
      const service = new PaymasterService(createServiceConfig({ url: "" }));
      const userOp = buildUserOperation({ sender: TEST_SENDER });
      const result = await service.isSponsored(userOp);
      expect(result).toBe(false);
    });
  });

  describe("getPaymasterData", () => {
    it("throws AAError when paymaster URL is empty", async () => {
      const service = new PaymasterService(createServiceConfig({ url: "" }));
      const userOp = buildUserOperation({ sender: TEST_SENDER });
      await expect(service.getPaymasterData(userOp)).rejects.toThrow(AccountAbstractionError);
    });

    it("throws AAError for invalid paymaster URL", async () => {
      const service = new PaymasterService(createServiceConfig({ url: "not-a-url" }));
      const userOp = buildUserOperation({ sender: TEST_SENDER });
      await expect(service.getPaymasterData(userOp)).rejects.toThrow();
    });
  });
});

// ─── createPaymasterService ────────────────────────────────────────────

describe("createPaymasterService", () => {
  it("creates a PaymasterService from PaymasterConfig", () => {
    const config: PaymasterConfig = {
      type: "verifying",
      url: "https://api.pimlico.io/v2/1/rpc?apikey=test",
    };
    const service = createPaymasterService(config);
    expect(service).toBeInstanceOf(PaymasterService);
  });

  it("includes policy in created service", () => {
    const config: PaymasterConfig = {
      type: "token",
      url: "https://api.pimlico.io/v2/1/rpc?apikey=test",
      policy: {
        token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
      },
    };
    const service = createPaymasterService(config);
    expect(service).toBeInstanceOf(PaymasterService);
  });
});

// ─── Fetch Mock Helpers ─────────────────────────────────────────────────

function mockFetchSuccess(data: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(data),
  } as unknown as Response);
}

function mockFetchError(status: number) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: false,
    status,
    json: vi.fn().mockRejectedValue(new Error("HTTP error")),
  } as unknown as Response);
}

function mockFetchNetworkError() {
  return vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
}

// ─── Verifying Paymaster RPC Tests ──────────────────────────────────────

describe("verifying paymaster data", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns paymasterAndData on successful RPC", async () => {
    mockFetchSuccess({ result: { paymasterAndData: "0xdeadbeef", sponsor: { name: "Pimlico" } } });
    const service = new PaymasterService(createServiceConfig({ type: "verifying" }));
    const data = await service.getPaymasterData(buildUserOperation({ sender: TEST_SENDER }));
    expect(data.paymasterAndData).toBe("0xdeadbeef");
    expect(data.sponsorInfo).toBe("Pimlico");
  });

  it("throws AAError on RPC error response", async () => {
    mockFetchSuccess({ error: { code: -32000, message: "insufficient funds" } });
    const service = new PaymasterService(createServiceConfig({ type: "verifying" }));
    await expect(service.getPaymasterData(buildUserOperation({ sender: TEST_SENDER }))).rejects.toThrow(AccountAbstractionError);
  });

  it("throws AAError on HTTP error", async () => {
    mockFetchError(500);
    const service = new PaymasterService(createServiceConfig({ type: "verifying" }));
    await expect(service.getPaymasterData(buildUserOperation({ sender: TEST_SENDER }))).rejects.toThrow(AccountAbstractionError);
  });

  it("throws AAError when paymasterAndData is missing from result", async () => {
    mockFetchSuccess({ result: {} });
    const service = new PaymasterService(createServiceConfig({ type: "verifying" }));
    await expect(service.getPaymasterData(buildUserOperation({ sender: TEST_SENDER }))).rejects.toThrow(AccountAbstractionError);
  });

  it("throws AAError on network failure", async () => {
    mockFetchNetworkError();
    const service = new PaymasterService(createServiceConfig({ type: "verifying" }));
    await expect(service.getPaymasterData(buildUserOperation({ sender: TEST_SENDER }))).rejects.toThrow(AccountAbstractionError);
  });

  it("sends API key header when configured", async () => {
    const spy = mockFetchSuccess({ result: { paymasterAndData: "0xdead" } });
    const service = new PaymasterService(createServiceConfig({ type: "verifying", apiKey: "sk-test" }));
    await service.getPaymasterData(buildUserOperation({ sender: TEST_SENDER }));
    const headers = (spy.mock.calls[0][1] as Record<string, unknown>).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test");
  });

  it("serializes userOp bigint fields as hex in request", async () => {
    const spy = mockFetchSuccess({ result: { paymasterAndData: "0xdead" } });
    const service = new PaymasterService(createServiceConfig({ type: "verifying" }));
    await service.getPaymasterData(buildUserOperation({ sender: TEST_SENDER, nonce: 42n, preVerificationGas: 50000n }));
    const body = JSON.parse((spy.mock.calls[0][1] as Record<string, unknown>).body as string);
    expect(body.method).toBe("pm_sponsorUserOperation");
    expect(body.params[0].nonce).toBe("0x2a");
    expect(body.params[0].sender).toBe(TEST_SENDER);
  });
});

// ─── Sponsor Paymaster Tests ────────────────────────────────────────────

describe("sponsor paymaster data", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns paymasterAndData on successful RPC", async () => {
    mockFetchSuccess({ result: { paymasterAndData: "0xsponsored" } });
    const service = new PaymasterService(createServiceConfig({ type: "sponsor" }));
    const data = await service.getPaymasterData(buildUserOperation({ sender: TEST_SENDER }));
    expect(data.paymasterAndData).toBe("0xsponsored");
    expect(data.sponsorInfo).toBe("Gas sponsored by dApp");
  });

  it("falls back to verifying paymaster when sponsor RPC returns error", async () => {
    const spy = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ error: { code: -32000, message: "not sponsored" } }) }) as unknown as Response)
      .mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ result: { paymasterAndData: "0xfallback", sponsor: { name: "Fallback" } } }) }) as unknown as Response);
    const service = new PaymasterService(createServiceConfig({ type: "sponsor" }));
    const data = await service.getPaymasterData(buildUserOperation({ sender: TEST_SENDER }));
    expect(data.paymasterAndData).toBe("0xfallback");
    expect(data.sponsorInfo).toBe("Fallback");
  });

  it("throws AAError on HTTP error (no fallback)", async () => {
    mockFetchError(500);
    const service = new PaymasterService(createServiceConfig({ type: "sponsor" }));
    await expect(service.getPaymasterData(buildUserOperation({ sender: TEST_SENDER }))).rejects.toThrow(AccountAbstractionError);
  });
});

// ─── Token Paymaster Tests ──────────────────────────────────────────────

describe("token paymaster data", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns paymasterAndData with token policy", async () => {
    mockFetchSuccess({ result: { paymasterAndData: "0xtoken" } });
    const service = new PaymasterService(createServiceConfig({ type: "token", policy: { token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address } }));
    const data = await service.getPaymasterData(buildUserOperation({ sender: TEST_SENDER }));
    expect(data.paymasterAndData).toBe("0xtoken");
  });

  it("returns paymasterAndData without token policy", async () => {
    mockFetchSuccess({ result: { paymasterAndData: "0xeth" } });
    const service = new PaymasterService(createServiceConfig({ type: "token" }));
    const data = await service.getPaymasterData(buildUserOperation({ sender: TEST_SENDER }));
    expect(data.paymasterAndData).toBe("0xeth");
  });

  it("sends API key header when configured", async () => {
    const spy = mockFetchSuccess({ result: { paymasterAndData: "0xapikey" } });
    const service = new PaymasterService(createServiceConfig({ type: "token", apiKey: "sk-token" }));
    await service.getPaymasterData(buildUserOperation({ sender: TEST_SENDER }));
    const headers = (spy.mock.calls[0][1] as Record<string, unknown>).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-token");
  });

  it("sends token address as extra param when configured", async () => {
    const spy = mockFetchSuccess({ result: { paymasterAndData: "0xparam" } });
    const tokenAddr = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
    const service = new PaymasterService(createServiceConfig({ type: "token", policy: { token: tokenAddr } }));
    await service.getPaymasterData(buildUserOperation({ sender: TEST_SENDER }));
    const body = JSON.parse((spy.mock.calls[0][1] as Record<string, unknown>).body as string);
    expect(body.params[1]).toBe(tokenAddr);
  });

  it("throws AAError on RPC error", async () => {
    mockFetchSuccess({ error: { code: -32000, message: "token rejected" } });
    const service = new PaymasterService(createServiceConfig({ type: "token" }));
    await expect(service.getPaymasterData(buildUserOperation({ sender: TEST_SENDER }))).rejects.toThrow(AccountAbstractionError);
  });

  it("handles HTTP error from token paymaster", async () => {
    mockFetchError(403);
    const service = new PaymasterService(createServiceConfig({ type: "token" }));
    await expect(service.getPaymasterData(buildUserOperation({ sender: TEST_SENDER }))).rejects.toThrow(AccountAbstractionError);
  });
});

// ─── Custom Paymaster Tests ─────────────────────────────────────────────

describe("custom paymaster data", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("delegates to verifying paymaster endpoint", async () => {
    mockFetchSuccess({ result: { paymasterAndData: "0xcustom", sponsor: { name: "Custom" } } });
    const service = new PaymasterService(createServiceConfig({ type: "custom" }));
    const data = await service.getPaymasterData(buildUserOperation({ sender: TEST_SENDER }));
    expect(data.paymasterAndData).toBe("0xcustom");
    expect(data.sponsorInfo).toBe("Custom");
  });
});

// ─── Unknown Paymaster Type ─────────────────────────────────────────────

describe("unknown paymaster type", () => {
  it("throws AAError", async () => {
    const service = new PaymasterService(createServiceConfig({ type: "custom" as any }));
    (service as any).config.type = "unknown-type";
    await expect(service.getPaymasterData(buildUserOperation({ sender: TEST_SENDER }))).rejects.toThrow(AccountAbstractionError);
  });
});

// ─── isSponsored Edge Cases ─────────────────────────────────────────────

describe("isSponsored edge cases", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns true when RPC returns valid paymasterAndData", async () => {
    mockFetchSuccess({ result: { paymasterAndData: "0xvalidsponsor" } });
    const service = new PaymasterService(createServiceConfig());
    expect(await service.isSponsored(buildUserOperation({ sender: TEST_SENDER }))).toBe(true);
  });

  it("returns false on 0x paymasterAndData", async () => {
    mockFetchSuccess({ result: { paymasterAndData: "0x" } });
    const service = new PaymasterService(createServiceConfig());
    expect(await service.isSponsored(buildUserOperation({ sender: TEST_SENDER }))).toBe(false);
  });

  it("returns false on network error", async () => {
    mockFetchNetworkError();
    const service = new PaymasterService(createServiceConfig());
    expect(await service.isSponsored(buildUserOperation({ sender: TEST_SENDER }))).toBe(false);
  });
});

// ─── sponsorInfo Tests ──────────────────────────────────────────────────

describe("sponsorInfo tracking", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("is set after successful verifying paymaster call", async () => {
    mockFetchSuccess({ result: { paymasterAndData: "0xinfo", sponsor: { name: "Test Sponsor" } } });
    const service = new PaymasterService(createServiceConfig());
    await service.getPaymasterData(buildUserOperation({ sender: TEST_SENDER }));
    expect(service.sponsorInfo).toBe("Test Sponsor");
  });

  it("defaults when sponsor name is not returned", async () => {
    mockFetchSuccess({ result: { paymasterAndData: "0xinfo" } });
    const service = new PaymasterService(createServiceConfig());
    await service.getPaymasterData(buildUserOperation({ sender: TEST_SENDER }));
    expect(service.sponsorInfo).toBe("Sponsored by Paymaster");
  });
});

// ─── Multiple Paymaster Configurations ──────────────────────────────────

describe("multiple paymaster configurations", () => {
  it("supports different types and URLs", () => {
    const eth = new PaymasterService(createServiceConfig({ url: "https://paymaster.eth/rpc", type: "verifying" }));
    const polygon = new PaymasterService(createServiceConfig({ url: "https://paymaster.polygon/rpc", type: "sponsor" }));
    expect(eth).toBeInstanceOf(PaymasterService);
    expect(polygon).toBeInstanceOf(PaymasterService);
  });

  it("supports policy with allowedDapps and maxGasPerUserOp", () => {
    const service = new PaymasterService(createServiceConfig({
      type: "verifying",
      policy: { allowedDapps: ["https://app.naculus.com"], maxGasPerUserOp: 500000n },
    }));
    expect(service).toBeInstanceOf(PaymasterService);
  });
});

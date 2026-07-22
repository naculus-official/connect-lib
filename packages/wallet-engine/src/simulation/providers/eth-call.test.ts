import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EthCallProvider } from "./eth-call";

describe("EthCallProvider", () => {
  let provider: EthCallProvider;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    provider = new EthCallProvider();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("name is eth_call", () => {
    expect(provider.name).toBe("eth_call");
  });

  it("isAvailable returns true for any chain", () => {
    expect(provider.isAvailable(1)).toBe(true);
    expect(provider.isAvailable(999)).toBe(true);
    expect(provider.isAvailable(0)).toBe(true);
  });

  it("simulate returns unavailable when no RPC URL", async () => {
    const result = await provider.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
    );
    expect(result.status).toBe("unavailable");
    expect(result.provider).toBe("eth_call");
  });

  it("simulate returns success on valid RPC response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          jsonrpc: "2.0",
          id: 1,
          result:
            "0x0000000000000000000000000000000000000000000000000000000000000001",
        }),
      ok: true,
    });

    const p = new EthCallProvider("https://rpc.test");
    const result = await p.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
    );
    expect(result.status).toBe("success");
    expect(result.provider).toBe("eth_call");
    expect(result.changesDetected).toBe(true);
  });

  it("simulate returns reverted on RPC error with revert data", async () => {
    // Error(string) selector: 08c379a0
    // "Insufficient balance" encoded
    const errorData =
      "0x08c379a0" +
      "0000000000000000000000000000000000000000000000000000000000000020" +
      "0000000000000000000000000000000000000000000000000000000000000015" +
      "496e73756666696369656e742062616c616e6365000000000000000000000000";
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32000,
            message: "execution reverted",
            data: errorData,
          },
        }),
      ok: true,
    });

    const p = new EthCallProvider("https://rpc.test");
    const result = await p.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
    );
    expect(result.status).toBe("reverted");
    expect(result.revertReason?.replace(/\0/g, "")).toBe(
      "Insufficient balance",
    );
    expect(result.riskAssessment.warnings[0].severity).toBe("high");
  });

  it("simulate returns reverted on Panic(uint256)", async () => {
    // Panic(uint256) selector: 4e487b71, code 17 = Arithmetic overflow
    const errorData =
      "0x4e487b71" +
      "0000000000000000000000000000000000000000000000000000000000000011";
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32000,
            message: "execution reverted",
            data: errorData,
          },
        }),
      ok: true,
    });

    const p = new EthCallProvider("https://rpc.test");
    const result = await p.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
    );
    expect(result.status).toBe("reverted");
    expect(result.revertReason).toContain("Arithmetic overflow");
  });

  it("simulate returns reverted with raw error message when data is not parseable", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32000,
            message: "execution reverted: Not enough gas",
          },
        }),
      ok: true,
    });

    const p = new EthCallProvider("https://rpc.test");
    const result = await p.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
    );
    expect(result.status).toBe("reverted");
    expect(result.revertReason).toBe("execution reverted: Not enough gas");
  });

  it("simulate returns unavailable on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network failure"));

    const p = new EthCallProvider("https://rpc.test");
    const result = await p.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
    );
    expect(result.status).toBe("unavailable");
    expect(result.summary).toContain("network error");
  });

  it("simulate passes gas param when provided", async () => {
    let calledBody: any = null;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: any) => {
      calledBody = JSON.parse(opts.body);
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            jsonrpc: "2.0",
            id: 1,
            result: "0x",
          }),
        ok: true,
      });
    });

    const p = new EthCallProvider("https://rpc.test");
    await p.simulate(
      { to: "0x1234", data: "0x", value: "0x0", gas: "0x100000" },
      "0xabcd",
    );
    expect(calledBody.params[0].gas).toBe("0x100000");
  });

  it("constructor accepts rpcUrl", () => {
    const p = new EthCallProvider("https://custom.test");
    expect(p.name).toBe("eth_call");
  });
});

describe("parseRevertReason edge cases", () => {
  let provider: EthCallProvider;

  beforeEach(() => {
    provider = new EthCallProvider("https://rpc.test");
  });

  it("handles unknown error data (raw hex)", async () => {
    const errorData = "0xdeadbeef";
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32000,
            message: "execution reverted",
            data: errorData,
          },
        }),
      ok: true,
    });

    const result = await provider.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
    );
    expect(result.status).toBe("reverted");
    expect(result.revertReason).toBe("deadbeef");
  });

  it("handles panic code 0 (generic)", async () => {
    const errorData =
      "0x4e487b71" +
      "0000000000000000000000000000000000000000000000000000000000000000";
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32000,
            message: "execution reverted",
            data: errorData,
          },
        }),
      ok: true,
    });

    const result = await provider.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
    );
    expect(result.status).toBe("reverted");
    expect(result.revertReason).toBe("Generic panic");
  });

  it("handles panic code 18 (division by zero)", async () => {
    const errorData =
      "0x4e487b71" +
      "0000000000000000000000000000000000000000000000000000000000000012";
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32000,
            message: "execution reverted",
            data: errorData,
          },
        }),
      ok: true,
    });

    const result = await provider.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
    );
    expect(result.status).toBe("reverted");
    expect(result.revertReason).toBe("Division by zero");
  });

  it("handles generic panic code like 99", async () => {
    const errorData =
      "0x4e487b71" +
      "0000000000000000000000000000000000000000000000000000000000000063";
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32000,
            message: "execution reverted",
            data: errorData,
          },
        }),
      ok: true,
    });

    const result = await provider.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
    );
    expect(result.status).toBe("reverted");
    expect(result.revertReason).toBe("Panic code 99");
  });

  it("handles no error data (message only)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32000, message: "execution reverted: some reason" },
        }),
      ok: true,
    });

    const result = await provider.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
    );
    expect(result.status).toBe("reverted");
    expect(result.revertReason).toBe("execution reverted: some reason");
  });

  it("handles non-parseable Error(string) with bad length", async () => {
    // Error(string) but length is way too large
    const errorData =
      "0x08c379a0" +
      "0000000000000000000000000000000000000000000000000000000000000020" +
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" +
      "0000000000000000000000000000000000000000000000000000000000000000";
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32000,
            message: "execution reverted",
            data: errorData,
          },
        }),
      ok: true,
    });

    const result = await provider.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
    );
    expect(result.status).toBe("reverted");
  });
});

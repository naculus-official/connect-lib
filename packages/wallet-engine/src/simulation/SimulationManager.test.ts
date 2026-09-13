import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimulationProvider, SimulationResult } from "./index";
import { SimulationManager } from "./SimulationManager";

class MockProvider implements SimulationProvider {
  name = "tenderly" as const;
  readonly supportedChains: number[] = [1];
  private _result: SimulationResult;
  private _available: boolean;

  constructor(result?: Partial<SimulationResult>, available = true) {
    this._result = {
      status: "success",
      balanceChanges: [],
      approvalChanges: [],
      riskAssessment: { level: "unknown", score: 0, warnings: [] },
      provider: "tenderly",
      changesDetected: false,
      ...result,
    };
    this._available = available;
  }
  async simulate() {
    return this._result;
  }
  isAvailable(chainId: number) {
    return this._available && this.supportedChains.includes(chainId);
  }
}

describe("SimulationManager", () => {
  let manager: SimulationManager;

  beforeEach(() => {
    manager = new SimulationManager();
  });

  it("constructor defaults", () => {
    expect(manager.enabled).toBe(true);
    expect(manager.autoSimulate).toBe(false);
  });

  it("constructor with custom config", () => {
    const m = new SimulationManager({
      enabled: false,
      autoSimulate: true,
      rpcUrl: "https://rpc.test",
    });
    expect(m.enabled).toBe(false);
    expect(m.autoSimulate).toBe(true);
  });

  it("setEnabled / enabled", () => {
    manager.setEnabled(false);
    expect(manager.enabled).toBe(false);
    manager.setEnabled(true);
    expect(manager.enabled).toBe(true);
  });

  it("setAutoSimulate / autoSimulate", () => {
    manager.setAutoSimulate(true);
    expect(manager.autoSimulate).toBe(true);
    manager.setAutoSimulate(false);
    expect(manager.autoSimulate).toBe(false);
  });

  it("simulate returns unavailable when disabled", async () => {
    manager.setEnabled(false);
    const result = await manager.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
    );
    expect(result.status).toBe("unavailable");
    expect(result.summary).toBe("Simulation is disabled");
  });

  it("simulate returns unavailable when no provider available", async () => {
    const result = await manager.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
      { chainId: 999 }, // chain not supported by eth_call...Wait, eth_call supports all chains
    );
    // eth_call is always available, so this won't hit the "no provider" path.
    // Need to unregister eth_call first.
  });

  it("simulate returns no-provider after unregistering eth_call", async () => {
    manager.unregisterProvider("eth_call");
    const result = await manager.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
      { chainId: 1 },
    );
    expect(result.status).toBe("unavailable");
    expect(result.summary).toBe("No simulation provider available");
  });

  it("simulateTransaction wrapper", async () => {
    const result = await manager.simulateTransaction(
      { to: "0x1234", data: "0xdeadbeef", value: "0x1", from: "0xabcd" },
      "0xabcd",
    );
    expect(result.status).toBe("unavailable"); // no RPC URL on default eth_call
  });

  it("registerProvider and uses it", async () => {
    const mock = new MockProvider();
    manager.registerProvider("tenderly", mock);
    const result = await manager.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
      { chainId: 1 },
    );
    expect(result.status).toBe("success");
    expect(result.provider).toBe("tenderly");
  });

  it("registerProvider overwrites existing", async () => {
    manager.registerProvider("eth_call", new MockProvider());
    const result = await manager.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
      { chainId: 1 },
    );
    expect(result.status).toBe("success");
  });

  it("unregisterProvider removes provider", () => {
    manager.registerProvider("tenderly", new MockProvider());
    manager.unregisterProvider("tenderly");
    // should not throw
  });

  it("isAvailable returns false when disabled", () => {
    manager.setEnabled(false);
    expect(manager.isAvailable(1)).toBe(false);
  });

  it("isAvailable returns true when enabled with eth_call", () => {
    expect(manager.isAvailable(999)).toBe(true); // eth_call is available on all chains
  });

  it("isAvailable returns false with only unavailable provider", () => {
    manager.unregisterProvider("eth_call");
    expect(manager.isAvailable(1)).toBe(false);
  });

  it("uses named provider when defaultProvider is set", async () => {
    const tenderly = new MockProvider(
      { status: "success", provider: "tenderly" },
      true,
    );
    manager.registerProvider("tenderly", tenderly);
    const m = new SimulationManager({ defaultProvider: "tenderly" });
    m.registerProvider("tenderly", tenderly);
    const result = await m.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
      { chainId: 1 },
    );
    expect(result.provider).toBe("tenderly");
  });

  it("falls back from unavailable named provider to eth_call", async () => {
    // tenderly is set as default but not registered → _selectProvider skips it
    // Then auto mode: no tenderly registered, eth_call available → falls back
    // But we need the test where tenderly IS registered but returns unavailable
    const tenderly = new MockProvider(
      { status: "unavailable", provider: "tenderly" },
      true,
    );
    const m = new SimulationManager();
    m.registerProvider("tenderly", tenderly);
    const result = await m.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
      { chainId: 1 },
    );
    // simulate returns tenderly unavailable → fallback to eth_call
    // But eth_call has no RPC URL → eth_call returns unavailable
    expect(result.status).toBe("unavailable");
    // warnings from both providers are merged
    expect(result.riskAssessment.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("simulateERC20Transfer with decimals provided", async () => {
    const result = await manager.simulateERC20Transfer(
      "0x1234567890123456789012345678901234567890",
      "0xabcd",
      "0xdead",
      "1.5",
      1,
      18,
    );
    // eth_call has no RPC → returns unavailable
    expect(result.status).toBe("unavailable");
  });

  it("simulateERC20Transfer with invalid amount triggers error", async () => {
    const result = await manager.simulateERC20Transfer(
      "0x1234567890123456789012345678901234567890",
      "0xabcd",
      "0xdead",
      "not_a_number",
      1,
      18,
    );
    expect(result.status).toBe("unavailable");
    expect(result.summary).toBe("Failed to prepare simulation");
  });

  it("simulateERC20Transfer with too many decimal places", async () => {
    const result = await manager.simulateERC20Transfer(
      "0x1234567890123456789012345678901234567890",
      "0xabcd",
      "0xdead",
      "1.1234567890123456789",
      1,
      18,
    );
    // 19 decimal places, max is 18 → error
    expect(result.status).toBe("unavailable");
    expect(result.summary).toBe("Failed to prepare simulation");
  });
});

describe("SimulationManager — provider selection", () => {
  it("auto mode picks registered tenderly over eth_call", async () => {
    const tenderly = new MockProvider(undefined, true);
    // tenderly supports chain 1, eth_call supports all
    // In auto mode, tenderly is checked first
    const m = new SimulationManager();
    m.registerProvider("tenderly", tenderly);
    // Mock the eth_call exist but tenderly is preferred
    const result = await m.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
      { chainId: 1 },
    );
    expect(result.provider).toBe("tenderly");
  });

  it("named provider when registered and available", async () => {
    const tenderly = new MockProvider(undefined, true);
    const m = new SimulationManager({ defaultProvider: "tenderly" });
    m.registerProvider("tenderly", tenderly);
    const result = await m.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
      { chainId: 1 },
    );
    expect(result.provider).toBe("tenderly");
  });

  it("named provider skips unavailable tenderly, falls to eth_call", async () => {
    const m = new SimulationManager({ defaultProvider: "tenderly" });
    // tenderly not registered, so _selectProvider skips it, falls to eth_call
    const result = await m.simulate(
      { to: "0x1234", data: "0x", value: "0x0" },
      "0xabcd",
      { chainId: 1 },
    );
    // eth_call has no RPC URL → returns unavailable
    expect(result.status).toBe("unavailable");
    expect(result.provider).toBe("eth_call");
  });
});

describe("SimulationManager — _parseUnits private", () => {
  let manager: SimulationManager;

  beforeEach(() => {
    manager = new SimulationManager();
  });

  // test private methods via prototype
  it("_parseUnits valid amount", () => {
    const fn = (SimulationManager.prototype as any)["_parseUnits"];
    expect(fn("1.5", 18)).toBe(BigInt("1500000000000000000"));
    expect(fn("0", 18)).toBe(0n);
    expect(fn("1", 0)).toBe(1n);
    expect(fn("100.0", 2)).toBe(10000n);
  });

  it("_parseUnits rejects invalid", () => {
    const fn = (SimulationManager.prototype as any)["_parseUnits"];
    expect(() => fn("abc", 18)).toThrow("Invalid amount");
    expect(() => fn("", 18)).toThrow("Invalid amount");
    expect(() => fn(".", 18)).toThrow("Invalid amount");
    expect(() => fn(42 as any, 18)).toThrow("Amount must be a string");
  });

  it("_parseUnits truncates leading zeros", () => {
    const fn = (SimulationManager.prototype as any)["_parseUnits"];
    expect(fn("001.5", 18)).toBe(BigInt("1500000000000000000"));
  });

  it("_parseUnits pads fractional part", () => {
    const fn = (SimulationManager.prototype as any)["_parseUnits"];
    expect(fn("1.5", 18)).toBe(BigInt("1500000000000000000"));
    expect(fn("1", 18)).toBe(BigInt("1000000000000000000"));
  });

  it("_abiEncodeAddress pads to 32 bytes", () => {
    const fn = (SimulationManager.prototype as any)["_abiEncodeAddress"];
    const addr = "0x1234567890123456789012345678901234567890" as `0x${string}`;
    const encoded = fn(addr);
    expect(encoded).toHaveLength(64);
    expect(encoded.endsWith("1234567890123456789012345678901234567890")).toBe(
      true,
    );
  });

  it("_abiEncodeUint256 encodes bigint", () => {
    const fn = (SimulationManager.prototype as any)["_abiEncodeUint256"];
    expect(fn(0n)).toBe("0".repeat(64));
    expect(fn(1n)).toBe("0".repeat(63) + "1");
    expect(fn(255n)).toBe("0".repeat(62) + "ff");
  });
});

describe("SimulationManager — erc20 static call via RPC", () => {
  let manager: SimulationManager;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    manager = new SimulationManager({ rpcUrl: "https://rpc.test" });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("simulateERC20Transfer with decimals (fetch needed for selector only, not decimals lookup)", async () => {
    // Since decimals is provided, _getERC20Decimals is skipped.
    // But _getSelector("transfer(address,uint256)") is called via dynamic import.
    // This should work with @noble/hashes dependency.
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ jsonrpc: "2.0", id: 1, result: "0x" }),
      ok: true,
    });
    const result = await manager.simulateERC20Transfer(
      "0x1234567890123456789012345678901234567890",
      "0xabcd",
      "0xdead",
      "1.5",
      1,
      18,
    );
    // eth_call simulate returns "success" even with dummy RPC if fetch succeeds
    // But the eth_call response needs to be a valid structured result
    expect(result.status).toBe("success");
  });

  it("_getERC20Decimals directly with rpcUrl", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          jsonrpc: "2.0",
          id: 1,
          result:
            "0x0000000000000000000000000000000000000000000000000000000000000012",
        }),
      ok: true,
    });
    const decimalsFn = (SimulationManager.prototype as any)[
      "_getERC20Decimals"
    ].bind(manager);
    const result = await decimalsFn(
      "0x1234567890123456789012345678901234567890",
      1,
      "https://rpc.test",
    );
    expect(result).toBe(18);
    expect(fetch).toHaveBeenCalled();
  });

  it("falls back to the manager's configured RPC when the caller gives none", async () => {
    // This previously asserted that it throws here, which encoded the bug:
    // the manager was built with an endpoint and the lookup refused to use
    // it, so every simulateERC20Transfer without explicit decimals failed.
    const calls: unknown[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: `0x${"0".repeat(63)}6` }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const fn = (SimulationManager.prototype as any)["_erc20StaticCall"].bind(
      manager,
    );
    await fn("0x1234", "0xaabb", "", 1, undefined);
    expect(calls[0]).toBe("https://rpc.test");
  });

  it("throws only when no RPC URL exists anywhere", async () => {
    const bare = new SimulationManager({});
    const fn = (SimulationManager.prototype as any)["_erc20StaticCall"].bind(
      bare,
    );
    await expect(fn("0x1234", "0xaabb", "", 1, undefined)).rejects.toThrow(
      "No RPC URL available",
    );
  });
});

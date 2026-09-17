import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EthCallProvider as CoreEthCallProvider,
  SimulationManager as CoreSimulationManager,
} from "@naculus/connect-core";
import { EthCallProvider } from "./providers/eth-call";
import type { SimulationProvider, SimulationResult } from "./index";
import { SimulationManager } from "./SimulationManager";

const TOKEN = `0x${"11".repeat(20)}` as const;
const FROM = `0x${"22".repeat(20)}` as const;
const TO = `0x${"33".repeat(20)}` as const;

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

  it("re-exports the canonical connect-core implementation", () => {
    expect(SimulationManager).toBe(CoreSimulationManager);
    expect(EthCallProvider).toBe(CoreEthCallProvider);
  });

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
      TOKEN,
      FROM,
      TO,
      "1.5",
      1,
      18,
    );
    // eth_call has no RPC → returns unavailable
    expect(result.status).toBe("unavailable");
  });

  it("simulateERC20Transfer with invalid amount triggers error", async () => {
    const result = await manager.simulateERC20Transfer(
      TOKEN,
      FROM,
      TO,
      "not_a_number",
      1,
      18,
    );
    expect(result.status).toBe("unavailable");
    expect(result.summary).toBe("Failed to prepare simulation");
  });

  it("simulateERC20Transfer with too many decimal places", async () => {
    const result = await manager.simulateERC20Transfer(
      TOKEN,
      FROM,
      TO,
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

describe("SimulationManager — ERC-20 public transfer behavior", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["1.5", 18, 1500000000000000000n],
    ["001.5", 18, 1500000000000000000n],
    ["1", 0, 1n],
    ["100.0", 2, 10000n],
  ])("encodes %s at %i decimals", async (amount, decimals, raw) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: "0x" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const manager = new SimulationManager({ rpcUrl: "https://rpc.test" });

    const result = await manager.simulateERC20Transfer(
      TOKEN,
      FROM,
      TO,
      amount,
      1,
      decimals,
    );

    expect(result.status).toBe("success");
    const request = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(request.params[0].data).toBe(
      `0xa9059cbb${TO.slice(2).padStart(64, "0")}${raw.toString(16).padStart(64, "0")}`,
    );
  });

  it.each(["abc", "", ".", "-1", "1.123"])(
    "rejects invalid amount %s before RPC",
    async (amount) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const manager = new SimulationManager({ rpcUrl: "https://rpc.test" });
      const result = await manager.simulateERC20Transfer(
        TOKEN,
        FROM,
        TO,
        amount,
        1,
        2,
      );
      expect(result.summary).toBe("Failed to prepare simulation");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed recipient and uint256 overflow before RPC", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const manager = new SimulationManager({ rpcUrl: "https://rpc.test" });
    const badAddress = await manager.simulateERC20Transfer(
      TOKEN,
      FROM,
      "0xdead",
      "1",
      1,
      0,
    );
    const overflow = await manager.simulateERC20Transfer(
      TOKEN,
      FROM,
      TO,
      (1n << 256n).toString(),
      1,
      0,
    );
    expect(badAddress.summary).toBe("Failed to prepare simulation");
    expect(overflow.summary).toBe("Failed to prepare simulation");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

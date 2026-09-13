import { beforeEach, describe, expect, it, vi } from "vitest";
import { SimulationManager } from "./SimulationManager";

/**
 * Coverage exists so a caller can tell "examined, nothing found" from "not
 * examined". Without it an empty `balanceChanges` means both, and a UI renders
 * the second as the first — "no balance changes" beside a Sign button reads as
 * reassurance when nothing was inspected.
 */

const TX = {
  to: `0x${"11".repeat(20)}`,
  data: "0x" as const,
  value: "0x0",
  from: `0x${"22".repeat(20)}`,
} as never;
const FROM = `0x${"22".repeat(20)}` as const;

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: "0x" }),
    }),
  );
});

describe("SimulationResult coverage", () => {
  it("reports that eth_call examined nothing it cannot examine", async () => {
    const manager = new SimulationManager({
      enabled: true,
      rpcUrl: "https://rpc.example",
      autoSimulate: false,
    });
    const result = await manager.simulate(TX, FROM, { chainId: 1 });

    expect(result.coverage).toEqual({
      balanceChanges: false,
      approvalChanges: false,
      risk: false,
    });
  });

  it("never claims coverage it does not have alongside empty arrays", async () => {
    // The invariant: if the arrays are empty and coverage says true, a caller
    // may present "no changes" as a finding. Anything else must not.
    const manager = new SimulationManager({
      enabled: true,
      rpcUrl: "https://rpc.example",
      autoSimulate: false,
    });
    const result = await manager.simulate(TX, FROM, { chainId: 1 });

    if (result.balanceChanges.length === 0) {
      expect(result.coverage?.balanceChanges).not.toBe(true);
    }
  });

  it("reports no coverage when simulation is disabled", async () => {
    const manager = new SimulationManager({ enabled: false });
    const result = await manager.simulate(TX, FROM, { chainId: 1 });
    expect(result.coverage?.balanceChanges).not.toBe(true);
    expect(result.coverage?.risk).not.toBe(true);
  });

  it("leaves risk coverage false while the level is unknown", async () => {
    const manager = new SimulationManager({
      enabled: true,
      rpcUrl: "https://rpc.example",
      autoSimulate: false,
    });
    const result = await manager.simulate(TX, FROM, { chainId: 1 });
    if (result.riskAssessment.level === "unknown") {
      expect(result.coverage?.risk).not.toBe(true);
    }
  });
});

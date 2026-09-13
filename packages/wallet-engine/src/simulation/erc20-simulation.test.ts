import { beforeEach, describe, expect, it, vi } from "vitest";
import { SimulationManager } from "./SimulationManager";

/**
 * The default path of simulateERC20Transfer.
 *
 * Called without an explicit `decimals` it always failed, even when the
 * manager had been given a perfectly good RPC URL: the decimals lookup read
 * only the caller's `rpcUrl` argument, and nothing forwarded one. It failed
 * silently too — returning `status: "unavailable"` rather than throwing — so a
 * UI showed no preview and the user signed with nothing to check.
 */

const TOKEN = `0x${"11".repeat(20)}` as const;
const FROM = `0x${"22".repeat(20)}` as const;
const TO = `0x${"33".repeat(20)}` as const;

/** decimals() returning 6, then a successful eth_call. */
function stubRpc() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      result:
        "0x0000000000000000000000000000000000000000000000000000000000000006",
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("simulateERC20Transfer decimals lookup", () => {
  it("uses the manager's configured RPC when the caller gives none", async () => {
    const fetchMock = stubRpc();
    const manager = new SimulationManager({
      enabled: true,
      rpcUrl: "https://configured.example",
      autoSimulate: false,
    });

    const result = await manager.simulateERC20Transfer(TOKEN, FROM, TO, "1", 1);

    expect(result.summary).not.toBe("Failed to prepare simulation");
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][0]).toBe("https://configured.example");
  });

  it("does not report a missing RPC URL when one was configured", async () => {
    stubRpc();
    const manager = new SimulationManager({
      enabled: true,
      rpcUrl: "https://configured.example",
      autoSimulate: false,
    });

    const result = await manager.simulateERC20Transfer(TOKEN, FROM, TO, "1", 1);
    const messages = (result.riskAssessment?.warnings ?? []).map(
      (w) => w.message,
    );
    expect(messages.join(" ")).not.toMatch(/No RPC URL available/);
  });

  it("prefers an explicit per-call RPC URL over the configured one", async () => {
    // `simulate` already honoured a per-call endpoint; this path never
    // forwarded one, so the override was unreachable from the ERC-20 helper.
    const fetchMock = stubRpc();
    const manager = new SimulationManager({
      enabled: true,
      rpcUrl: "https://configured.example",
      autoSimulate: false,
    });

    await manager.simulateERC20Transfer(
      TOKEN,
      FROM,
      TO,
      "1",
      1,
      undefined,
      "https://override.example",
    );

    expect(fetchMock.mock.calls[0][0]).toBe("https://override.example");
  });

  it("skips the lookup when decimals are supplied", async () => {
    const fetchMock = stubRpc();
    const manager = new SimulationManager({
      enabled: true,
      rpcUrl: "https://configured.example",
      autoSimulate: false,
    });

    await manager.simulateERC20Transfer(TOKEN, FROM, TO, "1", 1, 6);

    // One call for the simulation itself, none for decimals.
    const decimalsSelector = "0x313ce567";
    const bodies = fetchMock.mock.calls.map((c) => String(c[1]?.body ?? ""));
    expect(bodies.some((b) => b.includes(decimalsSelector))).toBe(false);
  });

  it("still reports a missing RPC URL when there genuinely is none", async () => {
    stubRpc();
    const manager = new SimulationManager({
      enabled: true,
      autoSimulate: false,
    });
    const result = await manager.simulateERC20Transfer(TOKEN, FROM, TO, "1", 1);
    const messages = (result.riskAssessment?.warnings ?? []).map(
      (w) => w.message,
    );
    expect(messages.join(" ")).toMatch(/No RPC URL available/);
  });
});

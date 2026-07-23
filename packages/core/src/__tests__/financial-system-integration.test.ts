import { describe, it, expect, vi } from "vitest";
import { ConnectorManager, createConnectorManager } from "../connector-manager";
import { WalletError } from "../errors";
import type { UniversalConnector, BatchCall } from "../connector";
import type { UniversalWalletSession } from "../session";
import { NAMESPACE_EIP155 } from "../constants";
import { parseUnits, formatUnits } from "../token/units";

function createMockConnector(name: string, namespace: string): UniversalConnector {
  let session: UniversalWalletSession | null = null;
  return {
    id: `mock-${name}`,
    name,
    kind: "mock",
    namespaces: [namespace],
    supports: { desktop: true, mobile: false, deepLink: false, qr: false, trustedReconnect: true },
    async connect() {
      session = {
        id: `session-${name}-${Date.now()}`,
        connectorId: `mock-${name}`,
        namespaces: { [namespace]: { chains: [`${namespace}:1`], accounts: [`${namespace}:1:0xdead`], methods: [], events: [] } },
        expiry: Date.now() + 300_000,
      };
      return session;
    },
    async disconnect() { session = null; },
    async getAccounts() { return [`0xdead`]; },
    async signMessage(_s, input) { return `0x${"ab".repeat(32)}`; },
    async sendTransaction(_s, tx: any) { return `0x${"cd".repeat(32)}`; },
    async switchChain(_s, chainId) {},
    async sendCalls(_s, calls: BatchCall[]) { return `0x${"ef".repeat(32)}`; },
    async getCapabilities() { return {}; },
    async getBalance() { return "1000000000000000000"; },
  };
}

describe("Financial System Integration: Core Pipeline", () => {
  it("parseUnits preserves precision across 18 decimals", () => {
    const vals = [
      ["0.000000000000000001", 1n],
      ["1", 10n ** 18n],
      ["1.234567890123456789", 1234567890123456789n],
      ["1000000", 10n ** 24n],
    ];
    for (const [input, expected] of vals) {
      expect(parseUnits(input as string, 18)).toBe(expected as bigint);
    }
  });

  it("formatUnits round-trips exactly", () => {
    const original = "1.234567890123456789";
    const parsed = parseUnits(original, 18);
    const formatted = formatUnits(parsed, 18);
    expect(formatted).toBe(original);
  });

  it("formatUnits handles zero", () => {
    expect(formatUnits(0n, 18)).toBe("0");
  });

  it("formatUnits handles large amounts", () => {
    expect(formatUnits(parseUnits("1000000", 18), 18)).toBe("1000000");
  });

  it("parseUnits rejects negative values", () => {
    expect(() => parseUnits("-1", 18)).toThrow();
    expect(() => parseUnits("-0.5", 6)).toThrow();
  });

  it("parseUnits rejects too many decimals", () => {
    expect(() => parseUnits("1.1234567", 6)).toThrow();
  });
});

describe("Financial System Integration: ConnectorManager", () => {
  it("creates manager with EVM connector and connects", async () => {
    const connector = createMockConnector("MetaMask", NAMESPACE_EIP155);
    const manager = createConnectorManager();
    manager.register("mock-MetaMask", connector);
    const session = await manager.connect("mock-MetaMask");
    expect(session.id).toMatch(/^session-MetaMask-/);
    expect(session.connectorId).toBe("mock-MetaMask");
  });

  it("signs message and returns hex string", async () => {
    const connector = createMockConnector("test", NAMESPACE_EIP155);
    const manager = createConnectorManager();
    manager.register("mock-test", connector);
    const session = await manager.connect("mock-test");
    const sig = await manager.signMessage(session, "hello");
    expect(sig).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("sends transaction and returns tx hash", async () => {
    const connector = createMockConnector("test", NAMESPACE_EIP155);
    const manager = createConnectorManager();
    manager.register("mock-test", connector);
    const session = await manager.connect("mock-test");
    const hash = await manager.sendTransaction(session, { to: "0xdead", value: "0x1" });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("sendCalls returns bundle hash", async () => {
    const connector = createMockConnector("test", NAMESPACE_EIP155);
    const manager = createConnectorManager();
    manager.register("mock-test", connector);
    const session = await manager.connect("mock-test");
    const calls: BatchCall[] = [
      { to: "0xdead", value: "0x1" },
      { to: "0xbeef", value: "0x2" },
    ];
    const hash = await manager.sendCalls?.(session, calls);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("getBalance returns string bigint", async () => {
    const connector = createMockConnector("test", NAMESPACE_EIP155);
    const manager = createConnectorManager();
    manager.register("mock-test", connector);
    const session = await manager.connect("mock-test");
    const balance = await manager.getBalance?.(session);
    expect(balance).toBe("1000000000000000000");
    expect(() => BigInt(balance!)).not.toThrow();
  });

  it("disconnects session", async () => {
    const connector = createMockConnector("test", NAMESPACE_EIP155);
    const manager = createConnectorManager();
    manager.register("mock-test", connector);
    const session = await manager.connect("mock-test");
    await manager.disconnect(session);
    expect(manager.getActiveSession()).toBeNull();
  });

  it("switches chain", async () => {
    const connector = createMockConnector("test", NAMESPACE_EIP155);
    const manager = createConnectorManager();
    manager.register("mock-test", connector);
    const session = await manager.connect("mock-test");
    await expect(manager.switchChain(session, "eip155:137")).resolves.not.toThrow();
  });
});

describe("Financial System Integration: Multi-Connector Orchestration", () => {
  it("manages multiple connector sessions independently", async () => {
    const c1 = createMockConnector("WalletA", NAMESPACE_EIP155);
    const c2 = createMockConnector("WalletB", NAMESPACE_EIP155);
    const manager = createConnectorManager();
    manager.register("mock-WalletA", c1);
    manager.register("mock-WalletB", c2);

    const s1 = await manager.connect("mock-WalletA");
    const s2 = await manager.connect("mock-WalletB");

    expect(s1.connectorId).toBe("mock-WalletA");
    expect(s2.connectorId).toBe("mock-WalletB");
    expect(s1.id).not.toBe(s2.id);
  });

  it("errors on unknown connector", async () => {
    const c1 = createMockConnector("OnlyWallet", NAMESPACE_EIP155);
    const manager = createConnectorManager();
    manager.register("mock-OnlyWallet", c1);
    await expect(manager.connect("nonexistent")).rejects.toThrow();
  });
});

describe("Financial System Integration: Value Safety", () => {
  it("no Number() conversion on financial values", () => {
    const large = parseUnits("1000000", 18);
    expect(typeof large).toBe("bigint");
    expect(large).toBe(10n ** 24n);
  });

  it("sum of transfers does not overflow", () => {
    const amounts = ["1000", "2000", "3000", "4000", "5000"].map((a) => parseUnits(a, 18));
    const total = amounts.reduce((s, v) => s + v, 0n);
    expect(total).toBe(parseUnits("15000", 18));
  });

  it("dust accumulation (10^6 wei transfers)", () => {
    const dust = Array.from({ length: 1_000_000 }, () => 1n);
    const total = dust.reduce((s, v) => s + v, 0n);
    expect(total).toBe(1_000_000n);
    expect(typeof total).toBe("bigint");
  });

  it("BigInt arithmetic is precise (no floating point trap)", () => {
    const a = parseUnits("0.1", 18);
    const b = parseUnits("0.2", 18);
    const c = parseUnits("0.3", 18);
    expect(a + b).toBe(c);
    expect(a + b).toBe(300000000000000000n);
  });

  it("rejects NaN or Infinity input", () => {
    expect(() => parseUnits(NaN, 18)).toThrow();
    expect(() => parseUnits(Infinity, 18)).toThrow();
  });
});

describe("Financial System Integration: Cross-Namespace Value Handling", () => {
  it("Solana lamports use 9 decimals", () => {
    const sol = parseUnits("1", 9);
    expect(sol).toBe(1_000_000_000n);
  });

  it("XRPL drops use 6 decimals", () => {
    const xrp = parseUnits("1", 6);
    expect(xrp).toBe(1_000_000n);
  });

  it("converts between decimal bases", () => {
    const ethAmount = parseUnits("1", 18);
    const usdcAmount = parseUnits("1", 6);
    expect(ethAmount).toBe(10n ** 18n);
    expect(usdcAmount).toBe(10n ** 6n);
  });
});

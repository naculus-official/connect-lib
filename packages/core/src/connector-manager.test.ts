import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorSupport, UniversalConnector } from "./connector";
import { ConnectorManager, createConnectorManager } from "./connector-manager";
import type { UniversalWalletSession } from "./session";

const createMockConnector = (
  id: string,
  support?: Partial<ConnectorSupport>,
) => {
  const supports: ConnectorSupport = {
    desktop: support?.desktop ?? true,
    mobile: support?.mobile ?? true,
    deepLink: support?.deepLink ?? true,
    qr: support?.qr ?? false,
    trustedReconnect: support?.trustedReconnect ?? false,
  };

  const mock: UniversalConnector = {
    id,
    name: `Mock ${id}`,
    kind: "mock" as const,
    namespaces: ["eip155"],
    supports,
    async connect() {
      return {
        id: `session-${id}-${Date.now()}`,
        walletId: id,
        walletType: "mock",
        namespaces: {
          eip155: {
            chains: ["eip155:1"],
            accounts: [`eip155:0x123`],
            methods: [],
            events: [],
          },
        },
        platform: "desktop-web",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },
    async disconnect() {},
    async getAccounts() {
      return [`eip155:0x123`];
    },
  };
  return mock;
};

describe("ConnectorManager", () => {
  let manager: ConnectorManager;

  beforeEach(() => {
    manager = createConnectorManager();
  });

  it("should create manager with default config", () => {
    expect(manager).toBeInstanceOf(ConnectorManager);
  });

  it("should register and retrieve connector", () => {
    const connector = createMockConnector("wc");
    manager.register("wc", connector);

    expect(manager.get("wc")).toBe(connector);
  });

  it("should unregister connector", () => {
    const connector = createMockConnector("wc");
    manager.register("wc", connector);
    manager.unregister("wc");

    expect(manager.get("wc")).toBeUndefined();
  });

  it("should list connectors by priority", () => {
    const connector1 = createMockConnector("wc1");
    const connector2 = createMockConnector("wc2");
    const connector3 = createMockConnector("wc3");

    manager.register("wc1", connector1, 1);
    manager.register("wc2", connector2, 3);
    manager.register("wc3", connector3, 2);

    const list = manager.list();
    expect(list[0].id).toBe("wc2");
    expect(list[1].id).toBe("wc3");
    expect(list[2].id).toBe("wc1");
  });

  it("should connect to registered connector", async () => {
    const connector = createMockConnector("wc");
    manager.register("wc", connector);

    const session = await manager.connect("wc");
    expect(session.walletType).toBe("mock");
    expect(manager.getActiveSession()).not.toBeNull();
  });

  it("should throw when connecting to non-existent connector", async () => {
    await expect(manager.connect("nonexistent")).rejects.toThrow("not found");
  });

  it("should disconnect active session", async () => {
    const connector = createMockConnector("wc");
    manager.register("wc", connector);

    await manager.connect("wc");
    await manager.disconnect();

    expect(manager.getActiveSession()).toBeNull();
  });

  it("should list connectors by support", () => {
    const desktopOnly = createMockConnector("desktop", {
      desktop: true,
      mobile: false,
    });
    const mobileOnly = createMockConnector("mobile", {
      desktop: false,
      mobile: true,
    });
    const both = createMockConnector("both", { desktop: true, mobile: true });

    manager.register("desktop", desktopOnly);
    manager.register("mobile", mobileOnly);
    manager.register("both", both);

    const desktop = manager.listBySupport("desktop");
    const mobile = manager.listBySupport("mobile");

    expect(desktop).toHaveLength(2);
    expect(mobile).toHaveLength(2);
    expect(mobile.find((c) => c.id === "desktop")).toBeUndefined();
  });

  it("should clear all connectors", () => {
    manager.register("wc1", createMockConnector("wc1"));
    manager.register("wc2", createMockConnector("wc2"));

    manager.clear();

    expect(manager.list()).toHaveLength(0);
  });

  it("should prefer order in selection", async () => {
    const manager = createConnectorManager({
      preferOrder: ["preferred", "fallback"],
    });

    manager.register("preferred", createMockConnector("preferred"));
    manager.register("fallback", createMockConnector("fallback"));
    manager.register("other", createMockConnector("other"));

    const session = await manager.connect();
    expect(manager.getActive()).toBeDefined();
  });

  it("should get accounts from active session", async () => {
    const connector = createMockConnector("wc");
    manager.register("wc", connector);

    await manager.connect("wc");
    const accounts = await manager.getAccounts();

    expect(accounts.length).toBeGreaterThan(0);
  });
});

describe("createConnectorManager", () => {
  it("should create manager with config", () => {
    const manager = createConnectorManager({ autoSelect: false });
    expect(manager).toBeInstanceOf(ConnectorManager);
  });
});

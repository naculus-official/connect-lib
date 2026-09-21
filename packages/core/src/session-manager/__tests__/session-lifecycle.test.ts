import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConnectorSupport,
  SessionChange,
  UniversalConnector,
} from "../../connector";
import { createConnectorManager } from "../../connector-manager";
import type { UniversalWalletSession } from "../../session";
import { createSessionManager, type SessionManager } from "../session-manager";

/**
 * CAIP-25 lifecycle: a connector reports what the wallet did to a session;
 * the manager applies it fail-closed. These tests drive a fake connector's
 * onSessionChanged directly.
 */

const supports: ConnectorSupport = {
  desktop: true,
  mobile: true,
  deepLink: false,
  qr: false,
  trustedReconnect: false,
};

function lifecycleConnector(id = "wc") {
  const handlers = new Map<string, (change: SessionChange) => void>();
  let counter = 0;
  const connector: UniversalConnector = {
    id,
    name: id,
    kind: "walletconnect",
    namespaces: ["eip155", "solana"],
    supports,
    async connect() {
      counter++;
      return {
        id: `s${counter}`,
        topic: `topic-${counter}`,
        walletId: id,
        walletType: id,
        namespaces: {
          eip155: {
            chains: ["eip155:1", "eip155:137"],
            accounts: ["eip155:1:0xabc", "eip155:137:0xabc"],
            methods: ["eth_sendTransaction", "personal_sign"],
            events: ["chainChanged", "accountsChanged"],
          },
        },
        platform: "desktop-web",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as UniversalWalletSession;
    },
    disconnect: vi.fn(async () => {}),
    async getAccounts() {
      return ["eip155:1:0xabc"];
    },
    async switchChain() {},
    onSessionChanged(session, handler) {
      handlers.set(session.id, handler);
      return () => {
        handlers.delete(session.id);
      };
    },
  };
  const emit = (sessionId: string, change: SessionChange) =>
    handlers.get(sessionId)?.(change);
  return { connector, emit, handlers };
}

describe("SessionManager CAIP-25 lifecycle", () => {
  let manager: SessionManager;
  let fake: ReturnType<typeof lifecycleConnector>;

  beforeEach(() => {
    fake = lifecycleConnector();
    const connectors = createConnectorManager();
    connectors.register("wc", fake.connector);
    manager = createSessionManager(connectors);
  });

  it("applies a narrowed scope immediately and moves the active chain off a dropped one", async () => {
    const bundle = await manager.connect("wc", "eip155:137");
    const scopeChanged = vi.fn();
    const chainChanged = vi.fn();
    manager.on("sessionScopeChanged", scopeChanged);
    manager.on("chainChanged", chainChanged);

    fake.emit(bundle.walletSession.id, {
      type: "scope",
      namespaces: {
        eip155: {
          chains: ["eip155:1"],
          accounts: ["eip155:1:0xabc"],
          methods: ["eth_sendTransaction", "personal_sign"],
          events: ["chainChanged", "accountsChanged"],
        },
      },
    });
    await vi.waitFor(() => expect(scopeChanged).toHaveBeenCalledOnce());

    expect(bundle.walletSession.namespaces.eip155.chains).toEqual(["eip155:1"]);
    expect(bundle.walletSession.namespaces.eip155.accounts).toEqual([
      "eip155:1:0xabc",
    ]);
    expect(bundle.chainSessions.has("eip155:137")).toBe(false);
    expect(bundle.activeChainId).toBe("eip155:1");
    expect(chainChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        previousChainId: "eip155:137",
        newChainId: "eip155:1",
      }),
    );
  });

  it("never widens: chains, methods and namespaces the app never held are rejected", async () => {
    const bundle = await manager.connect("wc", "eip155:1");
    const scopeChanged = vi.fn();
    manager.on("sessionScopeChanged", scopeChanged);

    fake.emit(bundle.walletSession.id, {
      type: "scope",
      namespaces: {
        eip155: {
          chains: ["eip155:1", "eip155:137", "eip155:10"],
          accounts: ["eip155:1:0xabc", "eip155:137:0xabc", "eip155:10:0xabc"],
          methods: ["eth_sendTransaction", "personal_sign", "eth_sign"],
          events: ["chainChanged", "accountsChanged"],
        },
        solana: {
          chains: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
          accounts: [],
          methods: ["solana_signMessage"],
          events: [],
        },
      },
    });
    await vi.waitFor(() => expect(scopeChanged).toHaveBeenCalledOnce());

    const ns = bundle.walletSession.namespaces;
    expect(Object.keys(ns)).toEqual(["eip155"]);
    expect(ns.eip155.chains).toEqual(["eip155:1", "eip155:137"]);
    expect(ns.eip155.accounts).not.toContain("eip155:10:0xabc");
    expect(ns.eip155.methods).not.toContain("eth_sign");
    expect(scopeChanged.mock.calls[0][0].rejectedChains).toEqual([
      "eip155:10",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    ]);
  });

  it("treats a scope that keeps nothing as a revocation and clears persistence", async () => {
    const bundle = await manager.connect("wc", "eip155:1");
    const revoked = vi.fn();
    const disconnected = vi.fn();
    manager.on("sessionRevoked", revoked);
    manager.on("sessionDisconnected", disconnected);

    fake.emit(bundle.walletSession.id, {
      type: "scope",
      namespaces: {
        eip155: {
          chains: ["eip155:10"],
          accounts: [],
          methods: [],
          events: [],
        },
      },
    });
    await vi.waitFor(() => expect(revoked).toHaveBeenCalledOnce());

    expect(revoked.mock.calls[0][0]).toMatchObject({
      reason: "scope_emptied",
      sessionId: "s1",
    });
    expect(disconnected).toHaveBeenCalledOnce();
    expect(manager.getActiveBundle()).toBeNull();
    expect(await manager.restoreFromPersistence()).toBe(false);
    // The connector was not asked to disconnect: the wallet already ended it.
    expect(fake.connector.disconnect).not.toHaveBeenCalled();
  });

  it("wallet revocation and expiry tear down; a stale event for a replaced session is ignored", async () => {
    const first = await manager.connect("wc", "eip155:1");
    const firstHandler = fake.handlers.get(first.walletSession.id);
    await manager.disconnect();
    // Unsubscribed on disconnect: the connector no longer holds a handler.
    expect(fake.handlers.has(first.walletSession.id)).toBe(false);

    const second = await manager.connect("wc", "eip155:1");
    const revoked = vi.fn();
    manager.on("sessionRevoked", revoked);
    // A late event from the first session must not touch the second.
    firstHandler?.({ type: "revoked", reason: "expired" });
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.getActiveBundle()).toBe(second);
    expect(revoked).not.toHaveBeenCalled();

    fake.emit(second.walletSession.id, {
      type: "expiry",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    await vi.waitFor(() =>
      expect(second.walletSession.expiry).toBe("2030-01-01T00:00:00.000Z"),
    );

    fake.emit(second.walletSession.id, { type: "revoked", reason: "wallet" });
    await vi.waitFor(() => expect(revoked).toHaveBeenCalledOnce());
    expect(revoked.mock.calls[0][0]).toMatchObject({
      reason: "wallet",
      topic: "topic-2",
    });
    expect(manager.getActiveBundle()).toBeNull();
  });

  it("getSession finds by id or topic; revokeSession disconnects and tears down with reason app", async () => {
    const bundle = await manager.connect("wc", "eip155:1");
    expect(manager.getSession("s1")).toBe(bundle);
    expect(manager.getSession("topic-1")).toBe(bundle);
    expect(manager.getSession("nope")).toBeNull();

    const revoked = vi.fn();
    manager.on("sessionRevoked", revoked);
    await manager.revokeSession("topic-1");
    expect(fake.connector.disconnect).toHaveBeenCalledOnce();
    expect(revoked.mock.calls[0][0]).toMatchObject({ reason: "app" });
    expect(manager.getSession("s1")).toBeNull();
    expect(manager.getActiveBundle()).toBeNull();
  });
});

describe("SessionManager CAIP-25 lifecycle — second-pass findings", () => {
  it("re-subscribes after restoreFromPersistence so a post-reload revocation is observed", async () => {
    const fake = lifecycleConnector();
    const connectors = createConnectorManager();
    connectors.register("wc", fake.connector);
    const first = createSessionManager(connectors);
    const bundle = await first.connect("wc", "eip155:1");

    // Fresh manager over the same connector, as after a page reload.
    const second = createSessionManager(connectors);
    // Share persistence by copying what the first one saved.
    (second as unknown as { persistence: unknown }).persistence = (
      first as unknown as { persistence: unknown }
    ).persistence;
    expect(await second.restoreFromPersistence()).toBe(true);
    const revoked = vi.fn();
    second.on("sessionRevoked", revoked);

    fake.emit(bundle.walletSession.id, { type: "revoked", reason: "wallet" });
    await vi.waitFor(() => expect(revoked).toHaveBeenCalled());
    expect(second.getActiveBundle()).toBeNull();
  });

  it("does not let a change on an inactive session overwrite the persisted active one", async () => {
    const fake = lifecycleConnector();
    const connectors = createConnectorManager();
    connectors.register("wc", fake.connector);
    const manager = createSessionManager(connectors);
    const inactive = await manager.connect("wc", "eip155:1");
    const active = await manager.connect("wc", "eip155:137");
    expect(manager.getActiveBundle()).toBe(active);

    const expiryChanged = vi.fn();
    manager.on("sessionExpiryChanged", expiryChanged);
    fake.emit(inactive.walletSession.id, {
      type: "expiry",
      expiresAt: "2031-01-01T00:00:00.000Z",
    });
    await vi.waitFor(() => expect(expiryChanged).toHaveBeenCalledOnce());

    const restored = createSessionManager(connectors);
    (restored as unknown as { persistence: unknown }).persistence = (
      manager as unknown as { persistence: unknown }
    ).persistence;
    expect(await restored.restoreFromPersistence()).toBe(true);
    expect(restored.getActiveBundle()?.walletSession.id).toBe(
      active.walletSession.id,
    );
  });
});

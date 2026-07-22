import { beforeEach, describe, expect, it } from "vitest";
import {
  AutoReconnectManager,
  createAutoReconnectManager,
} from "./auto-reconnect";
import type { UniversalWalletSession } from "./session";

describe("AutoReconnectManager", () => {
  let manager: AutoReconnectManager;

  beforeEach(() => {
    manager = new AutoReconnectManager<UniversalWalletSession>({
      enabled: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  it("should return false when no session is stored", async () => {
    const result = await manager.reconnect(async () => {});
    expect(result).toBe(false);
  });

  it("should set last session", () => {
    const mockSession = { id: "test" } as UniversalWalletSession;
    manager.setLastSession(mockSession);
    expect(manager.needsReconnect()).toBe(true);
  });

  it("should return false when disabled", async () => {
    manager = new AutoReconnectManager({ enabled: false });
    const mockSession = { id: "test" } as UniversalWalletSession;
    manager.setLastSession(mockSession);
    const result = await manager.reconnect(async () => {});
    expect(result).toBe(false);
  });

  it("should reconnect successfully", async () => {
    const mockSession = { id: "test" } as UniversalWalletSession;
    manager.setLastSession(mockSession);

    const result = await manager.reconnect(async () => {});
    expect(result).toBe(true);
  });

  it("should cancel reconnection", () => {
    const mockSession = { id: "test" } as UniversalWalletSession;
    manager.setLastSession(mockSession);
    manager.cancel();
    expect(manager.getState().isReconnecting).toBe(false);
  });

  it("should clear session", () => {
    const mockSession = { id: "test" } as UniversalWalletSession;
    manager.setLastSession(mockSession);
    manager.clearSession();
    expect(manager.needsReconnect()).toBe(false);
  });

  it("should update config", () => {
    manager.updateConfig({ maxRetries: 5 });
    expect(manager.getState()).toBeDefined();
  });

  it("should reset manager", () => {
    const mockSession = { id: "test" } as UniversalWalletSession;
    manager.setLastSession(mockSession);
    manager.reset();
    expect(manager.needsReconnect()).toBe(false);
  });

  it("should handle typed session", () => {
    const mockSession = {
      id: "test-session",
      walletId: "wallet-1",
      walletType: "walletconnect",
      namespaces: {},
      platform: "desktop-web",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as UniversalWalletSession;

    manager.setLastSession(mockSession);
    expect(manager.needsReconnect()).toBe(true);

    const state = manager.getState();
    expect(state.lastSession).toBe(mockSession);
    expect(state.lastSession?.id).toBe("test-session");
  });
});

describe("createAutoReconnectManager", () => {
  it("should create manager with config", () => {
    const manager = createAutoReconnectManager<UniversalWalletSession>({
      enabled: true,
      maxRetries: 5,
    });
    expect(manager).toBeInstanceOf(AutoReconnectManager);
  });

  it("should use default generic type", () => {
    const manager = createAutoReconnectManager();
    expect(manager).toBeInstanceOf(AutoReconnectManager);
  });
});

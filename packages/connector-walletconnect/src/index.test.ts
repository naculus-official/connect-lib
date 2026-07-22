import {
  createEmptySession,
  type UniversalWalletSession,
} from "@naculus/connect-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWalletConnectConnector, WalletConnectConnector } from "./index";

const TEST_PROJECT_ID = "test-project-id";
const TEST_METADATA = {
  name: "Test",
  description: "Test Description",
  url: "https://test.com",
  icons: [],
};

function makeConfig(overrides = {}) {
  return { projectId: TEST_PROJECT_ID, metadata: TEST_METADATA, ...overrides };
}

function createMockSession(overrides = {}): UniversalWalletSession {
  return createEmptySession({
    id: "test-session-id",
    topic: "test-topic",
    walletId: "test-wallet",
    walletType: "walletconnect",
    namespaces: {
      eip155: {
        chains: ["eip155:1"],
        accounts: ["eip155:1:0x1234567890123456789012345678901234567890"],
        methods: ["eth_requestAccounts", "personal_sign"],
        events: ["accountsChanged", "chainChanged"],
      },
    },
    platform: "desktop-web",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
}

describe("WalletConnectConnector", () => {
  describe("constructor", () => {
    it("should create instance", () => {
      const c = new WalletConnectConnector(makeConfig());
      expect(c).toBeDefined();
    });

    it("should set id/name/kind", () => {
      const c = new WalletConnectConnector(makeConfig());
      expect(c.id).toBe("walletconnect");
      expect(c.name).toBe("WalletConnect");
      expect(c.kind).toBe("walletconnect");
    });

    it("should set namespaces", () => {
      const c = new WalletConnectConnector(makeConfig());
      expect(c.namespaces).toContain("eip155");
      expect(c.namespaces).toContain("solana");
    });

    it("should set support flags", () => {
      const c = new WalletConnectConnector(makeConfig());
      expect(c.supports.desktop).toBe(true);
      expect(c.supports.mobile).toBe(true);
      expect(c.supports.deepLink).toBe(true);
      expect(c.supports.qr).toBe(true);
      expect(c.supports.trustedReconnect).toBe(true);
    });
  });

  describe("properties", () => {
    it("should have initial client undefined when not provided", () => {
      const c = new WalletConnectConnector(makeConfig());
      expect((c as unknown as { client: unknown }).client).toBeUndefined();
    });

    it("should expose config", () => {
      const c = new WalletConnectConnector(makeConfig());
      expect(c.config.projectId).toBe(TEST_PROJECT_ID);
    });

    it("should have initial uri undefined", () => {
      const c = new WalletConnectConnector(makeConfig());
      expect(c.uri).toBeUndefined();
    });
  });

  describe("disconnect", () => {
    it("should return without error when session has no topic", async () => {
      const c = new WalletConnectConnector(makeConfig());
      const sessionWithoutTopic = createMockSession({ topic: undefined });
      await expect(c.disconnect(sessionWithoutTopic)).resolves.not.toThrow();
    });
  });

  describe("getAccounts", () => {
    it("should return accounts when session has no topic", async () => {
      const c = new WalletConnectConnector(makeConfig());
      const sessionWithoutTopic = createMockSession({ topic: undefined });
      const accounts = await c.getAccounts(sessionWithoutTopic);
      expect(accounts.length).toBeGreaterThan(0);
    });
  });

  describe("signMessage", () => {
    it("should throw error when session has no topic", async () => {
      const c = new WalletConnectConnector(makeConfig());
      const sessionWithoutTopic = createMockSession({ topic: undefined });
      await expect(
        c.signMessage(sessionWithoutTopic, {
          message: "test",
          address: "0x1234567890123456789012345678901234567890",
        }),
      ).rejects.toThrow();
    });
  });

  describe("sendTransaction", () => {
    it("should throw error when session has no topic", async () => {
      const c = new WalletConnectConnector(makeConfig());
      const sessionWithoutTopic = createMockSession({ topic: undefined });
      await expect(
        c.sendTransaction(sessionWithoutTopic, {
          transaction: { to: "0x0", value: "0x0", data: "0x" },
        }),
      ).rejects.toThrow();
    });
  });
});

describe("createWalletConnectConnector", () => {
  it("should create via factory", () => {
    const c = createWalletConnectConnector(makeConfig());
    expect(c).toBeInstanceOf(WalletConnectConnector);
  });

  it("should pass config", () => {
    const c = createWalletConnectConnector(makeConfig());
    expect(c.config.projectId).toBe(TEST_PROJECT_ID);
  });
});

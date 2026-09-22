/// <reference types="vitest" />
/// @vitest-environment jsdom

import { createEmptySession, WalletError } from "@naculus/connect-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WalletConnectConnector } from "./index";
import { buildRequiredNamespaces } from "./namespaces";

const TEST_PROJECT_ID = "test-project-id";
const TEST_METADATA = {
  name: "Test DApp",
  description: "Test Description",
  url: "https://test.dapp.com",
  icons: ["https://test.dapp.com/icon.png"],
};
const REQUIRED_EVM = buildRequiredNamespaces().eip155;

function createMockSignClient() {
  const mockSession = createWCSessionMock();

  return {
    init: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue({
      uri: "wc://mock-uri",
      approval: vi.fn().mockResolvedValue(mockSession),
    }),
    session: {
      get: vi.fn().mockReturnValue(mockSession),
      getAll: vi.fn().mockReturnValue([mockSession]),
    },
    request: vi.fn().mockResolvedValue("0xsignature"),
    disconnect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };
}

function createMockSession(overrides = {}) {
  return createEmptySession({
    id: "test-session-id",
    topic: "mock-topic",
    walletId: "Mock Wallet",
    walletType: "walletconnect",
    namespaces: {
      eip155: {
        chains: ["eip155:1", "eip155:137", "eip155:8453"],
        accounts: ["eip155:1:0x1234567890123456789012345678901234567890"],
        methods: [...REQUIRED_EVM.methods],
        events: [...REQUIRED_EVM.events],
      },
    },
    platform: "desktop-web",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
}

function createWCSessionMock(overrides = {}) {
  return {
    topic: "mock-topic",
    namespaces: {
      eip155: {
        chains: ["eip155:1", "eip155:137", "eip155:8453"],
        accounts: ["eip155:1:0x1234567890123456789012345678901234567890"],
        methods: [...REQUIRED_EVM.methods],
        events: [...REQUIRED_EVM.events],
      },
    },
    peer: {
      metadata: {
        name: "Mock Wallet",
        description: "Mock Wallet Description",
        url: "https://mock.wallet",
        icons: ["https://mock.wallet/icon.png"],
      },
    },
    ...overrides,
  };
}

describe("WalletConnectConnector Integration Tests", () => {
  describe("connect", () => {
    it("should establish connection and create session", async () => {
      const mockClient = createMockSignClient();
      const connector = new WalletConnectConnector({
        projectId: TEST_PROJECT_ID,
        metadata: TEST_METADATA,
        client: mockClient as any,
      });

      const session = await connector.connect();

      expect(session).toBeDefined();
      expect(session.topic).toBe("mock-topic");
      expect(session.walletType).toBe("walletconnect");
      expect(session.namespaces.eip155).toBeDefined();
      expect(mockClient.connect).toHaveBeenCalledTimes(1);
    });

    it("should handle user rejection", async () => {
      const mockClient = createMockSignClient();
      mockClient.connect.mockRejectedValue(
        new Error("User rejected the request"),
      );

      const connector = new WalletConnectConnector({
        projectId: TEST_PROJECT_ID,
        metadata: TEST_METADATA,
        client: mockClient as any,
      });

      await expect(connector.connect()).rejects.toThrow(
        "User rejected the request",
      );
    });
  });

  describe("reconnect", () => {
    it("should restore existing session", async () => {
      const mockClient = createMockSignClient();
      const connector = new WalletConnectConnector({
        projectId: TEST_PROJECT_ID,
        metadata: TEST_METADATA,
        client: mockClient as any,
      });

      const originalSession = createMockSession();
      const restoredSession = await connector.reconnect(originalSession);

      expect(restoredSession).toBeDefined();
      expect(restoredSession.topic).toBe(originalSession.topic);
      expect(mockClient.session.get).toHaveBeenCalledWith(
        originalSession.topic,
      );
    });

    it("should throw when session not found", async () => {
      const mockClient = createMockSignClient();
      mockClient.session.get.mockReturnValue(undefined);

      const connector = new WalletConnectConnector({
        projectId: TEST_PROJECT_ID,
        metadata: TEST_METADATA,
        client: mockClient as any,
      });

      const sessionWithoutTopic = createMockSession({
        topic: "non-existent-topic",
      });

      await expect(connector.reconnect(sessionWithoutTopic)).rejects.toThrow(
        "WalletConnect session not found",
      );
    });
  });

  describe("disconnect", () => {
    it("should disconnect cleanly", async () => {
      const mockClient = createMockSignClient();
      const connector = new WalletConnectConnector({
        projectId: TEST_PROJECT_ID,
        metadata: TEST_METADATA,
        client: mockClient as any,
      });

      const session = createMockSession();

      await connector.disconnect(session);

      expect(mockClient.disconnect).toHaveBeenCalledWith({
        topic: session.topic,
        reason: {
          code: 6000,
          message: "User disconnected",
        },
      });
    });

    it("should handle session without topic", async () => {
      const mockClient = createMockSignClient();
      const connector = new WalletConnectConnector({
        projectId: TEST_PROJECT_ID,
        metadata: TEST_METADATA,
        client: mockClient as any,
      });

      const sessionWithoutTopic = createMockSession({ topic: undefined });

      await expect(
        connector.disconnect(sessionWithoutTopic),
      ).resolves.not.toThrow();
      expect(mockClient.disconnect).not.toHaveBeenCalled();
    });
  });

  describe("getAccounts", () => {
    it("should return accounts from session", async () => {
      const mockClient = createMockSignClient();
      const connector = new WalletConnectConnector({
        projectId: TEST_PROJECT_ID,
        metadata: TEST_METADATA,
        client: mockClient as any,
      });

      const session = createMockSession();
      const accounts = await connector.getAccounts(session);

      expect(accounts).toContain(
        "eip155:1:0x1234567890123456789012345678901234567890",
      );
    });
  });

  describe("signMessage", () => {
    it("should sign message using personal_sign with correct params", async () => {
      const mockClient = createMockSignClient();
      const connector = new WalletConnectConnector({
        projectId: TEST_PROJECT_ID,
        metadata: TEST_METADATA,
        client: mockClient as any,
      });

      const session = createMockSession();
      const signature = await connector.signMessage(session, {
        message: "Hello, World!",
        address: "0x1234567890123456789012345678901234567890",
      });

      expect(signature).toBe("0xsignature");
      expect(mockClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            method: "personal_sign",
            // Ethereum personal_sign uses [message, address]
            params: [
              "0x48656c6c6f2c20576f726c6421",
              "0x1234567890123456789012345678901234567890",
            ],
          }),
        }),
      );
    });

    it("should sign message with CAIP-10 address (strip namespace prefix)", async () => {
      const mockClient = createMockSignClient();
      const connector = new WalletConnectConnector({
        projectId: TEST_PROJECT_ID,
        metadata: TEST_METADATA,
        client: mockClient as any,
      });

      const session = createMockSession();
      const signature = await connector.signMessage(session, {
        message: "Test message",
        address: "eip155:1:0x1234567890123456789012345678901234567890",
      });

      expect(signature).toBe("0xsignature");
      expect(mockClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            method: "personal_sign",
            params: [
              expect.stringMatching(/^0x[0-9a-f]+$/),
              "0x1234567890123456789012345678901234567890",
            ],
          }),
        }),
      );
    });

    it("should sign typed data using eth_signTypedData_v4", async () => {
      const mockClient = createMockSignClient();
      const connector = new WalletConnectConnector({
        projectId: TEST_PROJECT_ID,
        metadata: TEST_METADATA,
        client: mockClient as any,
      });

      const session = createMockSession();
      const signature = await connector.signMessage(session, {
        message: JSON.stringify({ domain: {}, message: {} }),
        address: "0x1234567890123456789012345678901234567890",
      });

      expect(signature).toBe("0xsignature");
      expect(mockClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            method: "eth_signTypedData_v4",
          }),
        }),
      );
    });

    it("should throw when session has no topic", async () => {
      const mockClient = createMockSignClient();
      const connector = new WalletConnectConnector({
        projectId: TEST_PROJECT_ID,
        metadata: TEST_METADATA,
        client: mockClient as any,
      });

      const sessionWithoutTopic = createMockSession({ topic: undefined });

      await expect(
        connector.signMessage(sessionWithoutTopic, {
          message: "Hello",
          address: "0x1234567890123456789012345678901234567890",
        }),
      ).rejects.toThrow("WalletConnect session missing topic.");
    });

    it("does not fall back to eth_sign when personal_sign is not authorized", async () => {
      const mockClient = createMockSignClient();
      // eth_sign signs an arbitrary digest; a wallet that refuses
      // personal_sign gets a signature_rejected error, not a blind-sign prompt.
      mockClient.request.mockRejectedValue(
        new Error(
          "The requested method and/or account has not been authorized by the user.",
        ),
      );
      const connector = new WalletConnectConnector({
        projectId: TEST_PROJECT_ID,
        metadata: TEST_METADATA,
        client: mockClient as any,
      });
      const session = createMockSession();
      await expect(
        connector.signMessage(session, {
          message: "Hello, World!",
          address: "0x1234567890123456789012345678901234567890",
        }),
      ).rejects.toMatchObject({ code: "signature_rejected" });
      expect(mockClient.request).toHaveBeenCalledTimes(1);
      expect(mockClient.request.mock.calls[0][0]).toMatchObject({
        request: { method: "personal_sign" },
      });
    });
    it("should switch to Polygon mainnet", async () => {
      const mockClient = createMockSignClient();
      const connector = new WalletConnectConnector({
        projectId: TEST_PROJECT_ID,
        metadata: TEST_METADATA,
        client: mockClient as any,
      });

      const session = createMockSession();
      await connector.switchChain(session, "eip155:137");

      expect(mockClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          chainId: "eip155:137",
          request: expect.objectContaining({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x89" }],
          }),
        }),
      );
    });

    it("should throw when trying to switch to Solana chain", async () => {
      const mockClient = createMockSignClient();
      const connector = new WalletConnectConnector({
        projectId: TEST_PROJECT_ID,
        metadata: TEST_METADATA,
        client: mockClient as any,
      });

      const session = createMockSession();

      await expect(
        connector.switchChain(
          session,
          "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        ),
      ).rejects.toThrow("WalletConnect switchChain only supports EVM chains");
    });
  });

  describe("deepLink", () => {
    beforeEach(() => {
      Object.defineProperty(window, "location", {
        value: { assign: vi.fn() },
        writable: true,
      });
    });

    it("should generate deep link URL", async () => {
      const mockClient = createMockSignClient();
      mockClient.connect.mockResolvedValue({
        uri: "wc://test-uri",
        approval: vi.fn(),
      });

      const connector = new WalletConnectConnector({
        projectId: TEST_PROJECT_ID,
        metadata: TEST_METADATA,
        client: mockClient as any,
      });

      await connector.startPairing();

      await connector.deepLink("mywallet://");

      expect(window.location.assign).toHaveBeenCalledWith(
        "mywallet://?uri=wc%3A%2F%2Ftest-uri",
      );
    });

    it("should throw when URI is not available", async () => {
      const mockClient = createMockSignClient();
      const connector = new WalletConnectConnector({
        projectId: TEST_PROJECT_ID,
        metadata: TEST_METADATA,
        client: mockClient as any,
      });

      await expect(connector.deepLink("mywallet://")).rejects.toThrow(
        "WalletConnect URI unavailable",
      );
    });
  });

  describe("startPairing and completePairing", () => {
    it("should support step-by-step pairing flow", async () => {
      const mockClient = createMockSignClient();
      const connector = new WalletConnectConnector({
        projectId: TEST_PROJECT_ID,
        metadata: TEST_METADATA,
        client: mockClient as any,
      });

      const uri = await connector.startPairing();
      expect(uri).toBe("wc://mock-uri");
      expect(connector.uri).toBe("wc://mock-uri");

      const session = await connector.completePairing();
      expect(session).toBeDefined();
      expect(session.topic).toBe("mock-topic");
    });
  });

  describe("properties", () => {
    it("should expose correct id and name", () => {
      const connector = new WalletConnectConnector({
        projectId: TEST_PROJECT_ID,
        metadata: TEST_METADATA,
      });

      expect(connector.id).toBe("walletconnect");
      expect(connector.name).toBe("WalletConnect");
      expect(connector.kind).toBe("walletconnect");
    });

    it("should expose correct namespaces", () => {
      const connector = new WalletConnectConnector({
        projectId: TEST_PROJECT_ID,
        metadata: TEST_METADATA,
      });

      expect(connector.namespaces).toContain("eip155");
      expect(connector.namespaces).toContain("solana");
    });

    it("should expose correct support flags", () => {
      const connector = new WalletConnectConnector({
        projectId: TEST_PROJECT_ID,
        metadata: TEST_METADATA,
      });

      expect(connector.supports).toEqual({
        desktop: true,
        mobile: true,
        deepLink: true,
        qr: true,
        trustedReconnect: true,
      });
    });
  });
});

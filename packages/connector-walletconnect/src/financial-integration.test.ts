import { createEmptySession } from "@naculus/connect-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WalletConnectConnector } from "./index";

const TEST_PROJECT_ID = "test-project-id";
const TEST_METADATA = {
  name: "Test DApp",
  description: "Test Description",
  url: "https://test.dapp.com",
  icons: ["https://test.dapp.com/icon.png"],
};

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
    request: vi.fn().mockResolvedValue("0xresult"),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

function createWCSessionMock(overrides = {}) {
  return {
    topic: "mock-topic",
    namespaces: {
      eip155: {
        chains: ["eip155:1"],
        accounts: ["eip155:1:0x1234567890123456789012345678901234567890"],
        methods: [
          "eth_sendTransaction",
          "personal_sign",
          "wallet_switchEthereumChain",
          "wallet_sendCalls",
        ],
        events: ["accountsChanged", "chainChanged"],
      },
    },
    peer: {
      metadata: { name: "Mock Wallet", description: "", url: "", icons: [] },
    },
    ...overrides,
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
        chains: ["eip155:1"],
        accounts: ["eip155:1:0x1234567890123456789012345678901234567890"],
        methods: [
          "eth_sendTransaction",
          "personal_sign",
          "wallet_switchEthereumChain",
          "wallet_sendCalls",
        ],
        events: ["accountsChanged", "chainChanged"],
      },
    },
    platform: "desktop-web",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
}

function createConnector(client?: ReturnType<typeof createMockSignClient>) {
  return new WalletConnectConnector({
    projectId: TEST_PROJECT_ID,
    metadata: TEST_METADATA,
    client: (client ?? createMockSignClient()) as any,
  });
}

describe("WalletConnect Financial Integration", () => {
  // ═══════════════════════════════════════════════════════════════
  // 1. sendTransaction — hex value conversion
  // ═══════════════════════════════════════════════════════════════

  describe("sendTransaction", () => {
    it("sends tx with decimal value converted to hex", async () => {
      const mockClient = createMockSignClient();
      const connector = createConnector(mockClient);
      const session = createMockSession();

      const result = await connector.sendTransaction(session, {
        transaction: {
          to: "0x" + "ab".repeat(20),
          value: "1000000000000000000",
          data: "0x",
        },
        chainId: "eip155:1",
      });

      expect(result).toBe("0xresult");
      expect(mockClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            method: "eth_sendTransaction",
            params: [expect.objectContaining({ value: "0xde0b6b3a7640000" })],
          }),
        }),
      );
    });

    it("passes hex value through unchanged", async () => {
      const mockClient = createMockSignClient();
      const connector = createConnector(mockClient);
      const session = createMockSession();

      await connector.sendTransaction(session, {
        transaction: {
          to: "0x" + "ab".repeat(20),
          value: "0x1234",
          data: "0x",
        },
        chainId: "eip155:1",
      });

      expect(mockClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            params: [expect.objectContaining({ value: "0x1234" })],
          }),
        }),
      );
    });

    it("sends zero value tx", async () => {
      const mockClient = createMockSignClient();
      const connector = createConnector(mockClient);
      const session = createMockSession();

      await connector.sendTransaction(session, {
        transaction: { to: "0x" + "ab".repeat(20), value: "0", data: "0x" },
        chainId: "eip155:1",
      });

      expect(mockClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            params: [expect.objectContaining({ value: "0x0" })],
          }),
        }),
      );
    });

    it("returns tx hash on success", async () => {
      const mockClient = createMockSignClient();
      mockClient.request.mockResolvedValue("0x" + "ab".repeat(32));
      const connector = createConnector(mockClient);
      const session = createMockSession();

      const hash = await connector.sendTransaction(session, {
        transaction: { to: "0x" + "ab".repeat(20), value: "0x1", data: "0x" },
        chainId: "eip155:1",
      });

      expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("throws on missing transaction", async () => {
      const connector = createConnector();
      const session = createMockSession();

      await expect(
        connector.sendTransaction(session, { chainId: "eip155:1" }),
      ).rejects.toThrow("Missing transaction");
    });

    it("throws on invalid input", async () => {
      const connector = createConnector();
      const session = createMockSession();

      await expect(
        connector.sendTransaction(session, "invalid" as any),
      ).rejects.toThrow("Invalid input");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 2. signMessage
  // ═══════════════════════════════════════════════════════════════

  describe("signMessage", () => {
    it("signs with personal_sign and returns hex signature", async () => {
      const mockClient = createMockSignClient();
      mockClient.request.mockResolvedValue("0x" + "ab".repeat(65));
      const connector = createConnector(mockClient);
      const session = createMockSession();

      const sig = await connector.signMessage(session, {
        message: "Hello",
        address: "0x1234567890123456789012345678901234567890",
      });

      expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    });

    it("signs with eth_signTypedData_v4 for JSON messages", async () => {
      const mockClient = createMockSignClient();
      mockClient.request.mockResolvedValue("0x" + "cd".repeat(65));
      const connector = createConnector(mockClient);
      const session = createMockSession();

      await connector.signMessage(session, {
        message: JSON.stringify({ types: {}, domain: {}, message: {} }),
        address: "0x1234567890123456789012345678901234567890",
      });

      expect(mockClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({ method: "eth_signTypedData_v4" }),
        }),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 3. switchChain — session update
  // ═══════════════════════════════════════════════════════════════

  describe("switchChain", () => {
    it("switches to Polygon (eip155:137 → 0x89)", async () => {
      const mockClient = createMockSignClient();
      const connector = createConnector(mockClient);
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

    it("switches to Base (eip155:8453 → 0x2105)", async () => {
      const mockClient = createMockSignClient();
      const connector = createConnector(mockClient);
      const session = createMockSession();

      await connector.switchChain(session, "eip155:8453");

      expect(mockClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            params: [{ chainId: "0x2105" }],
          }),
        }),
      );
    });

    it("throws on Solana chain switch", async () => {
      const connector = createConnector();
      const session = createMockSession();

      await expect(connector.switchChain(session, "solana:1")).rejects.toThrow(
        "only supports EVM chains",
      );
    });

    it("throws when session has no topic", async () => {
      const connector = createConnector();
      const session = createMockSession({ topic: undefined });

      await expect(
        connector.switchChain(session, "eip155:137"),
      ).rejects.toThrow("session missing topic");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 4. sendCalls — batch calls
  // ═══════════════════════════════════════════════════════════════

  describe("sendCalls", () => {
    it("sends batch calls via wallet_sendCalls", async () => {
      const mockClient = createMockSignClient();
      mockClient.request.mockResolvedValue("0x" + "ab".repeat(32));
      const connector = createConnector(mockClient);
      const session = createMockSession();

      const result = await connector.sendCalls(
        session,
        [
          { to: "0x" + "ab".repeat(20), value: "0x1", data: "0x" },
          { to: "0x" + "cd".repeat(20), value: "0x2", data: "0x" },
        ],
        "eip155:1",
      );

      expect(result).toMatch(/^0x[0-9a-f]{64}$/);
      expect(mockClient.request).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            method: "wallet_sendCalls",
            params: [
              {
                calls: [
                  { to: "0x" + "ab".repeat(20), value: "0x1", data: "0x" },
                  { to: "0x" + "cd".repeat(20), value: "0x2", data: "0x" },
                ],
                chainId: "eip155:1",
              },
            ],
          }),
        }),
      );
    });

    it("falls back to eth_sendTransaction when wallet_sendCalls unsupported", async () => {
      const mockClient = createMockSignClient();
      mockClient.request
        .mockRejectedValueOnce(new Error("method not found"))
        .mockResolvedValue("0x" + "aa".repeat(32));
      const connector = createConnector(mockClient);
      const session = createMockSession();

      const result = await connector.sendCalls(
        session,
        [{ to: "0x" + "ab".repeat(20), value: "0x1", data: "0x" }],
        "eip155:1",
      );

      expect(result).toMatch(/^0x[0-9a-f]{64}$/);
      expect(mockClient.request).toHaveBeenCalledTimes(2);
      expect(mockClient.request.mock.calls[1][0].request.method).toBe(
        "eth_sendTransaction",
      );
    });

    it("handles single call fallback returning hash", async () => {
      const mockClient = createMockSignClient();
      mockClient.request
        .mockRejectedValueOnce(new Error("not authorized"))
        .mockResolvedValue("0x" + "bb".repeat(32));
      const connector = createConnector(mockClient);
      const session = createMockSession();

      const result = await connector.sendCalls(
        session,
        [{ to: "0x" + "ab".repeat(20), value: "0x1", data: "0x" }],
        "eip155:1",
      );

      expect(result).toBe("0x" + "bb".repeat(32));
      expect(mockClient.request.mock.calls[1][0].request.method).toBe(
        "eth_sendTransaction",
      );
    });

    it("returns comma-joined hashes for multi-call fallback", async () => {
      const mockClient = createMockSignClient();
      mockClient.request
        .mockRejectedValueOnce(new Error("method not found"))
        .mockResolvedValueOnce("0x" + "aa".repeat(32))
        .mockResolvedValueOnce("0x" + "bb".repeat(32));
      const connector = createConnector(mockClient);
      const session = createMockSession();

      const result = await connector.sendCalls(
        session,
        [
          { to: "0x" + "ab".repeat(20), value: "0x1", data: "0x" },
          { to: "0x" + "cd".repeat(20), value: "0x2", data: "0x" },
        ],
        "eip155:1",
      );

      expect(result).toContain("0x");
      expect(result.split(",").length).toBe(2);
    });
  });
});

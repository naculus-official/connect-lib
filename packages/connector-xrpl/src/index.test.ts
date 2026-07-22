import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createXRPLConnector,
  formatXRPAmount,
  isValidXRPAddress,
  isValidXRPClassicAddress,
  parseXRPAmount,
  XRPLConnector,
  xrplConnector,
} from "./index";

describe("XRPLConnector", () => {
  describe("constructor", () => {
    it("should default to mainnet", () => {
      const connector = new XRPLConnector();
      expect(connector.getNetworkEndpoint()).toBe("wss://xrplcluster.com");
    });

    it("should set network to testnet", () => {
      const connector = new XRPLConnector("testnet");
      expect(connector.getNetworkEndpoint()).toBe(
        "wss://s.altnet.rippletest.net",
      );
    });

    it("should set network to devnet", () => {
      const connector = new XRPLConnector("devnet");
      expect(connector.getNetworkEndpoint()).toBe(
        "wss://s.devnet.rippletest.net",
      );
    });

    it("should have correct identity", () => {
      const connector = new XRPLConnector();
      expect(connector.id).toBe("xrpl");
      expect(connector.name).toBe("XRP Ledger (Xaman)");
      expect(connector.kind).toBe("xrpl");
      expect(connector.namespaces).toEqual(["xrpl"]);
      expect(connector.supports.desktop).toBe(true);
      expect(connector.supports.mobile).toBe(true);
      expect(connector.supports.deepLink).toBe(true);
      expect(connector.supports.qr).toBe(false);
      expect(connector.supports.trustedReconnect).toBe(false);
    });
  });

  describe("setNetwork", () => {
    it("should change network", () => {
      const connector = new XRPLConnector();
      connector.setNetwork("testnet");
      expect(connector.getNetworkEndpoint()).toBe(
        "wss://s.altnet.rippletest.net",
      );
    });
  });

  describe("isConnected", () => {
    it("should return false when not connected", () => {
      const connector = new XRPLConnector();
      expect(connector.isConnected()).toBe(false);
    });
  });

  describe("reconnect", () => {
    it("should throw session_expired error", async () => {
      const connector = new XRPLConnector();
      const session = {
        id: "test",
        walletId: "test",
        walletType: "xrpl" as const,
        namespaces: {
          xrpl: {
            chains: [] as string[],
            accounts: [] as string[],
            methods: [] as string[],
            events: [] as string[],
          },
        },
        platform: "desktop-web" as const,
        createdAt: "",
        updatedAt: "",
      };
      await expect(connector.reconnect(session)).rejects.toThrow(
        "cannot be restored",
      );
    });
  });

  describe("disconnect", () => {
    it("should disconnect wallet", async () => {
      const connector = new XRPLConnector();
      const session = {
        id: "test",
        topic: undefined as string | undefined,
        walletId: "test",
        walletType: "xrpl" as const,
        namespaces: {
          xrpl: {
            chains: [] as string[],
            accounts: [] as string[],
            methods: [] as string[],
            events: [] as string[],
          },
        },
        platform: "desktop-web" as const,
        createdAt: "",
        updatedAt: "",
      };
      await connector.disconnect(session);
      expect(connector.isConnected()).toBe(false);
    });
  });

  describe("connect", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it("should connect with valid Xaman response", async () => {
      const connector = new XRPLConnector();
      vi.stubGlobal("window", {
        addEventListener: vi.fn((event, handler: any) => {
          // Simulate Xaman response
          setTimeout(() => {
            handler({
              origin: "https://example.com",
              data: {
                type: "XAMAN_CONNECTED",
                wallet: {
                  address: "rG1Euv9U7M9dV5B7z9wJkZqAB",
                  publicKey: "PUBKEY123",
                },
              },
            });
          }, 50);
        }),
        removeEventListener: vi.fn(),
        document: {
          createElement: () => ({
            href: "",
            style: {},
            click: vi.fn(),
          }),
          body: {
            appendChild: vi.fn(),
            removeChild: vi.fn(),
          },
        },
        location: { origin: "https://example.com" },
      } as any);

      const promise = connector.connect();
      vi.advanceTimersByTime(100);
      const session = await promise;

      expect(connector.isConnected()).toBe(true);
      expect(session.walletId).toBe("rG1Euv9U7M9dV5B7z9wJkZqAB");
      expect(session.namespaces.xrpl.accounts).toContain(
        "xrpl:rG1Euv9U7M9dV5B7z9wJkZqAB",
      );
    });

    it("should throw in SSR (no window)", async () => {
      const connector = new XRPLConnector();
      vi.stubGlobal("window", undefined);
      await expect(connector.connect()).rejects.toThrow(
        "Browser environment required",
      );
    });
  });

  describe("signMessage", () => {
    it("should throw when not connected", async () => {
      const connector = new XRPLConnector();
      const session = {
        id: "test",
        namespaces: { xrpl: { chains: [], accounts: [] } },
      } as any;
      await expect(
        connector.signMessage(session, { message: "hello" }),
      ).rejects.toThrow("Session expired");
    });

    it("should throw on missing message", async () => {
      const connector = new XRPLConnector();
      (connector as any).activeSession = {
        wallet: {
          address: "rG1Euv9U7M9dV5B7z9wJkZqAB",
          publicKey: "PUBKEY123",
        },
      };
      const session = {
        namespaces: { xrpl: { chains: [], accounts: [] } },
      } as any;
      await expect(connector.signMessage(session, {} as any)).rejects.toThrow(
        "Missing message parameter",
      );
    });

    it("should throw when signTransaction times out", async () => {
      const connector = new XRPLConnector();
      (connector as any).activeSession = {
        wallet: {
          address: "rG1Euv9U7M9dV5B7z9wJkZqAB",
          publicKey: "PUBKEY123",
        },
      };
      vi.stubGlobal("window", {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        document: {
          createElement: () => ({
            href: "",
            style: {},
            click: vi.fn(),
          }),
          body: {
            appendChild: vi.fn(),
            removeChild: vi.fn(),
          },
        },
      } as any);
      vi.useFakeTimers();

      const session = {
        namespaces: { xrpl: { chains: [], accounts: [] } },
      } as any;
      const promise = connector.signMessage(session, { message: "hello" });
      vi.advanceTimersByTime(300001);
      await expect(promise).rejects.toThrow("timed out");

      vi.useRealTimers();
    });
  });

  describe("signTransaction", () => {
    it("should throw when not connected", async () => {
      const connector = new XRPLConnector();
      const session = {
        namespaces: { xrpl: { chains: [], accounts: [] } },
      } as any;
      await expect(connector.signTransaction(session, {})).rejects.toThrow(
        "Session expired",
      );
    });

    it("should throw on missing transaction", async () => {
      const connector = new XRPLConnector();
      (connector as any).activeSession = {
        wallet: {
          address: "rG1Euv9U7M9dV5B7z9wJkZqAB",
          publicKey: "PUBKEY123",
        },
      };
      const session = {
        namespaces: { xrpl: { chains: [], accounts: [] } },
      } as any;
      await expect(
        connector.signTransaction(session, {} as any),
      ).rejects.toThrow("Missing transaction parameter");
    });
  });

  describe("sendTransaction", () => {
    it("should delegate to signTransaction", async () => {
      const connector = new XRPLConnector();
      (connector as any).activeSession = {
        wallet: {
          address: "rG1Euv9U7M9dV5B7z9wJkZqAB",
          publicKey: "PUBKEY123",
        },
      };
      vi.stubGlobal("window", {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        document: {
          createElement: () => ({
            href: "",
            style: {},
            click: vi.fn(),
          }),
          body: {
            appendChild: vi.fn(),
            removeChild: vi.fn(),
          },
        },
      } as any);
      vi.useFakeTimers();

      const session = {
        namespaces: { xrpl: { chains: [], accounts: [] } },
      } as any;
      const promise = connector.sendTransaction(session, {
        transaction: {
          Account: "rG1Euv9U7M9dV5B7z9wJkZqAB",
          TransactionType: "Payment",
        },
      });
      vi.advanceTimersByTime(300001);
      await expect(promise).rejects.toThrow("timed out");

      vi.useRealTimers();
    });
  });

  describe("switchChain", () => {
    it("should update network for chainId 0 (mainnet)", () => {
      const connector = new XRPLConnector("testnet");
      const session = { namespaces: { xrpl: { chains: ["xrpl:1"] } } } as any;
      connector.switchChain(session, "xrpl:0");
      expect(connector.getNetworkEndpoint()).toBe("wss://xrplcluster.com");
      expect(session.namespaces.xrpl.chains).toContain("xrpl:0");
    });

    it("should switch to testnet for chainId 1", () => {
      const connector = new XRPLConnector();
      const session = { namespaces: { xrpl: { chains: ["xrpl:0"] } } } as any;
      connector.switchChain(session, "xrpl:1");
      expect(connector.getNetworkEndpoint()).toBe(
        "wss://s.altnet.rippletest.net",
      );
      expect(session.namespaces.xrpl.chains).toContain("xrpl:1");
    });

    it("should switch to devnet for unknown chainId", () => {
      const connector = new XRPLConnector();
      const session = { namespaces: { xrpl: { chains: ["xrpl:0"] } } } as any;
      connector.switchChain(session, "xrpl:99");
      expect(connector.getNetworkEndpoint()).toBe(
        "wss://s.devnet.rippletest.net",
      );
    });
  });

  describe("createPaymentTx", () => {
    it("should throw error when not connected", () => {
      const connector = new XRPLConnector();
      expect(() => connector.createPaymentTx("rXz...", "1000000")).toThrow(
        "Session expired",
      );
    });

    it("should create payment transaction when connected", () => {
      const connector = new XRPLConnector();
      (connector as any).activeSession = {
        wallet: {
          address: "rG1Euv9U7M9dV5B7z9wJkZqAB",
          publicKey: "PUBKEY123",
        },
      };
      const tx = connector.createPaymentTx("rReceiver", "1000000");
      expect(tx.TransactionType).toBe("Payment");
      expect(tx.Account).toBe("rG1Euv9U7M9dV5B7z9wJkZqAB");
      expect(tx.Destination).toBe("rReceiver");
      expect(tx.Amount).toBe("1000000");
    });

    it("should include destinationTag when provided", () => {
      const connector = new XRPLConnector();
      (connector as any).activeSession = {
        wallet: {
          address: "rG1Euv9U7M9dV5B7z9wJkZqAB",
          publicKey: "PUBKEY123",
        },
      };
      const tx = connector.createPaymentTx("rReceiver", "1000000", 12345);
      expect(tx.DestinationTag).toBe(12345);
    });
  });

  describe("createTrustlineTx", () => {
    it("should throw error when not connected", () => {
      const connector = new XRPLConnector();
      expect(() => connector.createTrustlineTx("USD", "rXz...", "100")).toThrow(
        "Session expired",
      );
    });

    it("should create TrustSet transaction when connected", () => {
      const connector = new XRPLConnector();
      (connector as any).activeSession = {
        wallet: {
          address: "rG1Euv9U7M9dV5B7z9wJkZqAB",
          publicKey: "PUBKEY123",
        },
      };
      const tx = connector.createTrustlineTx("USD", "rIssuer", "100");
      expect(tx.TransactionType).toBe("TrustSet");
      expect(tx.Account).toBe("rG1Euv9U7M9dV5B7z9wJkZqAB");
      expect((tx as any).LimitAmount).toEqual({
        currency: "USD",
        issuer: "rIssuer",
        value: "100",
      });
    });
  });

  describe("getAccounts", () => {
    it("should return accounts from session", async () => {
      const connector = new XRPLConnector();
      const session = {
        namespaces: {
          xrpl: { accounts: ["xrpl:rG1Euv9U7M9dV5B7z9wJkZqAB"] },
        },
      } as any;
      const accounts = await connector.getAccounts(session);
      expect(accounts).toEqual(["xrpl:rG1Euv9U7M9dV5B7z9wJkZqAB"]);
    });

    it("should return empty when no xrpl namespace", async () => {
      const connector = new XRPLConnector();
      const session = { namespaces: {} } as any;
      const accounts = await connector.getAccounts(session);
      expect(accounts).toEqual([]);
    });
  });

  describe("getConnectedWallet", () => {
    it("should return null when not connected", () => {
      const connector = new XRPLConnector();
      expect(connector.getConnectedWallet()).toBeNull();
    });
  });
});

describe("createXRPLConnector", () => {
  it("should create via factory", () => {
    const connector = createXRPLConnector();
    expect(connector).toBeInstanceOf(XRPLConnector);
  });

  it("should pass network option", () => {
    const connector = createXRPLConnector("testnet");
    expect(connector.getNetworkEndpoint()).toBe(
      "wss://s.altnet.rippletest.net",
    );
  });
});

describe("formatXRPAmount", () => {
  it("should format drops to XRP", () => {
    expect(formatXRPAmount("1000000")).toBe("1.000000");
    expect(formatXRPAmount(2000000)).toBe("2.000000");
    expect(formatXRPAmount("100")).toBe("0.000100");
  });

  it("should handle large amounts", () => {
    expect(formatXRPAmount("100000000")).toBe("100.000000");
  });

  it("should handle zero", () => {
    expect(formatXRPAmount("0")).toBe("0.000000");
  });
});

describe("parseXRPAmount", () => {
  it("should convert XRP to drops", () => {
    expect(parseXRPAmount("1")).toBe("1000000");
    expect(parseXRPAmount("1.5")).toBe("1500000");
    expect(parseXRPAmount("0.000001")).toBe("1");
  });
});

describe("isValidXRPAddress", () => {
  it("should validate XRP family addresses", () => {
    expect(
      isValidXRPAddress("X7zsFUS8sFua6fp4VJSK5tVfcJ7tC2F7vCgTZuKJ7x9B4"),
    ).toBe(true);
    expect(
      isValidXRPAddress("X00000000000000000000000000000000000000000"),
    ).toBe(true);
    expect(
      isValidXRPAddress("XABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop"),
    ).toBe(true);
    expect(isValidXRPAddress("rXz123")).toBe(false);
    expect(isValidXRPAddress("")).toBe(false);
  });

  it("should reject too short addresses", () => {
    expect(isValidXRPAddress("XShort")).toBe(false);
  });
});

describe("isValidXRPClassicAddress", () => {
  it("should validate classic XRP addresses", () => {
    expect(isValidXRPClassicAddress("rG1Euv9U7M9dV5B7z9wJkZqAB")).toBe(true);
    expect(isValidXRPClassicAddress("rHb9CJAWyB4rj91VRWn96Dk4GqGn")).toBe(true);
    expect(isValidXRPClassicAddress("rG1Euv9U7M9dV5B7z9wJkZqABCDE")).toBe(true);
    expect(
      isValidXRPClassicAddress("X7zsFUS8sFua6fp4VJSK5tVfcJ7tC2F7vCgTZuKJ7x9B4"),
    ).toBe(false);
    expect(isValidXRPClassicAddress("")).toBe(false);
  });

  it("should reject invalid formats", () => {
    expect(isValidXRPClassicAddress("abc")).toBe(false);
    expect(isValidXRPClassicAddress("r123")).toBe(false);
    expect(
      isValidXRPClassicAddress("r1234567890123456789012345678901234567890"),
    ).toBe(false);
  });
});

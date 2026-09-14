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
  /**
   * EIP-5792 capability discovery.
   *
   * This previously never contacted the wallet: it read a non-standard
   * `capabilities` key off the CAIP-25 session namespace and, finding nothing,
   * reported `supported: false` for every chain. A caller cannot tell that
   * invented "no" from a real one, so wallets that do batch were routed onto a
   * non-atomic path. The distinction these tests protect is asked-and-declined
   * versus never-asked.
   */
  describe("getCapabilities", () => {
    const connectorWith = (request: ReturnType<typeof vi.fn>) =>
      new WalletConnectConnector({
        ...makeConfig(),
        client: { on: vi.fn(), request } as any,
      });

    it("asks the wallet instead of inspecting the session", async () => {
      const request = vi.fn().mockResolvedValue({
        "0x1": { atomic: { status: "supported" } },
      });
      const caps = await connectorWith(request).getCapabilities(
        createMockSession(),
      );
      expect(request).toHaveBeenCalled();
      const [{ request: rpc }] = request.mock.calls[0];
      expect(rpc.method).toBe("wallet_getCapabilities");
      expect(rpc.params[0]).toBe("0x1234567890123456789012345678901234567890");
      expect(rpc.params[1]).toEqual(["0x1"]);
      expect(caps["eip155:1"].atomicBatch.supported).toBe(true);
    });

    it("treats EIP-5792 2.0.0 atomic status as a yes when ready", async () => {
      // "ready" means the wallet can upgrade to atomic execution on approval;
      // the spec counts it as support, unlike "unsupported".
      const request = vi.fn().mockResolvedValue({
        "0x1": { atomic: { status: "ready" } },
      });
      const caps = await connectorWith(request).getCapabilities(
        createMockSession(),
      );
      expect(caps["eip155:1"].atomicBatch.supported).toBe(true);
    });

    it("reads unsupported atomic status as a real no", async () => {
      const request = vi.fn().mockResolvedValue({
        "0x1": { atomic: { status: "unsupported" } },
      });
      const caps = await connectorWith(request).getCapabilities(
        createMockSession(),
      );
      expect(caps["eip155:1"].atomicBatch.supported).toBe(false);
    });

    it("still understands the pre-2.0.0 atomicBatch shape", async () => {
      // Deployed wallets ship both shapes; neither is inferred from the other.
      const request = vi.fn().mockResolvedValue({
        "0x1": { atomicBatch: { supported: true, maxBatchSize: 4 } },
      });
      const caps = await connectorWith(request).getCapabilities(
        createMockSession(),
      );
      expect(caps["eip155:1"].atomicBatch).toEqual({
        supported: true,
        maxBatchSize: 4,
      });
    });

    it("converts hex chain keys to CAIP-2", async () => {
      const request = vi.fn().mockResolvedValue({
        "0x89": { atomic: { status: "supported" } },
      });
      const caps = await connectorWith(request).getCapabilities(
        createMockSession(),
      );
      expect(caps["eip155:137"]).toBeDefined();
      expect(caps["0x89"]).toBeUndefined();
    });

    it("drops keys that are not hex chain IDs rather than guessing", async () => {
      const request = vi.fn().mockResolvedValue({
        "0x1": { atomic: { status: "supported" } },
        "not-a-chain": { atomic: { status: "supported" } },
        "0x0": { atomic: { status: "supported" } },
      });
      const caps = await connectorWith(request).getCapabilities(
        createMockSession(),
      );
      expect(Object.keys(caps)).toEqual(["eip155:1"]);
    });

    it("reports paymaster support only when the wallet says so", async () => {
      const request = vi.fn().mockResolvedValue({
        "0x1": {
          atomic: { status: "supported" },
          paymasterService: { supported: true },
        },
      });
      const caps = await connectorWith(request).getCapabilities(
        createMockSession(),
      );
      expect(caps["eip155:1"].paymasterService).toEqual({ supported: true });

      const without = vi.fn().mockResolvedValue({
        "0x1": { atomic: { status: "supported" } },
      });
      const bare = await connectorWith(without).getCapabilities(
        createMockSession(),
      );
      expect(bare["eip155:1"].paymasterService).toBeUndefined();
    });

    it("throws rather than inventing a no when the wallet lacks the method", async () => {
      // The caller must be able to see "not discovered". Reporting
      // supported: false here is what sent batching wallets down the
      // sequential path.
      const request = vi.fn().mockRejectedValue(
        Object.assign(new Error("Method not found"), {
          code: -32601,
        }),
      );
      await expect(
        connectorWith(request).getCapabilities(createMockSession()),
      ).rejects.toThrow();
    });

    it("falls back to session-declared capabilities when the wallet volunteered them", async () => {
      const request = vi.fn().mockRejectedValue(
        Object.assign(new Error("Method not found"), {
          code: -32601,
        }),
      );
      const session = createMockSession({
        namespaces: {
          eip155: {
            chains: ["eip155:1"],
            accounts: ["eip155:1:0x1234567890123456789012345678901234567890"],
            methods: ["personal_sign"],
            events: [],
            capabilities: { atomicBatch: true },
          },
        },
      });
      const caps = await connectorWith(request).getCapabilities(session);
      expect(caps["eip155:1"].atomicBatch.supported).toBe(true);
    });

    it("does not swallow a user rejection as an absent method", async () => {
      // Only method-not-found justifies the fallback; anything else is a real
      // error the caller needs to see.
      const request = vi.fn().mockRejectedValue(
        Object.assign(new Error("User rejected"), {
          code: 4001,
        }),
      );
      await expect(
        connectorWith(request).getCapabilities(createMockSession()),
      ).rejects.toThrow(/User rejected/);
    });

    it("refuses on a session with no EVM chains", async () => {
      const request = vi.fn();
      const session = createMockSession({
        namespaces: {
          solana: {
            chains: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"],
            accounts: [],
            methods: [],
            events: [],
          },
        },
      });
      await expect(
        connectorWith(request).getCapabilities(session),
      ).rejects.toThrow(/EVM chains/);
      expect(request).not.toHaveBeenCalled();
    });
  });

  /**
   * EIP-5792 atomicRequired.
   *
   * Choosing to batch is a decision that the calls must land together. The
   * request used to always carry atomicRequired: false — telling the wallet it
   * may split them — and a wallet without wallet_sendCalls got the calls sent
   * one at a time regardless. Either turns all-or-nothing into a landed
   * approve with no swap behind it, returned as if it succeeded.
   */
  describe("sendCalls atomicity", () => {
    const twoCalls = [
      { to: `0x${"11".repeat(20)}` as `0x${string}`, value: "0x1" },
      { to: `0x${"22".repeat(20)}` as `0x${string}`, value: "0x2" },
    ];
    const connectorWith = (request: ReturnType<typeof vi.fn>) =>
      new WalletConnectConnector({
        ...makeConfig(),
        client: { on: vi.fn(), request } as any,
      });

    it("forwards the requirement to the wallet", async () => {
      const request = vi.fn().mockResolvedValue({ id: "0xbundle" });
      await connectorWith(request).sendCalls(
        createMockSession(),
        twoCalls,
        undefined,
        { atomicRequired: true },
      );
      const [{ request: rpc }] = request.mock.calls[0];
      expect(rpc.params[0].atomicRequired).toBe(true);
    });

    it("forwards the executable paymaster service to the wallet", async () => {
      const request = vi.fn().mockResolvedValue({ id: "0xbundle" });
      await connectorWith(request).sendCalls(
        createMockSession(),
        twoCalls,
        undefined,
        {
          paymasterService: {
            url: "https://paymaster.example",
            context: { policy: "daily-limit" },
          },
        },
      );
      const [{ request: rpc }] = request.mock.calls[0];
      expect(rpc.params[0].capabilities).toEqual({
        paymasterService: {
          url: "https://paymaster.example",
          context: { policy: "daily-limit" },
        },
      });
    });

    it("does not fall back to user-paid transactions after sponsored sendCalls is unavailable", async () => {
      const request = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("Method not found"), { code: -32601 }),
        );
      await expect(
        connectorWith(request).sendCalls(
          createMockSession(),
          twoCalls,
          undefined,
          { paymasterService: { url: "https://paymaster.example" } },
        ),
      ).rejects.toThrow(/Method not found/);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it("leaves the decision to the wallet by default", async () => {
      const request = vi.fn().mockResolvedValue({ id: "0xbundle" });
      await connectorWith(request).sendCalls(createMockSession(), twoCalls);
      const [{ request: rpc }] = request.mock.calls[0];
      expect(rpc.params[0].atomicRequired).toBe(false);
    });

    it("refuses to degrade to individual transactions when atomicity is required", async () => {
      const request = vi.fn().mockRejectedValue(
        Object.assign(new Error("Method not found"), {
          code: -32601,
        }),
      );
      await expect(
        connectorWith(request).sendCalls(
          createMockSession(),
          twoCalls,
          undefined,
          {
            atomicRequired: true,
          },
        ),
      ).rejects.toThrow();
      // One attempt, then a refusal — nothing was sent.
      expect(request).toHaveBeenCalledTimes(1);
    });

    it("still degrades when the caller did not require atomicity", async () => {
      const request = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error("Method not found"), {
            code: -32601,
          }),
        )
        .mockResolvedValueOnce("0xaaa")
        .mockResolvedValueOnce("0xbbb");
      const result = await connectorWith(request).sendCalls(
        createMockSession(),
        twoCalls,
      );
      expect(result).toBe("0xaaa,0xbbb");
    });
  });

  describe("getCallsStatus", () => {
    it("forwards the EIP-5792 status request and preserves its response", async () => {
      const request = vi.fn().mockResolvedValue({
        version: "2.0.0",
        id: "0xbundle",
        chainId: "0x1",
        status: 200,
        atomic: true,
      });
      const client = { on: vi.fn(), request };
      const c = new WalletConnectConnector({
        ...makeConfig(),
        client: client as any,
      });
      const session = createMockSession();

      await expect(
        c.getCallsStatus(session, "0xbundle"),
      ).resolves.toMatchObject({
        status: 200,
        atomic: true,
      });
      expect(request).toHaveBeenCalledWith({
        topic: "test-topic",
        chainId: "eip155:1",
        request: { method: "wallet_getCallsStatus", params: ["0xbundle"] },
      });
    });

    it("propagates a status request failure", async () => {
      const client = {
        on: vi.fn(),
        request: vi.fn().mockRejectedValue(new Error("bundle not found")),
      };
      const c = new WalletConnectConnector({
        ...makeConfig(),
        client: client as any,
      });

      await expect(
        c.getCallsStatus(createMockSession(), "0xbundle"),
      ).rejects.toThrow("bundle not found");
    });
  });

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

// ─── QR pairing proposal parity ───────────────────────────────────────
//
// startPairing() is the path behind the QR code. It used to send only the
// required namespaces, so a user who paired by scanning got a session pinned
// to eip155:1 with no other chain available, while a user who went through
// connect() got the full optional set. It also skipped the CAIP-25 validation
// connect() performs.

describe("startPairing proposal", () => {
  /** The parts of a WalletConnect proposal these tests read back. */
  type ConnectProposal = {
    requiredNamespaces: { eip155?: { chains?: string[] } };
    optionalNamespaces?: { eip155?: { chains?: string[] } };
  };

  function connectorWithClient() {
    const connect = vi.fn(async (_proposal: ConnectProposal) => ({
      uri: "wc:pairing@2?relay-protocol=irn&symKey=abc",
      approval: async () => ({ namespaces: {}, topic: "t" }),
    }));
    const c = new WalletConnectConnector({ projectId: "p" } as never);
    (c as unknown as { getClient: () => Promise<unknown> }).getClient =
      async () => ({ connect }) as never;
    return { c, connect };
  }

  it("returns the pairing URI without waiting for approval", async () => {
    const { c } = connectorWithClient();
    await expect(c.startPairing()).resolves.toMatch(/^wc:/);
  });

  it("advertises optional namespaces, not just the required chain", async () => {
    const { c, connect } = connectorWithClient();
    await c.startPairing();
    const proposal = connect.mock.calls[0][0];
    expect(proposal.optionalNamespaces).toBeDefined();
    expect(
      proposal.optionalNamespaces?.eip155?.chains?.length ?? 0,
    ).toBeGreaterThan(0);
  });

  it("sends the same required namespaces connect() would", async () => {
    const { c, connect } = connectorWithClient();
    await c.startPairing();
    const proposal = connect.mock.calls[0][0];
    expect(proposal.requiredNamespaces.eip155?.chains).toContain("eip155:1");
  });
});

// ─── Cancelling an in-flight pairing ──────────────────────────────────
//
// WalletConnect cannot withdraw a proposal once the URI is out, so a user who
// presses cancel can still have their wallet approve a moment later. Hiding
// the QR is not cancellation: without this, the session stayed live and the
// user was connected to something they had declined.

describe("cancelPairing", () => {
  function pendingPairing() {
    let approve!: (v: { topic: string }) => void;
    const approval = () =>
      new Promise<{ topic: string }>((res) => {
        approve = res;
      });
    const disconnect = vi.fn(async () => {});
    const connect = vi.fn(async () => ({ uri: "wc:abc@2", approval }));
    const c = new WalletConnectConnector({ projectId: "p" } as never);
    (c as unknown as { getClient: () => Promise<unknown> }).getClient =
      async () => ({ connect, disconnect }) as never;
    return { c, disconnect, approve: () => approve({ topic: "topic-1" }) };
  }

  it("disconnects a session that arrives after the user cancelled", async () => {
    const { c, disconnect, approve } = pendingPairing();
    await c.startPairing();

    c.cancelPairing();
    approve();
    await new Promise((r) => setTimeout(r, 0));

    expect(disconnect).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "topic-1" }),
    );
  });

  it("leaves an approved session alone when the user did not cancel", async () => {
    const { c, disconnect, approve } = pendingPairing();
    await c.startPairing();

    approve();
    await new Promise((r) => setTimeout(r, 0));

    expect(disconnect).not.toHaveBeenCalled();
  });

  it("makes completePairing impossible after cancelling", async () => {
    const { c } = pendingPairing();
    await c.startPairing();
    c.cancelPairing();
    await expect(c.completePairing()).rejects.toThrow(/No pending approval/);
  });

  it("clears the URI so a stale QR cannot be re-shown", async () => {
    const { c } = pendingPairing();
    await c.startPairing();
    expect(c.uri).toBeDefined();
    c.cancelPairing();
    expect(c.uri).toBeUndefined();
  });

  it("only tears down the cancelled attempt, not the one that replaced it", async () => {
    // Each pairing gets its own approval; the cancelled one must be torn down
    // and the live one left alone.
    const resolvers: Array<() => void> = [];
    const disconnect = vi.fn(async () => {});
    let n = 0;
    const connect = vi.fn(async () => {
      const topic = `topic-${++n}`;
      return {
        uri: `wc:${topic}@2`,
        approval: () =>
          new Promise<{ topic: string }>((res) =>
            resolvers.push(() => res({ topic })),
          ),
      };
    });
    const c = new WalletConnectConnector({ projectId: "p" } as never);
    (c as unknown as { getClient: () => Promise<unknown> }).getClient =
      async () => ({ connect, disconnect }) as never;

    await c.startPairing();
    c.cancelPairing();
    await c.startPairing();

    for (const resolve of resolvers) resolve();
    await new Promise((r) => setTimeout(r, 0));

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "topic-1" }),
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSolanaConnector,
  getSolanaProvider,
  isPhantomInstalled,
  isSolflareInstalled,
  type SolanaConnector,
} from "./index";
import type { SolanaProvider } from "./types";

function createMockProvider(
  overrides: Partial<SolanaProvider> = {},
): SolanaProvider {
  const mockPublicKey = {
    toBytes: () => new Uint8Array(32),
    toString: () => "mock-public-key",
  };
  return {
    connect: vi.fn().mockResolvedValue({ publicKey: mockPublicKey }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    signMessage: vi
      .fn()
      .mockResolvedValue({ signature: new Uint8Array([1, 2, 3]) }),
    signTransaction: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
    signAllTransactions: vi.fn().mockResolvedValue([new Uint8Array([7, 8, 9])]),
    signAndSendTransaction: vi
      .fn()
      .mockResolvedValue({ signature: "mock-signature" }),
    on: vi.fn(),
    ...overrides,
  };
}

describe("SolanaConnector", () => {
  let connector: SolanaConnector;

  beforeEach(() => {
    connector = createSolanaConnector();
  });

  afterEach(() => {
    connector.clear();
    vi.unstubAllGlobals();
  });

  it("has correct identity", () => {
    expect(connector.id).toBe("solana");
    expect(connector.name).toBe("Solana Wallets");
    expect(connector.kind).toBe("solana");
    expect(connector.namespaces).toEqual(["solana"]);
    expect(connector.supports.desktop).toBe(true);
    expect(connector.supports.qr).toBe(false);
  });

  it("getDiscoveredWallets returns empty initially", () => {
    expect(connector.getDiscoveredWallets()).toEqual([]);
  });

  it("clear resets everything", () => {
    const mockProvider = createMockProvider();
    vi.stubGlobal("window", {
      phantom: { solana: mockProvider },
    } as any);

    connector.startDiscovery();
    expect(connector.getDiscoveredWallets().length).toBeGreaterThan(0);
    connector.clear();
    expect(connector.getDiscoveredWallets()).toEqual([]);
  });

  it("startDiscovery detects Phantom wallet", () => {
    const mockProvider = createMockProvider({ isPhantom: true });
    vi.stubGlobal("window", {
      phantom: { solana: mockProvider },
    } as any);

    connector.startDiscovery();
    const wallets = connector.getDiscoveredWallets();
    expect(wallets.length).toBe(1);
    expect(wallets[0].id).toBe("phantom");
    expect(wallets[0].name).toBe("Phantom");
    expect(wallets[0].provider).toBe(mockProvider);
  });

  it("startDiscovery detects Solflare wallet", () => {
    const mockProvider = createMockProvider({ isSolflare: true });
    vi.stubGlobal("window", {
      solflare: mockProvider,
    } as any);

    connector.startDiscovery();
    const wallets = connector.getDiscoveredWallets();
    expect(wallets.length).toBe(1);
    expect(wallets[0].id).toBe("solflare");
    expect(wallets[0].name).toBe("Solflare");
  });

  it("startDiscovery detects generic Solana wallet", () => {
    const mockProvider = createMockProvider({});
    vi.stubGlobal("window", {
      solana: mockProvider,
    } as any);

    connector.startDiscovery();
    const wallets = connector.getDiscoveredWallets();
    expect(wallets.length).toBe(1);
    expect(wallets[0].id).toBe("generic");
  });

  it("startDiscovery ignores known wallets when already added", () => {
    const mockProvider = createMockProvider({ isPhantom: true });
    vi.stubGlobal("window", {
      phantom: { solana: mockProvider },
    } as any);

    connector.startDiscovery();
    connector.startDiscovery();
    const wallets = connector.getDiscoveredWallets();
    expect(wallets.length).toBe(1);
  });

  it("connect throws when no wallet discovered", async () => {
    vi.stubGlobal("window", {} as any);
    await expect(connector.connect()).rejects.toThrow("No Solana wallet found");
    vi.unstubAllGlobals();
  });

  it("connect succeeds with discovered wallet", async () => {
    const mockProvider = createMockProvider();
    vi.stubGlobal("window", {
      phantom: { solana: mockProvider },
    } as any);

    connector.startDiscovery();
    const session = await connector.connect();

    expect(mockProvider.connect).toHaveBeenCalledOnce();
    expect(session.id).toContain("solana-phantom");
    expect(session.walletType).toBe("solana");
    expect(session.namespaces.solana).toBeDefined();
    expect(session.namespaces.solana.accounts[0]).toContain("solana:");
    expect(session.namespaces.solana.accounts[0]).toContain("mock-public-key");
  });

  it("connect with specific walletId", async () => {
    const phantomProvider = createMockProvider({ isPhantom: true });
    const solflareProvider = createMockProvider({ isSolflare: true });
    vi.stubGlobal("window", {
      phantom: { solana: phantomProvider },
      solflare: solflareProvider,
    } as any);

    connector.startDiscovery();

    const session = await connector.connect("solflare");
    expect(session.id).toContain("solana-solflare");

    const session2 = await connector.connect("phantom");
    expect(session2.id).toContain("solana-phantom");
  });

  it("disconnect clears active session", async () => {
    const mockProvider = createMockProvider();
    vi.stubGlobal("window", {
      phantom: { solana: mockProvider },
    } as any);

    connector.startDiscovery();
    const session = await connector.connect();
    await connector.disconnect(session);

    expect(mockProvider.disconnect).toHaveBeenCalledOnce();
  });

  it("getAccounts returns accounts from session", async () => {
    const session = {
      id: "test",
      namespaces: {
        solana: {
          accounts: ["solana:4sGjMW1s:test-account"],
          chains: [],
          methods: [],
          events: [],
          capabilities: {},
        },
      },
    } as any;

    const accounts = await connector.getAccounts(session);
    expect(accounts).toEqual(["solana:4sGjMW1s:test-account"]);
  });

  it("getAccounts returns empty when no solana namespace", async () => {
    const session = {
      id: "test",
      namespaces: {},
    } as any;

    const accounts = await connector.getAccounts(session);
    expect(accounts).toEqual([]);
  });

  it("signMessage throws when no active session", async () => {
    const session = {
      id: "test",
      namespaces: { solana: { accounts: [] } },
    } as any;
    await expect(
      connector.signMessage(session, { message: "hello" }),
    ).rejects.toThrow("Session expired");
  });

  it("signMessage succeeds with active session", async () => {
    const mockProvider = createMockProvider();
    vi.stubGlobal("window", {
      phantom: { solana: mockProvider },
    } as any);

    connector.startDiscovery();
    const session = await connector.connect();

    const result = await connector.signMessage(session, {
      message: "hello world",
    });
    expect(mockProvider.signMessage).toHaveBeenCalledWith(
      new TextEncoder().encode("hello world"),
    );
    expect(Array.isArray(result)).toBe(true);
  });

  it("signMessage throws on missing message parameter", async () => {
    const mockProvider = createMockProvider();
    vi.stubGlobal("window", {
      phantom: { solana: mockProvider },
    } as any);

    connector.startDiscovery();
    const session = await connector.connect();

    await expect(connector.signMessage(session, {} as any)).rejects.toThrow(
      "Missing message parameter",
    );
  });

  it("signTransaction succeeds with active session", async () => {
    const mockProvider = createMockProvider();
    vi.stubGlobal("window", {
      phantom: { solana: mockProvider },
    } as any);

    connector.startDiscovery();
    const session = await connector.connect();

    const result = await connector.signTransaction(session, {
      transaction: { serialized: [1, 2, 3, 4] },
    });
    expect(mockProvider.signTransaction).toHaveBeenCalled();
    expect(Array.isArray(result)).toBe(true);
  });

  it("signTransaction throws on invalid input", async () => {
    const mockProvider = createMockProvider();
    vi.stubGlobal("window", {
      phantom: { solana: mockProvider },
    } as any);

    connector.startDiscovery();
    const session = await connector.connect();

    await expect(connector.signTransaction(session, {} as any)).rejects.toThrow(
      "Missing transaction parameter",
    );
  });

  it("sendTransaction succeeds with active session", async () => {
    const mockProvider = createMockProvider();
    vi.stubGlobal("window", {
      phantom: { solana: mockProvider },
    } as any);

    connector.startDiscovery();
    const session = await connector.connect();

    const result = await connector.sendTransaction(session, {
      transaction: { serialized: [1, 2, 3, 4] },
    });
    expect(mockProvider.signAndSendTransaction).toHaveBeenCalled();
    expect(result).toBe("mock-signature");
  });

  it("switchChain updates session namespace chains", () => {
    const session = {
      id: "test",
      namespaces: {
        solana: {
          chains: ["solana:4sGjMW1s"],
          accounts: [],
          methods: [],
          events: [],
          capabilities: {},
        },
      },
    } as any;

    connector.switchChain(session, "solana:8E9rvC");
    expect(session.namespaces.solana.chains).toEqual(["solana:8E9rvC"]);
  });

  it("onUpdate registers and unregisters callbacks", () => {
    const callback = vi.fn();
    const unsubscribe = connector.onUpdate(callback);
    expect(typeof unsubscribe).toBe("function");

    const mockProvider = createMockProvider({ isPhantom: true });
    vi.stubGlobal("window", {
      phantom: { solana: mockProvider },
    } as any);

    connector.startDiscovery();
    expect(callback).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "phantom" })]),
    );

    unsubscribe();
  });

  it("connect throws on user rejection", async () => {
    const mockProvider = createMockProvider({
      connect: vi.fn().mockRejectedValue(new Error("User rejected")),
    });
    vi.stubGlobal("window", {
      phantom: { solana: mockProvider },
    } as any);

    connector.startDiscovery();

    await expect(connector.connect()).rejects.toThrow(
      "Connection rejected by user",
    );
  });

  it("signMessage throws on user rejection", async () => {
    const mockProvider = createMockProvider({
      signMessage: vi.fn().mockRejectedValue(new Error("User rejected")),
    });
    vi.stubGlobal("window", {
      phantom: { solana: mockProvider },
    } as any);

    connector.startDiscovery();
    const session = await connector.connect();

    await expect(
      connector.signMessage(session, { message: "hi" }),
    ).rejects.toThrow("Message signing rejected by user");
  });
});

describe("isPhantomInstalled", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns true when phantom.solana exists", () => {
    vi.stubGlobal("window", {
      phantom: { solana: createMockProvider() },
    } as any);
    expect(isPhantomInstalled()).toBe(true);
  });

  it("returns true when window.solana.isPhantom", () => {
    vi.stubGlobal("window", {
      solana: createMockProvider({ isPhantom: true }),
    } as any);
    expect(isPhantomInstalled()).toBe(true);
  });

  it("returns false when no phantom wallet", () => {
    vi.stubGlobal("window", {} as any);
    expect(isPhantomInstalled()).toBe(false);
  });

  it("returns false in SSR (no window)", () => {
    const win = globalThis.window;
    vi.stubGlobal("window", undefined);
    expect(isPhantomInstalled()).toBe(false);
    vi.stubGlobal("window", win);
  });
});

describe("isSolflareInstalled", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns true when solflare exists", () => {
    vi.stubGlobal("window", {
      solflare: createMockProvider({ isSolflare: true }),
    } as any);
    expect(isSolflareInstalled()).toBe(true);
  });

  it("returns false when no solflare wallet", () => {
    vi.stubGlobal("window", {} as any);
    expect(isSolflareInstalled()).toBe(false);
  });
});

describe("getSolanaProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns provider for discovered wallet", () => {
    const mockProvider = createMockProvider({ isPhantom: true });
    vi.stubGlobal("window", {
      phantom: { solana: mockProvider },
    } as any);

    const localConnector = createSolanaConnector();
    localConnector.startDiscovery();

    const wallets = localConnector.getDiscoveredWallets();
    expect(wallets.length).toBeGreaterThan(0);
    expect(wallets[0].provider).toBe(mockProvider);
  });

  it("returns null for unknown wallet", () => {
    expect(getSolanaProvider("nonexistent")).toBeNull();
  });
});

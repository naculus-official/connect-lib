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
    toString: () => "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtPb",
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
    off: vi.fn(),
    removeListener: vi.fn(),
    ...overrides,
  };
}

describe("SolanaConnector", () => {
  let connector: SolanaConnector;

  beforeEach(() => {
    connector = createSolanaConnector();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi
          .fn()
          .mockResolvedValue({ result: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }),
      }),
    );
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
    expect(session.namespaces.solana.accounts[0]).toContain(
      "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtPb",
    );
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

  it("switchChain updates session namespace chains", async () => {
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

    await connector.switchChain(
      session,
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    );
    expect(session.namespaces.solana.chains).toEqual([
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    ]);
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

  it("fails closed when the Solana cluster cannot be verified", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ result: "unknown-genesis-hash" }),
      }),
    );
    const mockProvider = createMockProvider();
    vi.stubGlobal("window", { phantom: { solana: mockProvider } } as any);
    connector.startDiscovery();

    await expect(connector.connect()).rejects.toMatchObject({
      code: "rpc_error",
    });
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

/**
 * In-wallet account switches.
 *
 * `accountChanged` had no branch that recorded a new account — the address was
 * written once during connect() and never again. Signing goes through the
 * provider, so after a switch the wallet signs with the new key while the
 * session still advertises the old address, and a SIWx message built from that
 * session asserts an address the signature does not belong to.
 */
describe("SolanaConnector — accountChanged", () => {
  const FIRST = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtPb";
  const SECOND = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

  let connector: SolanaConnector;
  let handler: (...args: unknown[]) => void;
  let provider: SolanaProvider;

  async function connectAndCapture() {
    provider = createMockProvider();
    vi.stubGlobal("window", { phantom: { solana: provider } } as any);
    connector.startDiscovery();
    const session = await connector.connect();
    const call = (provider.on as ReturnType<typeof vi.fn>).mock.calls.find(
      ([event]) => event === "accountChanged",
    );
    handler = call?.[1] as (...args: unknown[]) => void;
    return session;
  }

  beforeEach(() => {
    connector = createSolanaConnector();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi
          .fn()
          .mockResolvedValue({ result: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }),
      }),
    );
  });

  afterEach(() => {
    connector.clear();
    vi.unstubAllGlobals();
  });

  it("registers a listener at connect time", async () => {
    await connectAndCapture();
    expect(handler).toBeTypeOf("function");
  });

  it("rewrites the session accounts when the wallet switches account", async () => {
    const session = await connectAndCapture();
    expect(session.namespaces.solana?.accounts[0]).toContain(FIRST);

    handler({ toBase58: () => SECOND });

    const accounts = session.namespaces.solana?.accounts ?? [];
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toContain(SECOND);
    expect(accounts[0]).not.toContain(FIRST);
    // Still CAIP-10 against the session's own chain, not a bare address.
    expect(accounts[0]).toMatch(/^solana:[^:]+:9WzD/);
  });

  it("accepts a bare base58 string", async () => {
    const session = await connectAndCapture();
    handler(SECOND);
    expect(session.namespaces.solana?.accounts[0]).toContain(SECOND);
  });

  it("accepts an accounts array", async () => {
    // Wallet Standard implementations emit a list rather than a single key.
    const session = await connectAndCapture();
    handler([{ address: SECOND }]);
    expect(session.namespaces.solana?.accounts[0]).toContain(SECOND);
  });

  it("accepts a wrapper carrying publicKey", async () => {
    const session = await connectAndCapture();
    handler({ publicKey: { toBase58: () => SECOND } });
    expect(session.namespaces.solana?.accounts[0]).toContain(SECOND);
  });

  it("treats a null payload as a disconnect", async () => {
    const session = await connectAndCapture();
    handler(null);
    await expect(
      connector.signMessage(session, { message: "hi" }),
    ).rejects.toThrow();
  });

  it("treats an empty array as a disconnect", async () => {
    const session = await connectAndCapture();
    handler([]);
    await expect(
      connector.signMessage(session, { message: "hi" }),
    ).rejects.toThrow();
  });

  it("never writes a non-address into the session", async () => {
    // A plain object stringifies to "[object Object]". Writing that as an
    // account would hand every downstream caller a malformed CAIP-10.
    const session = await connectAndCapture();
    handler({ nonsense: true });
    const accounts = session.namespaces.solana?.accounts ?? [];
    expect(accounts.every((a) => !a.includes("[object"))).toBe(true);
  });

  it("notifies subscribers with the updated CAIP-10 accounts", async () => {
    // The whole point of the universal event: a consumer subscribes once,
    // without knowing this wallet reports "accountChanged" rather than
    // EIP-1193's "accountsChanged".
    const session = await connectAndCapture();
    const seen: string[][] = [];
    connector.onAccountsChanged(session, (accounts) => seen.push(accounts));

    handler({ toBase58: () => SECOND });

    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toContain(SECOND);
    // Already updated when the subscriber runs, so reading the session works.
    expect(session.namespaces.solana?.accounts[0]).toBe(seen[0][0]);
  });

  it("signals a disconnect with an empty list", async () => {
    const session = await connectAndCapture();
    const seen: string[][] = [];
    connector.onAccountsChanged(session, (accounts) => seen.push(accounts));

    handler(null);

    expect(seen).toEqual([[]]);
  });

  it("stops notifying after unsubscribe", async () => {
    const session = await connectAndCapture();
    const subscriber = vi.fn();
    const unsubscribe = connector.onAccountsChanged(session, subscriber);
    unsubscribe();

    handler({ toBase58: () => SECOND });

    expect(subscriber).not.toHaveBeenCalled();
  });

  it("one throwing subscriber does not silence the others", async () => {
    const session = await connectAndCapture();
    const good = vi.fn();
    connector.onAccountsChanged(session, () => {
      throw new Error("consumer bug");
    });
    connector.onAccountsChanged(session, good);

    expect(() => handler({ toBase58: () => SECOND })).not.toThrow();
    expect(good).toHaveBeenCalled();
  });

  it("detaches the previous handler when reconnecting", async () => {
    // connect/disconnect/connect used to leave two live handlers on the same
    // provider, so one wallet event became two notifications — and in appkit,
    // two session writes. `removeListener` was declared on SolanaProvider from
    // the start and never called.
    const session = await connectAndCapture();
    const first = handler;

    await connector.disconnect(session);
    await connector.connect();

    const off = provider.off as ReturnType<typeof vi.fn>;
    expect(off).toHaveBeenCalledWith("accountChanged", first);
  });

  it("attaches exactly one live handler per connect", async () => {
    await connectAndCapture();
    const on = provider.on as ReturnType<typeof vi.fn>;
    const off = provider.off as ReturnType<typeof vi.fn>;

    await connector.connect();
    await connector.connect();

    const attached = on.mock.calls.filter(
      ([event]) => event === "accountChanged",
    ).length;
    const detached = off.mock.calls.filter(
      ([event]) => event === "accountChanged",
    ).length;
    // Three connects, two detaches: one handler is live.
    expect(attached - detached).toBe(1);
  });

  it("detaches on clear", async () => {
    await connectAndCapture();
    const first = handler;
    connector.clear();
    expect(provider.off).toHaveBeenCalledWith("accountChanged", first);
  });

  it("ignores a switch back to the account already recorded", async () => {
    const session = await connectAndCapture();
    const before = session.updatedAt;
    handler(FIRST);
    expect(session.updatedAt).toBe(before);
    expect(session.namespaces.solana?.accounts[0]).toContain(FIRST);
  });
});

/**
 * Wallet Standard discovery.
 *
 * Feature negotiation was already real — `standard:connect`,
 * `solana:signMessage` and `solana:signTransaction` are required and the rest
 * probed. What was missing is half the discovery handshake: only
 * `wallet-standard:register-wallet` was listened for, which catches wallets
 * registering *after* startDiscovery(). Extensions inject at document_start,
 * so most have already registered and are waiting for the app to announce
 * itself with `wallet-standard:app-ready`. Without that dispatch the standard
 * path almost never fired and the legacy window scan did the real work.
 */
describe("SolanaConnector — Wallet Standard discovery", () => {
  function walletStandardWallet(name = "Phantom") {
    const account = {
      address: "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtPb",
      publicKey: new Uint8Array(32),
      chains: ["solana:mainnet"],
      features: ["solana:signMessage"],
    };
    return {
      name,
      icon: "data:image/svg+xml;base64,",
      rdns: `app.${name.toLowerCase()}`,
      version: "1.0.0",
      accounts: [account],
      features: {
        "standard:connect": {
          connect: vi.fn().mockResolvedValue({ accounts: [account] }),
        },
        "standard:disconnect": { disconnect: vi.fn() },
        "solana:signMessage": { signMessage: vi.fn() },
        "solana:signTransaction": { signTransaction: vi.fn() },
      },
    } as never;
  }

  let connector: SolanaConnector;

  beforeEach(() => {
    connector = createSolanaConnector();
  });
  afterEach(() => {
    connector.stopDiscovery();
    connector.clear();
    vi.unstubAllGlobals();
  });

  it("announces itself so already-loaded wallets can register", () => {
    // The half that was missing. A wallet present before the dApp runs never
    // fires register-wallet; it waits for this.
    const listeners: Record<string, ((e: Event) => void)[]> = {};
    const dispatched: Event[] = [];
    vi.stubGlobal("window", {
      addEventListener: (type: string, fn: (e: Event) => void) => {
        const existing = listeners[type] ?? [];
        existing.push(fn);
        listeners[type] = existing;
      },
      removeEventListener: () => {},
      dispatchEvent: (event: Event) => {
        dispatched.push(event);
        return true;
      },
    } as never);

    connector.startDiscovery();

    const appReady = dispatched.find(
      (e) => e.type === "wallet-standard:app-ready",
    );
    expect(appReady).toBeDefined();
    expect(
      (appReady as CustomEvent<{ register?: unknown }>).detail.register,
    ).toBeTypeOf("function");
  });

  it("registers a wallet that answers app-ready", () => {
    const dispatched: CustomEvent[] = [];
    vi.stubGlobal("window", {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: (event: CustomEvent) => {
        dispatched.push(event);
        return true;
      },
    } as never);

    connector.startDiscovery();
    const register = (
      dispatched.find(
        (e) => e.type === "wallet-standard:app-ready",
      ) as CustomEvent<{
        register: (...w: unknown[]) => () => void;
      }>
    ).detail.register;

    register(walletStandardWallet());

    const wallets = connector.getDiscoveredWallets();
    expect(wallets).toHaveLength(1);
    expect(wallets[0].source).toBe("wallet-standard");
    expect(wallets[0].name).toBe("Phantom");
  });

  it("returns an unregister callback that removes the wallet", () => {
    const dispatched: CustomEvent[] = [];
    vi.stubGlobal("window", {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: (event: CustomEvent) => {
        dispatched.push(event);
        return true;
      },
    } as never);

    connector.startDiscovery();
    const register = (
      dispatched.find(
        (e) => e.type === "wallet-standard:app-ready",
      ) as CustomEvent<{
        register: (...w: unknown[]) => () => void;
      }>
    ).detail.register;

    const unregister = register(walletStandardWallet());
    expect(connector.getDiscoveredWallets()).toHaveLength(1);
    unregister();
    expect(connector.getDiscoveredWallets()).toHaveLength(0);
  });

  it("does not list the same wallet twice when it also exposes window.solana", () => {
    // The two paths use different ID namespaces, so without a cross-check
    // Phantom appears once with feature negotiation and once through the
    // legacy shim.
    const dispatched: CustomEvent[] = [];
    const legacyProvider = createMockProvider({ isPhantom: true });
    vi.stubGlobal("window", {
      phantom: { solana: legacyProvider },
      solana: legacyProvider,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: (event: CustomEvent) => {
        dispatched.push(event);
        if (event.type === "wallet-standard:app-ready") {
          (event.detail as { register: (w: unknown) => void }).register(
            walletStandardWallet("Phantom"),
          );
        }
        return true;
      },
    } as never);

    connector.startDiscovery();

    const names = connector.getDiscoveredWallets().map((w) => w.name);
    expect(names).toEqual(["Phantom"]);
    expect(connector.getDiscoveredWallets()[0].source).toBe("wallet-standard");
  });

  it("ignores a registration missing required Solana features", () => {
    const dispatched: CustomEvent[] = [];
    vi.stubGlobal("window", {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: (event: CustomEvent) => {
        dispatched.push(event);
        return true;
      },
    } as never);

    connector.startDiscovery();
    const register = (
      dispatched.find(
        (e) => e.type === "wallet-standard:app-ready",
      ) as CustomEvent<{
        register: (...w: unknown[]) => () => void;
      }>
    ).detail.register;

    // No solana:signTransaction — cannot be used, so must not be offered.
    const incomplete = walletStandardWallet();
    delete (incomplete as never as Record<string, Record<string, unknown>>)
      .features["solana:signTransaction"];
    register(incomplete);

    expect(connector.getDiscoveredWallets()).toHaveLength(0);
  });
});

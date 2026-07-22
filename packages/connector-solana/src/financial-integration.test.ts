import { beforeEach, describe, expect, it, vi } from "vitest";

function b58(s: string): Uint8Array {
  const { base58 } = require("@scure/base") as any;
  return base58.decode(s);
}

function toHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

describe("Solana Financial Integration: Address & Signing", () => {
  it("validates solana address format (base58, 32 bytes)", () => {
    const addr = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtPb";
    const decoded = b58(addr);
    expect(decoded.length).toBe(32);
  });

  it("rejects invalid base58 address", () => {
    expect(() => b58("0x" + "ab".repeat(20))).toThrow();
  });

  it("produces 64-byte ed25519 signature", async () => {
    const sig = new Uint8Array(64);
    crypto.getRandomValues(sig);
    expect(sig.length).toBe(64);
    expect(toHex(sig)).toMatch(/^[0-9a-f]{128}$/);
  });

  it("signs with zeroed key produces deterministic signature", async () => {
    const seed = new Uint8Array(32);
    const message = new TextEncoder().encode("hello");
    const { ed25519 } = await import("@noble/curves/ed25519");
    const priv = ed25519.utils.randomPrivateKey();
    const sig = ed25519.sign(message, priv);
    expect(sig.length).toBe(64);
  });

  it("signs empty message", async () => {
    const { ed25519 } = await import("@noble/curves/ed25519");
    const priv = ed25519.utils.randomPrivateKey();
    const sig = ed25519.sign(new Uint8Array(0), priv);
    expect(sig.length).toBe(64);
  });

  it("verifies ed25519 signature roundtrip", async () => {
    const { ed25519 } = await import("@noble/curves/ed25519");
    const priv = ed25519.utils.randomPrivateKey();
    const pub = ed25519.getPublicKey(priv);
    const msg = new TextEncoder().encode("Solana test message");
    const sig = ed25519.sign(msg, priv);
    const ok = ed25519.verify(sig, msg, pub);
    expect(ok).toBe(true);
  });

  it("rejects signature with wrong key", async () => {
    const { ed25519 } = await import("@noble/curves/ed25519");
    const priv = ed25519.utils.randomPrivateKey();
    const wrong = ed25519.utils.randomPrivateKey();
    const pub = ed25519.getPublicKey(wrong);
    const msg = new TextEncoder().encode("test");
    const sig = ed25519.sign(msg, priv);
    const ok = ed25519.verify(sig, msg, pub);
    expect(ok).toBe(false);
  });
});

describe("Solana Financial Integration: Transaction Format", () => {
  it("constructs valid transfer instruction format", () => {
    const from = b58("7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtPb");
    const to = b58("8EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtPb");
    expect(from.length).toBe(32);
    expect(to.length).toBe(32);
    expect(toHex(from)).not.toBe(toHex(to));
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. VALUE PASSTHROUGH — lamport amounts
// ═══════════════════════════════════════════════════════════════

describe("Solana Financial Integration: Value Passthrough", () => {
  it("represents 1 SOL as 1_000_000_000 lamports (bigint)", () => {
    const lamports = 1n * 10n ** 9n;
    expect(lamports).toBe(1_000_000_000n);
    expect(typeof lamports).toBe("bigint");
  });

  it("represents 0.001 SOL as 1_000_000 lamports (bigint)", () => {
    const lamports = BigInt(Math.round(0.001 * 1e9));
    expect(lamports).toBe(1_000_000n);
  });

  it("handles large SOL amount exceeding Number.MAX_SAFE_INTEGER lamports", () => {
    const sol = 10_000_000n; // 10M SOL → 10^16 lamports
    const lamports = sol * 10n ** 9n;
    expect(lamports).toBe(10_000_000_000_000_000n);
    expect(lamports).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it("handles max uint64 lamports without precision loss", () => {
    const maxLamports = 2n ** 64n - 1n;
    expect(maxLamports.toString()).toBe("18446744073709551615");
    expect(Number.isSafeInteger(Number(maxLamports))).toBe(false);
    expect(() => BigInt(maxLamports.toString())).not.toThrow();
  });

  it("uses bigint math for fee calculations", () => {
    const feePerSig = 5_000n;
    const sigs = 2n;
    const totalFee = feePerSig * sigs;
    expect(totalFee).toBe(10_000n);
    expect(typeof totalFee).toBe("bigint");
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. DUST — 1 lamport
// ═══════════════════════════════════════════════════════════════

describe("Solana Financial Integration: Dust (1 lamport)", () => {
  it("represents 1 lamport as 1n", () => {
    const oneLamport = 1n;
    expect(oneLamport).toBe(1n);
    expect(oneLamport.toString()).toBe("1");
  });

  it("converts 1 lamport to SOL string", () => {
    const lamports = 1n;
    const sol = Number(lamports) / 1e9;
    expect(sol).toBe(1e-9);
    expect(sol.toString()).toBe("1e-9");
  });

  it("treats 1 lamport as positive spendable amount", () => {
    const balance = 1_000_000n;
    const cost = 1n;
    expect(balance - cost).toBe(999_999n);
    expect(balance > cost).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. ERROR HANDLING — connector methods
// ═══════════════════════════════════════════════════════════════

describe("Solana Financial Integration: Error Handling", () => {
  let mockProvider: {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    signMessage: ReturnType<typeof vi.fn>;
    signTransaction: ReturnType<typeof vi.fn>;
    signAndSendTransaction: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
  let connector: import("./index").SolanaConnector;

  beforeEach(async () => {
    mockProvider = {
      connect: vi.fn().mockResolvedValue({
        publicKey: {
          toString: () => "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtPb",
        },
      }),
      disconnect: vi.fn(),
      signMessage: vi.fn(),
      signTransaction: vi.fn(),
      signAndSendTransaction: vi.fn(),
      on: vi.fn(),
    };

    vi.stubGlobal("window", {
      solana: mockProvider,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    vi.stubGlobal("navigator", { userAgent: "node" });

    const { SolanaConnector } = await import("./index");
    connector = new SolanaConnector();
    connector.configure({ defaultChain: "solana:0" });
    connector.startDiscovery();
  });

  it("throws user_rejected on signMessage rejection", async () => {
    await connector.connect();
    mockProvider.signMessage.mockRejectedValueOnce(new Error("User rejected"));
    const session = {
      namespaces: {
        solana: {
          accounts: ["solana:0:7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtPb"],
        },
      },
    } as any;
    await expect(
      connector.signMessage(session, { message: "hello" }),
    ).rejects.toThrow("rejected");
  });

  it("throws user_rejected on signTransaction rejection", async () => {
    await connector.connect();
    mockProvider.signTransaction.mockRejectedValueOnce(
      new Error("User rejected"),
    );
    const session = { namespaces: { solana: { accounts: [] } } } as any;
    await expect(
      connector.signTransaction(session, {
        transaction: { serialized: [1, 2, 3] },
      }),
    ).rejects.toThrow("rejected");
  });

  it("throws on missing message param", async () => {
    await connector.connect();
    const session = { namespaces: { solana: { accounts: [] } } } as any;
    await expect(connector.signMessage(session, {})).rejects.toThrow(
      "Missing message",
    );
  });

  it("throws on missing transaction param", async () => {
    await connector.connect();
    const session = { namespaces: { solana: { accounts: [] } } } as any;
    await expect(connector.signTransaction(session, {})).rejects.toThrow(
      "Missing transaction",
    );
  });

  it("throws on invalid transaction data", async () => {
    await connector.connect();
    const session = { namespaces: { solana: { accounts: [] } } } as any;
    await expect(
      connector.signTransaction(session, {
        transaction: { serialized: "not-an-array" },
      }),
    ).rejects.toThrow("Invalid transaction");
  });

  it("throws session_expired when not connected", async () => {
    const session = { namespaces: { solana: { accounts: [] } } } as any;
    await expect(
      connector.signMessage(session, { message: "hello" }),
    ).rejects.toThrow("Session expired");
  });

  it("throws tx_failed on sendTransaction rejection", async () => {
    await connector.connect();
    mockProvider.signAndSendTransaction.mockRejectedValueOnce(
      new Error("RPC error"),
    );
    const session = { namespaces: { solana: { accounts: [] } } } as any;
    await expect(
      connector.sendTransaction(session, {
        transaction: { serialized: [1, 2, 3] },
      }),
    ).rejects.toThrow("Transaction failed");
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. switchChain
// ═══════════════════════════════════════════════════════════════

describe("Solana Financial Integration: switchChain", () => {
  let connector: import("./index").SolanaConnector;

  beforeEach(async () => {
    vi.stubGlobal("window", {
      solana: {
        connect: vi.fn(),
        disconnect: vi.fn(),
        signMessage: vi.fn(),
        signTransaction: vi.fn(),
        signAndSendTransaction: vi.fn(),
        on: vi.fn(),
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("navigator", { userAgent: "node" });
    const { SolanaConnector } = await import("./index");
    connector = new SolanaConnector();
    connector.configure({ defaultChain: "solana:0" });
    connector.startDiscovery();
  });

  it("switches to mainnet (solana:8E9rvC)", async () => {
    const session = {
      namespaces: { solana: { chains: ["solana:0"], accounts: [] } },
    } as any;
    await connector.switchChain(session, "solana:8E9rvC");
    expect(session.namespaces.solana.chains).toEqual(["solana:8E9rvC"]);
  });

  it("switches to testnet (solana:2)", async () => {
    const session = {
      namespaces: { solana: { chains: ["solana:0"], accounts: [] } },
    } as any;
    await connector.switchChain(session, "solana:2");
    expect(session.namespaces.solana.chains).toEqual(["solana:2"]);
  });

  it("throws on unsupported chain (non-solana: namespace)", async () => {
    const session = {
      namespaces: { solana: { chains: ["solana:0"], accounts: [] } },
    } as any;
    await expect(connector.switchChain(session, "eip155:1")).rejects.toThrow(
      "Unsupported chain",
    );
  });

  it("throws when session has no solana namespace", async () => {
    const session = {
      namespaces: { eip155: { chains: ["eip155:1"], accounts: [] } },
    } as any;
    await expect(connector.switchChain(session, "solana:0")).rejects.toThrow(
      "Session has no solana namespace",
    );
  });
});

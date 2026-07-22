import { ERC20TokenHelper, parseUnits } from "@naculus/connect-core";
import type { WalletData } from "@naculus/wallet-engine";
import { PocketWallet, type StorageAdapter } from "@naculus/wallet-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Crypto Mocks ──────────────────────────────────────────────

vi.mock("@scure/bip39", () => ({
  generateMnemonic: vi.fn(
    () =>
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  ),
  mnemonicToSeed: vi.fn(async () => new Uint8Array(64).fill(0x42)),
  validateMnemonic: vi.fn(
    (mnemonic: string) =>
      mnemonic.length > 0 && mnemonic.split(" ").length >= 12,
  ),
}));

vi.mock("@noble/curves/secp256k1", () => ({
  secp256k1: {
    getPublicKey: vi.fn(() => {
      const pub = new Uint8Array(65);
      pub[0] = 0x04;
      for (let i = 1; i < 65; i++) pub[i] = 0xaa;
      return pub;
    }),
    sign: vi.fn(() => {
      const sig = new Uint8Array(64);
      for (let i = 0; i < 32; i++) sig[i] = 0xbb;
      for (let i = 32; i < 64; i++) sig[i] = 0xcc;
      return {
        r: 0xbbbbbbbbbbbbbbbbn,
        s: 0xccccccccccccccccn,
        recovery: 0,
        toBytes: () => sig,
        toCompactRawBytes: () => sig,
        toDERRawBytes: () => new Uint8Array([0x30, ...sig]),
      };
    }),
  },
}));

vi.mock("@scure/bip32", () => ({
  HDKey: {
    fromMasterSeed: vi.fn(() => ({
      derive: () => ({ privateKey: new Uint8Array(32).fill(0x11) }),
    })),
  },
}));

// ─── Mock Storage ─────────────────────────────────────────────

class MockStorage implements StorageAdapter {
  private data: WalletData | null = null;
  type = "memory";
  isAvailable() {
    return true;
  }
  async load() {
    return this.data;
  }
  async save(data: WalletData) {
    this.data = data;
  }
  async clear() {
    this.data = null;
  }
}

// ─── Mock RPC ─────────────────────────────────────────────────

function mockFetchRpc(handler: (method: string, params: unknown[]) => unknown) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, opts) => {
      const body = JSON.parse((opts as RequestInit).body as string);
      const result = handler(body.method, body.params);
      return {
        ok: true,
        json: async () => ({ jsonrpc: "2.0", id: body.id, result }),
      } as Response;
    });
}

// ─── Constants ────────────────────────────────────────────────

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const RECIPIENT = ("0x" + "ab".repeat(20)) as `0x${string}`;
const RECIPIENT2 = ("0x" + "cd".repeat(20)) as `0x${string}`;

async function createWallet(rpcUrl?: string) {
  const w = new PocketWallet({
    storage: new MockStorage(),
    autoSave: false,
    rpcUrl,
  });
  await w.importMnemonic(TEST_MNEMONIC);
  return w;
}

// ═══════════════════════════════════════════════════════════════
// 1. ADDRESS DERIVATION
// ═══════════════════════════════════════════════════════════════

describe("Embedded Financial: Address Derivation", () => {
  it("derives valid checksummed address from mnemonic", async () => {
    const w = await createWallet();
    expect(w.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(w.address!.length).toBe(42);
  });

  it("derives same address deterministically", async () => {
    const w1 = await createWallet();
    const w2 = await createWallet();
    expect(w1.address).toBe(w2.address);
  });

  it("derives address from private key", async () => {
    const w = new PocketWallet({ storage: new MockStorage(), autoSave: false });
    await w.importPrivateKey(("0x" + "11".repeat(32)) as `0x${string}`);
    expect(w.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("returns null address before any import", () => {
    const w = new PocketWallet({ storage: new MockStorage(), autoSave: false });
    expect(w.address).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. SIGN MESSAGE
// ═══════════════════════════════════════════════════════════════

describe("Embedded Financial: signMessage", () => {
  let wallet: PocketWallet;
  beforeEach(async () => {
    wallet = await createWallet();
  });

  it("signs a simple message", async () => {
    const result = await wallet.signMessage("Hello, World!");
    expect(result.signature).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(result.signature.length).toBeGreaterThan(2);
  });

  it("signs an empty string", async () => {
    const result = await wallet.signMessage("");
    expect(result.signature).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  it("signs hex-encoded message", async () => {
    const result = await wallet.signMessage("0x48656c6c6f");
    expect(result.signature).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  it("signs a long message (4096 chars)", async () => {
    const longMsg = "x".repeat(4096);
    const result = await wallet.signMessage(longMsg);
    expect(result.signature).toMatch(/^0x[0-9a-fA-F]+$/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. SIGN TRANSACTION — EIP-1559
// ═══════════════════════════════════════════════════════════════

describe("Embedded Financial: signTransaction EIP-1559", () => {
  let wallet: PocketWallet;
  beforeEach(async () => {
    wallet = await createWallet();
  });

  it("signs EIP-1559 transfer (type 2)", async () => {
    const r = await wallet.signTransaction({
      to: RECIPIENT,
      value: "0xde0b6b3a7640000",
      nonce: "0x0",
      maxFeePerGas: "0x59682f00",
      maxPriorityFeePerGas: "0x3b9aca00",
      gas: "0x5208",
      chainId: 1,
    });
    expect(r.signature).toMatch(/^0x02[0-9a-f]+$/);
  });

  it("signs 0.1 ETH transfer", async () => {
    const v = parseUnits("0.1", 18);
    const r = await wallet.signTransaction({
      to: RECIPIENT,
      value: ("0x" + v.toString(16)) as `0x${string}`,
      nonce: "0x1",
      maxFeePerGas: "0x59682f00",
      maxPriorityFeePerGas: "0x3b9aca00",
      gas: "0x5208",
      chainId: 1,
    });
    expect(r.signature).toMatch(/^0x02[0-9a-f]+$/);
  });

  it("signs zero-value contract interaction", async () => {
    const r = await wallet.signTransaction({
      to: RECIPIENT,
      value: "0x0",
      data: "0xa9059cbb0000000000000000000000000000000000000000000000000000000000000000",
      nonce: "0x2",
      maxFeePerGas: "0x59682f00",
      maxPriorityFeePerGas: "0x3b9aca00",
      gas: "0x186a0",
      chainId: 1,
    });
    expect(r.signature).toMatch(/^0x02[0-9a-f]+$/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. SIGN TRANSACTION — LEGACY
// ═══════════════════════════════════════════════════════════════

describe("Embedded Financial: signTransaction Legacy", () => {
  let wallet: PocketWallet;
  beforeEach(async () => {
    wallet = await createWallet();
  });

  it("signs legacy transfer (type 0)", async () => {
    const r = await wallet.signTransaction({
      to: RECIPIENT,
      value: "0x2386f26fc10000",
      nonce: "0x0",
      gasPrice: "0x9502f900",
      gas: "0x5208",
      chainId: 1,
    });
    expect(r.signature.slice(2, 4)).not.toBe("02");
    expect(r.signature).toMatch(/^0x[0-9a-f]+$/);
  });

  it("signs legacy with gwei values", async () => {
    const r = await wallet.signTransaction({
      to: RECIPIENT,
      value: "0xde0b6b3a7640000",
      nonce: "0x1",
      gasPrice: "0x4a817c800",
      gas: "0x5208",
      chainId: 1,
    });
    expect(r.signature).toMatch(/^0x[0-9a-f]+$/);
  });

  it("produces different sigs for 1 ETH vs 2 ETH", async () => {
    const base = {
      to: RECIPIENT,
      nonce: "0x0" as `0x${string}`,
      gasPrice: "0x4a817c800" as `0x${string}`,
      gas: "0x5208" as `0x${string}`,
      chainId: 1,
    };
    const r1 = await wallet.signTransaction({
      ...base,
      value: "0xde0b6b3a7640000" as `0x${string}`,
    });
    const r2 = await wallet.signTransaction({
      ...base,
      value: "0x1bc16d674ec80000" as `0x${string}`,
    });
    expect(r1.signature).not.toBe(r2.signature);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. FULL SEND TRANSACTION (MOCK RPC)
// ═══════════════════════════════════════════════════════════════

describe("Embedded Financial: sendTransaction", () => {
  let wallet: PocketWallet;
  let rpcSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    wallet = await createWallet("https://eth.llamarpc.com");
  });

  afterEach(() => {
    rpcSpy?.mockRestore();
  });

  it("parse → build → sign → broadcast (0.05 ETH, EIP-1559)", async () => {
    const val = parseUnits("0.05", 18);
    rpcSpy = mockFetchRpc((m) => {
      switch (m) {
        case "eth_getTransactionCount":
          return "0x3";
        case "eth_estimateGas":
          return "0x5208";
        case "eth_sendRawTransaction":
          return "0x" + "dd".repeat(32);
        default:
          return null;
      }
    });
    const result = await wallet.sendTransaction({
      to: RECIPIENT,
      value: ("0x" + val.toString(16)) as `0x${string}`,
      maxFeePerGas: "0x59682f00",
      maxPriorityFeePerGas: "0x3b9aca00",
    });
    expect(result.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(result.value)).toBe(val);
  });

  it("broadcasts legacy tx with gasPrice", async () => {
    rpcSpy = mockFetchRpc((m) => {
      switch (m) {
        case "eth_getTransactionCount":
          return "0x5";
        case "eth_estimateGas":
          return "0x5208";
        case "eth_sendRawTransaction":
          return "0x" + "ee".repeat(32);
        default:
          return null;
      }
    });
    const result = await wallet.sendTransaction({
      to: RECIPIENT,
      value: "0xde0b6b3a7640000",
      gasPrice: "0x9502f900",
    });
    expect(result.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. ERC20 CALL DATA
// ═══════════════════════════════════════════════════════════════

describe("Embedded Financial: ERC20 Call Data", () => {
  const USDC = {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`,
    chainId: 1,
  };

  it("buildTransferTx encodes correct USDC transfer", async () => {
    const tx = await ERC20TokenHelper.buildTransferTx(
      { token: USDC, to: RECIPIENT, amount: "50", from: RECIPIENT2 },
      6,
    );
    expect(tx.to).toBe(USDC.address);
    expect(tx.data).toMatch(/^0xa9059cbb/);
    expect(tx.data).toContain(RECIPIENT.slice(2).toLowerCase());
    expect(tx.value).toBe("0x0");
  });

  it("buildApproveTx encodes correct approve", async () => {
    const spender = ("0x" + "ef".repeat(20)) as `0x${string}`;
    const tx = await ERC20TokenHelper.buildApproveTx(
      { token: USDC, spender, amount: "1000", owner: RECIPIENT2 },
      18,
    );
    expect(tx.to).toBe(USDC.address);
    expect(tx.data).toMatch(/^0x095ea7b3/);
    expect(tx.value).toBe("0x0");
  });

  it("buildApproveTx handles max uint256", async () => {
    const spender = ("0x" + "ef".repeat(20)) as `0x${string}`;
    const max = 2n ** 256n - 1n;
    const tx = await ERC20TokenHelper.buildApproveTx(
      { token: USDC, spender, amount: max, owner: RECIPIENT2 },
      18,
    );
    expect(tx.data).toContain(
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    );
  });

  it("buildTransferFromTx encodes transferFrom", async () => {
    const tx = await ERC20TokenHelper.buildTransferFromTx(
      { token: USDC, from: RECIPIENT, to: RECIPIENT2, amount: "10" },
      6,
    );
    expect(tx.data).toMatch(/^0x23b872dd/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. EDGE CASES
// ═══════════════════════════════════════════════════════════════

describe("Embedded Financial: Edge Cases", () => {
  let wallet: PocketWallet;
  beforeEach(async () => {
    wallet = await createWallet();
  });

  it("signs 1 wei transfer (dust)", async () => {
    const r = await wallet.signTransaction({
      to: RECIPIENT,
      value: "0x1",
      nonce: "0x0",
      maxFeePerGas: "0x59682f00",
      maxPriorityFeePerGas: "0x3b9aca00",
      gas: "0x5208",
      chainId: 1,
    });
    expect(r.signature).toMatch(/^0x02[0-9a-f]+$/);
  });

  it("signs zero-value call", async () => {
    const r = await wallet.signTransaction({
      to: RECIPIENT,
      value: "0x0",
      data: "0x",
      nonce: "0x1",
      maxFeePerGas: "0x59682f00",
      maxPriorityFeePerGas: "0x3b9aca00",
      gas: "0x5208",
      chainId: 1,
    });
    expect(r.signature).toMatch(/^0x02[0-9a-f]+$/);
  });

  it("signs 1M ETH (large bigint)", { timeout: 10000 }, async () => {
    const large = 1_000_000n * 10n ** 18n;
    const r = await wallet.signTransaction({
      to: RECIPIENT,
      value: ("0x" + large.toString(16)) as `0x${string}`,
      nonce: "0x0",
      maxFeePerGas: "0x59682f00",
      maxPriorityFeePerGas: "0x3b9aca00",
      gas: "0x5208",
      chainId: 1,
    });
    expect(r.signature).toMatch(/^0x02[0-9a-f]+$/);
  });

  it("signs max uint256 value (wallet allows, mempool enforces)", {
    timeout: 10000,
  }, async () => {
    const max =
      "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as `0x${string}`;
    const r = await wallet.signTransaction({
      to: RECIPIENT,
      value: max,
      nonce: "0x0",
      maxFeePerGas: "0x59682f00",
      maxPriorityFeePerGas: "0x3b9aca00",
      gas: "0x5208",
      chainId: 1,
    });
    expect(r.signature).toMatch(/^0x02[0-9a-f]+$/);
  });

  it("bigint math does not use Number conversion", () => {
    const fees = [1_000_000_000n, 10_000_000_000n, 100_000_000_000n].reduce(
      (s, v) => s + v,
      0n,
    );
    expect(fees).toBe(111_000_000_000n);
    expect(typeof (fees * 21_000n)).toBe("bigint");
  });

  it("parseUnits handles 18 and 6 decimal values", () => {
    expect(parseUnits("1.5", 18)).toBe(1_500_000_000_000_000_000n);
    expect(parseUnits("1.5", 6)).toBe(1_500_000n);
  });

  it("throws on negative parseUnits", () => {
    expect(() => parseUnits("-1", 18)).toThrow();
    expect(() => parseUnits("-0.5", 6)).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. MOCK RPC FULL FLOW
// ═══════════════════════════════════════════════════════════════

describe("Embedded Financial: Mock RPC Full Flow", () => {
  let wallet: PocketWallet;
  let rpcSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    rpcSpy?.mockRestore();
  });

  it("completes full lifecycle: getBalance → send → confirm", async () => {
    wallet = await createWallet("https://eth.llamarpc.com");
    let callCount = 0;
    rpcSpy = mockFetchRpc((m) => {
      callCount++;
      switch (m) {
        case "eth_getBalance":
          return "0x56BC75E2D63100000"; // 100 ETH
        case "eth_getTransactionCount":
          return "0x2";
        case "eth_estimateGas":
          return "0x5208";
        case "eth_sendRawTransaction":
          return "0x" + "aa".repeat(32);
        default:
          return null;
      }
    });

    const balance = await wallet.getBalance();
    expect(BigInt(balance)).toBeGreaterThan(0n);

    const result = await wallet.sendTransaction({
      to: RECIPIENT,
      value: "0xde0b6b3a7640000",
      maxFeePerGas: "0x59682f00",
      maxPriorityFeePerGas: "0x3b9aca00",
    });
    expect(result.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.from).toBe(wallet.address);
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("signs value exceeding balance (mempool enforces, wallet doesn't)", async () => {
    wallet = await createWallet("https://eth.llamarpc.com");
    rpcSpy = mockFetchRpc((m) => {
      switch (m) {
        case "eth_getTransactionCount":
          return "0x0";
        case "eth_estimateGas":
          return "0x5208";
        case "eth_sendRawTransaction":
          return "0x" + "bb".repeat(32);
        default:
          return null;
      }
    });
    const result = await wallet.sendTransaction({
      to: RECIPIENT,
      value: ("0x" + parseUnits("200", 18).toString(16)) as `0x${string}`,
      maxFeePerGas: "0x59682f00",
      maxPriorityFeePerGas: "0x3b9aca00",
    });
    expect(result.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

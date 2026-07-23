/**
 * Financial Integration Unit Tests
 *
 * Tests the full financial value pipeline end-to-end within wallet-engine:
 *   1. Value parsing → transaction construction → signing
 *   2. Fee oracle → transaction building integration
 *   3. ERC-7821 sendCalls bundle value math
 *   4. ERC20 token operations (buildTransferTx, buildApproveTx)
 *   5. Financial edge cases (overflow, dust, max values, zero)
 *
 * Integration-style: composes multiple modules (fee-oracle, transaction, wallet)
 * but runs as unit tests with mocked RPC.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PocketWallet } from "../wallet";
import type { WalletData, SendTransactionResult } from "../wallet";
import type { StorageAdapter } from "../storage/types";
import { buildTransaction, cloneForBumping } from "../transaction";
import {
  resolveFeeOptions,
  validateFeeParams,
  applyMultiplier,
  shouldUseEIP1559,
} from "../fee-oracle";
import type { TransactionRequest } from "../signers/types";

// ─── Mock: replace estimateFees only, keep real parseUnits + ERC20TokenHelper ─

vi.mock("@naculus/connect-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@naculus/connect-core")>()),
  estimateFees: vi.fn(),
}));

import { parseUnits, ERC20TokenHelper, estimateFees } from "@naculus/connect-core";

// ─── Types ─────────────────────────────────────────────────────────

interface ValueTestCase {
  input: string | bigint | number;
  decimals: number;
  expected: bigint;
  description: string;
}

// ─── Constants ─────────────────────────────────────────────────────

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const RECIPIENT = "0x" + "ab".repeat(20) as `0x${string}`;
const RECIPIENT2 = "0x" + "cd".repeat(20) as `0x${string}`;

// ─── Mock Storage ─────────────────────────────────────────────────

class MockStorage implements StorageAdapter {
  private data: WalletData | null = null;
  isAvailable() { return true; }
  async load() { return this.data; }
  async save(data: WalletData) { this.data = data; }
  async clear() { this.data = null; }
}

// ─── Mock RPC ─────────────────────────────────────────────────────

function mockFetchRpc(
  handler: (method: string, params: unknown[]) => unknown,
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, opts) => {
    const body = JSON.parse((opts as RequestInit).body as string);
    const result = handler(body.method, body.params);
    return {
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: body.id, result }),
    } as Response;
  });
}

async function createWallet(rpcUrl?: string) {
  const w = new PocketWallet({ storage: new MockStorage(), autoSave: false, rpcUrl });
  await w.importMnemonic(TEST_MNEMONIC);
  return w;
}

// ═══════════════════════════════════════════════════════════════════
// 1. VALUE PIPELINE
// ═══════════════════════════════════════════════════════════════════

describe("Financial Integration: Value Pipeline", () => {
  let wallet: PocketWallet;
  beforeEach(async () => { wallet = await createWallet(); });

  describe("1.1 parseUnits", () => {
    const cases: ValueTestCase[] = [
      { input: "1", decimals: 18, expected: 10n ** 18n, description: "1 ETH" },
      { input: "0.01", decimals: 18, expected: 10n ** 16n, description: "0.01 ETH" },
      { input: "0.000000000000000001", decimals: 18, expected: 1n, description: "1 wei" },
      { input: "1", decimals: 6, expected: 1_000_000n, description: "1 USDC" },
      { input: "0.5", decimals: 6, expected: 500_000n, description: "0.5 USDC" },
      { input: "0.000001", decimals: 6, expected: 1n, description: "1 micro-USDC" },
      { input: "100", decimals: 0, expected: 100n, description: "100 tokens (0 decimals)" },
      { input: "0", decimals: 0, expected: 0n, description: "zero tokens" },
      { input: 10n ** 18n, decimals: 18, expected: 10n ** 18n, description: "BigInt passthrough" },
      { input: "1000000", decimals: 18, expected: 10n ** 24n, description: "1M ETH" },
    ];

    for (const c of cases) {
      it(`parseUnits: ${c.description}`, () => {
        expect(parseUnits(c.input, c.decimals)).toBe(c.expected);
      });
    }
  });

  describe("1.2 Value → sign", () => {
    it("should sign exact 0.1 ETH transfer", async () => {
      const v = parseUnits("0.1", 18);
      const r = await wallet.signTransaction({
        to: RECIPIENT, value: ("0x" + v.toString(16)) as `0x${string}`,
        nonce: "0x0" as `0x${string}`,
        maxFeePerGas: "0x59682f00" as `0x${string}`,
        maxPriorityFeePerGas: "0x3b9aca00" as `0x${string}`,
        gas: "0x5208" as `0x${string}`, chainId: 1,
      });
      expect(r.signature).toMatch(/^0x02[0-9a-f]+$/);
    });

    it("should sign zero-value data call", async () => {
      const r = await wallet.signTransaction({
        to: RECIPIENT, value: "0x0" as `0x${string}`,
        data: "0xa9059cbb0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
        nonce: "0x1" as `0x${string}`,
        maxFeePerGas: "0x59682f00" as `0x${string}`,
        maxPriorityFeePerGas: "0x3b9aca00" as `0x${string}`,
        gas: "0x186a0" as `0x${string}`, chainId: 1,
      });
      expect(r.signature).toMatch(/^0x02[0-9a-f]+$/);
    });

    it("should sign max uint256 without overflow", { timeout: 10000 }, async () => {
      const max = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as `0x${string}`;
      const r = await wallet.signTransaction({
        to: RECIPIENT, value: max,
        nonce: "0x0" as `0x${string}`, gasPrice: "0x4a817c800" as `0x${string}`,
        gas: "0x5208" as `0x${string}`, chainId: 1,
      });
      expect(r.signature).toMatch(/^0x[0-9a-f]+$/);
    });

    it("should produce different signatures for 1 ETH vs 2 ETH", { timeout: 10000 }, async () => {
      const base = { to: RECIPIENT, nonce: "0x0" as `0x${string}`,
        gasPrice: "0x4a817c800" as `0x${string}`, gas: "0x5208" as `0x${string}`, chainId: 1 };
      const r1 = await wallet.signTransaction({ ...base, value: "0xde0b6b3a7640000" as `0x${string}` });
      const r2 = await wallet.signTransaction({ ...base, value: "0x1bc16d674ec80000" as `0x${string}` });
      expect(r1.signature).not.toBe(r2.signature);
    });

    it("should sign legacy tx with gwei values", async () => {
      const r = await wallet.signTransaction({
        to: RECIPIENT, value: "0x2386f26fc10000" as `0x${string}`,
        nonce: "0x0" as `0x${string}`, gasPrice: "0x9502f900" as `0x${string}`,
        gas: "0x5208" as `0x${string}`, chainId: 1,
      });
      expect(r.signature.slice(2, 4)).not.toBe("02"); // not EIP-1559
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. FEE ORACLE + TRANSACTION BUILDING
// ═══════════════════════════════════════════════════════════════════

describe("Financial Integration: Fee Oracle", () => {
  const MOCK_RPC = "https://eth.llamarpc.com";
  beforeEach(() => { vi.clearAllMocks(); });

  describe("2.1 shouldUseEIP1559", () => {
    it("EIP-1559 fields → true", () => expect(shouldUseEIP1559({ maxFeePerGas: "0x100" })).toBe(true));
    it("gasPrice → false", () => expect(shouldUseEIP1559({ gasPrice: "0x100" })).toBe(false));
    it("type:legacy overrides", () => expect(shouldUseEIP1559({ type: "legacy", maxFeePerGas: "0x100" })).toBe(false));
    it("type:eip1559 overrides gasPrice", () => expect(shouldUseEIP1559({ type: "eip1559", gasPrice: "0x100" })).toBe(true));
    it("no fields → auto (default true)", () => expect(shouldUseEIP1559({})).toBe(true));
  });

  const baseTx: TransactionRequest = {
    to: RECIPIENT, value: "0xde0b6b3a7640000", data: "0x",
    gas: "0x5208", nonce: "0x5", chainId: 1,
  };

  describe("2.2 buildTransaction", () => {
    it("EIP-1559 clears gasPrice", () => {
      const tx = buildTransaction(baseTx, { type: "eip1559", maxFeePerGas: "0x100", maxPriorityFeePerGas: "0x50" });
      expect(tx.maxFeePerGas).toBe("0x100");
      expect(tx.gasPrice).toBeUndefined();
    });

    it("Legacy clears EIP-1559 fields", () => {
      const tx = buildTransaction(baseTx, { type: "legacy", gasPrice: "0x4a817c800" });
      expect(tx.gasPrice).toBe("0x4a817c800");
      expect(tx.maxFeePerGas).toBeUndefined();
    });
  });

  describe("2.3 resolveFeeOptions", () => {
    it("uses direct EIP-1559 fees (no estimation)", async () => {
      const r = await resolveFeeOptions({ maxFeePerGas: "0x100", maxPriorityFeePerGas: "0x50" }, MOCK_RPC);
      expect(r.type).toBe("eip1559");
      expect(vi.mocked(estimateFees)).not.toHaveBeenCalled();
    });

    it("uses direct legacy fee (no estimation)", async () => {
      const r = await resolveFeeOptions({ gasPrice: "0x4a817c800" }, MOCK_RPC);
      expect(r.type).toBe("legacy");
      expect(vi.mocked(estimateFees)).not.toHaveBeenCalled();
    });

    it("estimates fees when no fee fields provided", async () => {
      vi.mocked(estimateFees).mockResolvedValueOnce({ type: "eip1559", maxFeePerGas: 50_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
      const r = await resolveFeeOptions({}, MOCK_RPC, "eip155:1");
      expect(r.type).toBe("eip1559");
      expect(BigInt(r.maxFeePerGas)).toBe(50_000_000_000n);
    });

    it("falls back to legacy gasPrice when estimation fails", async () => {
      vi.mocked(estimateFees).mockRejectedValueOnce(new Error("EIP-1559 not supported"));
      const spy = mockFetchRpc((m) => m === "eth_gasPrice" ? "0x9502f900" : null);
      const r = await resolveFeeOptions({}, MOCK_RPC);
      expect(r.type).toBe("legacy");
      expect(r.gasPrice).toBe("0x9502f900");
      spy.mockRestore();
    });
  });

  describe("2.4 validateFeeParams", () => {
    it("accepts valid EIP-1559", () => expect(() => validateFeeParams({ type: "eip1559", maxFeePerGas: "0x100", maxPriorityFeePerGas: "0x50" })).not.toThrow());
    it("accepts valid legacy", () => expect(() => validateFeeParams({ type: "legacy", gasPrice: "0x100" })).not.toThrow());
    it("rejects zero maxFeePerGas", () => expect(() => validateFeeParams({ type: "eip1559", maxFeePerGas: "0x0", maxPriorityFeePerGas: "0x50" })).toThrow());
    it("rejects maxFee < priority", () => expect(() => validateFeeParams({ type: "eip1559", maxFeePerGas: "0x10", maxPriorityFeePerGas: "0x100" })).toThrow());
    it("rejects zero gasPrice", () => expect(() => validateFeeParams({ type: "legacy", gasPrice: "0x0" })).toThrow());
  });

  describe("2.5 Fee bumping", () => {
    it("applyMultiplier +10%", () => {
      const r = applyMultiplier("0xba43b7400", 1.1);
      expect(BigInt(r)).toBe(BigInt("0xba43b7400") * 110n / 100n);
    });

    it("cloneForBumping clears fee fields", () => {
      const tx = { ...baseTx, maxFeePerGas: "0x100" as `0x${string}`, maxPriorityFeePerGas: "0x50" as `0x${string}` };
      const c = cloneForBumping(tx);
      expect(c.maxFeePerGas).toBeUndefined();
      expect(c.value).toBe(tx.value);
    });

    it("full RBF cycle: build → bump → rebuild", () => {
      const t1 = buildTransaction(baseTx, { type: "eip1559", maxFeePerGas: "0x100", maxPriorityFeePerGas: "0x50" });
      const c = cloneForBumping(t1);
      const mf = applyMultiplier("0x100", 1.2);
      const mp = applyMultiplier("0x50", 1.2);
      const t2 = buildTransaction(c, { type: "eip1559", maxFeePerGas: mf, maxPriorityFeePerGas: mp });
      expect(BigInt(t2.maxFeePerGas!)).toBeGreaterThan(BigInt(t1.maxFeePerGas!));
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. ERC-7821 BUNDLING VALUE MATH
// ═══════════════════════════════════════════════════════════════════

describe("Financial Integration: sendCalls Value Math", () => {
  it("sums bundle values correctly", () => {
    const total = [{ v: "1000000000000000000" }, { v: "500000000000000000" }, { v: "250000000000000000" }]
      .reduce((s, x) => s + BigInt(x.v), 0n);
    expect(total).toBe(1_750_000_000_000_000_000n);
    expect(total).toBe(parseUnits("1.75", 18));
  });

  it("max uint96 for deposit contract", () => {
    const deposit = parseUnits("32", 18);
    expect(deposit).toBeLessThan(2n ** 96n);
  });

  it("dust accumulation no overflow (1000×1 wei)", () => {
    expect(Array.from({ length: 1000 }, () => 1n).reduce((s, v) => s + v, 0n)).toBe(1000n);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. ERC20 TOKEN OPERATIONS
// ═══════════════════════════════════════════════════════════════════

describe("Financial Integration: ERC20 Token Operations", () => {
  const TOKEN = { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`, chainId: 1 };

  it("buildTransferTx encodes correct USDC transfer call data", async () => {
    const tx = await ERC20TokenHelper.buildTransferTx(
      { token: TOKEN, to: RECIPIENT, amount: "50", from: RECIPIENT2 },
      6, // USDC decimals
    );
    expect(tx.to).toBe(TOKEN.address);
    expect(tx.data).toMatch(/^0xa9059cbb/); // transfer selector
    expect(tx.data).toContain(RECIPIENT.slice(2).toLowerCase()); // recipient
    expect(tx.value).toBe("0x0");
  });

  it("buildApproveTx encodes correct DAI approve call data", async () => {
    const spender = "0x" + "ef".repeat(20) as `0x${string}`;
    const tx = await ERC20TokenHelper.buildApproveTx(
      { token: TOKEN, spender, amount: "1000", owner: RECIPIENT2 },
      18, // DAI decimals
    );
    expect(tx.to).toBe(TOKEN.address);
    expect(tx.data).toMatch(/^0x095ea7b3/); // approve selector
    expect(tx.data).toContain(spender.slice(2).toLowerCase());
    expect(tx.value).toBe("0x0");
  });

  it("buildApproveTx handles max uint256 approval", async () => {
    const spender = "0x" + "ef".repeat(20) as `0x${string}`;
    const max = 2n ** 256n - 1n;
    const tx = await ERC20TokenHelper.buildApproveTx(
      { token: TOKEN, spender, amount: max, owner: RECIPIENT2 },
      18,
    );
    expect(tx.data).toContain("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
  });

  it("buildTransferFromTx encodes transferFrom", async () => {
    const tx = await ERC20TokenHelper.buildTransferFromTx(
      { token: TOKEN, from: RECIPIENT, to: RECIPIENT2, amount: "10" },
      6,
    );
    expect(tx.data).toMatch(/^0x23b872dd/); // transferFrom selector
  });

  it("abiEncodeAddress rejects invalid address", async () => {
    const { abiEncodeAddress } = await vi.importActual<typeof import("@naculus/connect-core")>("@naculus/connect-core");
    expect(() => abiEncodeAddress("0xshort" as any)).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. FULL TRANSFER SCENARIO
// ═══════════════════════════════════════════════════════════════════

describe("Financial Integration: Full Transfer Scenario", () => {
  let wallet: PocketWallet;
  let rpcSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    wallet = await createWallet("https://eth.llamarpc.com");
  });

  afterEach(() => { rpcSpy?.mockRestore(); });

  it("parse → build → sign → broadcast (0.05 ETH, EIP-1559)", async () => {
    const val = parseUnits("0.05", 18);
    rpcSpy = mockFetchRpc((m) => {
      switch (m) {
        case "eth_getTransactionCount": return "0x3";
        case "eth_estimateGas": return "0x5208";
        case "eth_sendRawTransaction": return "0x" + "dd".repeat(32);
        default: return null;
      }
    });
    vi.mocked(estimateFees).mockResolvedValueOnce({ type: "eip1559", maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });

    const result = await wallet.sendTransaction({ to: RECIPIENT, value: "0x" + val.toString(16) as `0x${string}` });
    expect(result.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(result.value || "0x0")).toBe(val);
  });

  it("no precision loss on 18-decimal value", async () => {
    const hex = "0x11210f3c8c1bc0e15"; // 1.234567890123456789 ETH
    rpcSpy = mockFetchRpc((m) => {
      switch (m) {
        case "eth_getTransactionCount": return "0x0";
        case "eth_estimateGas": return "0x5208";
        case "eth_sendRawTransaction": return "0x" + "aa".repeat(32);
        default: return null;
      }
    });
    vi.mocked(estimateFees).mockResolvedValueOnce({ type: "eip1559", maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });

    const r = await wallet.sendTransaction({ to: RECIPIENT, value: hex as `0x${string}` });
    expect(r.value).toBe(hex);
    expect(BigInt(r.value!)).toBe(BigInt(hex));
  });

  it("signs value exceeding balance (mempool enforces, wallet doesn't)", async () => {
    rpcSpy = mockFetchRpc((m) => {
      switch (m) {
        case "eth_getTransactionCount": return "0x0";
        case "eth_estimateGas": return "0x5208";
        case "eth_sendRawTransaction": return "0x" + "bb".repeat(32);
        default: return null;
      }
    });
    vi.mocked(estimateFees).mockResolvedValueOnce({ type: "eip1559", maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });

    const r = await wallet.sendTransaction({ to: RECIPIENT, value: "0x" + parseUnits("200", 18).toString(16) as `0x${string}` });
    expect(r.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe("Financial Integration: Edge Cases", () => {
  it("signs 1 wei transfer (dust)", async () => {
    const w = await createWallet();
    const r = await w.signTransaction({
      to: RECIPIENT, value: "0x1" as `0x${string}`,
      nonce: "0x0" as `0x${string}`, maxFeePerGas: "0x59682f00" as `0x${string}`,
      maxPriorityFeePerGas: "0x3b9aca00" as `0x${string}`, gas: "0x5208" as `0x${string}`, chainId: 1,
    });
    expect(r.signature).toMatch(/^0x02[0-9a-f]+$/);
  });

  it("signs zero-value contract call", async () => {
    const w = await createWallet();
    const r = await w.signTransaction({
      to: RECIPIENT, value: "0x0" as `0x${string}`, data: "0x" as `0x${string}`,
      nonce: "0x0" as `0x${string}`, maxFeePerGas: "0x59682f00" as `0x${string}`,
      maxPriorityFeePerGas: "0x3b9aca00" as `0x${string}`, gas: "0x5208" as `0x${string}`, chainId: 1,
    });
    expect(r.signature).toMatch(/^0x02[0-9a-f]+$/);
  });

  it("signs 1M ETH (large bigint)", { timeout: 10000 }, async () => {
    const w = await createWallet();
    const large = 1_000_000n * 10n ** 18n;
    const r = await w.signTransaction({
      to: RECIPIENT, value: ("0x" + large.toString(16)) as `0x${string}`,
      nonce: "0x0" as `0x${string}`, maxFeePerGas: "0x59682f00" as `0x${string}`,
      maxPriorityFeePerGas: "0x3b9aca00" as `0x${string}`, gas: "0x5208" as `0x${string}`, chainId: 1,
    });
    expect(r.signature).toMatch(/^0x02[0-9a-f]+$/);
  });

  it("bigint math does not use Number conversion", () => {
    const fees = [1_000_000_000n, 10_000_000_000n, 100_000_000_000n].reduce((s, v) => s + v, 0n);
    expect(fees).toBe(111_000_000_000n);
    expect(typeof (fees * 21_000n)).toBe("bigint");
  });

  it("cross-token decimal conversion uses BigInt", () => {
    const u = parseUnits("1.5", 6); // USDC: 1_500_000n
    const e = parseUnits("1.5", 18); // ETH: 1_500_000_000_000_000_000n
    expect(u * 10n ** 12n).toBe(e);
  });

  it("rejects negative parseUnits", () => {
    expect(() => parseUnits("-1", 18)).toThrow();
    expect(() => parseUnits("-0.5", 6)).toThrow();
  });

  it("parseUnits handles leading zeros in decimal string", () => {
    expect(parseUnits("000.5", 18)).toBe(500_000_000_000_000_000n);
    expect(parseUnits("000.5", 18)).toBe(parseUnits("0.5", 18));
    expect(parseUnits("0010", 18)).toBe(10n * 10n ** 18n);
  });

  it("parseUnits handles integer exceeding Number.MAX_SAFE_INTEGER", () => {
    const large = "9007199254740993";
    const result = parseUnits(large, 0);
    expect(result).toBe(9_007_199_254_740_993n);
    expect(result).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(result.toString()).toBe("9007199254740993"); // Number() would lose precision to 9007199254740992
  });

  it("hex value round-trips through BigInt without precision loss", () => {
    const hex = "0x112210f3c8c1bc0e15";
    const val = BigInt(hex);
    const back = "0x" + val.toString(16);
    expect(back).toBe(hex);
    expect(val).toBe(BigInt(back));
    expect(val).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });
});

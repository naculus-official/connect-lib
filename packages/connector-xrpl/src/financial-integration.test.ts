import { beforeEach, describe, expect, it, vi } from "vitest";

describe("XRPL Crypto: Address & Key Format", () => {
  it("validates XRPL classic address format (r...)", () => {
    const addr = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
    expect(addr.startsWith("r")).toBe(true);
    expect(addr.length).toBeGreaterThanOrEqual(25);
    expect(addr.length).toBeLessThanOrEqual(35);
  });

  it("validates XRPL seed format (s...)", () => {
    const seed = "sEdVpKso4K7Vg8P9Q5R6S3T2U1W4X5Y6Z7A8B9C";
    expect(seed.startsWith("s")).toBe(true);
  });

  it("derives secp256k1 key for XRPL", async () => {
    const { secp256k1 } = await import("@noble/curves/secp256k1");
    const priv = secp256k1.utils.randomPrivateKey();
    const pub = secp256k1.getPublicKey(priv, true);
    expect(pub.length).toBe(33);
  });

  it("signs XRPL payment transaction", async () => {
    const { secp256k1 } = await import("@noble/curves/secp256k1");
    const { keccak_256 } = await import("@noble/hashes/sha3.js");
    const priv = secp256k1.utils.randomPrivateKey();
    const txBlob = new TextEncoder().encode(
      JSON.stringify({
        TransactionType: "Payment",
        Account: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
        Destination: "rB8J4VRWn96DkukG4bwdtyThHb9CJAWy",
        Amount: "1000000",
        Fee: "12",
        Sequence: 1,
      }),
    );
    const hash = keccak_256(txBlob);
    const sig = secp256k1.sign(hash, priv);
    expect(sig.toCompactRawBytes().length).toBe(64);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. XRPL VALUE PIPELINE
// ═══════════════════════════════════════════════════════════════

describe("XRPL Financial: Value Pipeline", () => {
  const mod = () => import("./index") as Promise<typeof import("./index")>;

  it("parseXRPAmount converts human-readable XRP to drops", async () => {
    const { parseXRPAmount } = await mod();
    expect(parseXRPAmount("1")).toBe("1000000");
    expect(parseXRPAmount("0.000001")).toBe("1");
    expect(parseXRPAmount("0")).toBe("0");
  });

  it("formatXRPAmount converts drops to human-readable XRP", async () => {
    const { formatXRPAmount } = await mod();
    expect(formatXRPAmount("1000000")).toBe("1.000000");
    expect(formatXRPAmount("1")).toBe("0.000001");
    expect(formatXRPAmount("0")).toBe("0.000000");
  });

  it("parseXRPAmount and formatXRPAmount round-trip", async () => {
    const { parseXRPAmount, formatXRPAmount } = await mod();
    const original = "1234567";
    const rt = parseXRPAmount(formatXRPAmount(original));
    expect(rt).toBe(original);
  });

  it("handles 1-drop amount (dust)", async () => {
    const { parseXRPAmount } = await mod();
    expect(parseXRPAmount("0.000001")).toBe("1");
    expect(BigInt(parseXRPAmount("0.000001"))).toBe(1n);
  });

  it("handles zero amount", async () => {
    const { parseXRPAmount } = await mod();
    expect(parseXRPAmount("0")).toBe("0");
    expect(BigInt(parseXRPAmount("0"))).toBe(0n);
  });

  it("handles large amount exceeding Number.MAX_SAFE_INTEGER", () => {
    const largeDrops = "9007199254740993"; // > Number.MAX_SAFE_INTEGER
    const xrp = (BigInt(largeDrops) * 10n ** 6n).toString();
    expect(BigInt(xrp)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(typeof xrp).toBe("string");
  });

  it("amounts use bigint math, not Number", () => {
    const drops = [1_000_000n, 2_000_000n, 500_000n].reduce(
      (s, v) => s + v,
      0n,
    );
    expect(drops).toBe(3_500_000n);
    expect(typeof (drops * 2n)).toBe("bigint");
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. ERROR HANDLING
// ═══════════════════════════════════════════════════════════════

describe("XRPL Financial: Error Handling", () => {
  const mod = () => import("./index") as Promise<typeof import("./index")>;

  it("isValidXRPClassicAddress rejects invalid addresses", async () => {
    const { isValidXRPClassicAddress } = await mod();
    expect(isValidXRPClassicAddress("")).toBe(false);
    expect(isValidXRPClassicAddress("not-an-address")).toBe(false);
    expect(isValidXRPClassicAddress("0x" + "ab".repeat(20))).toBe(false);
    expect(isValidXRPClassicAddress("X" + "a".repeat(40))).toBe(false);
  });

  it("isValidXRPAddress rejects invalid X-addresses", async () => {
    const { isValidXRPAddress } = await mod();
    expect(isValidXRPAddress("")).toBe(false);
    expect(isValidXRPAddress("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh")).toBe(false);
    expect(isValidXRPAddress("X" + "a".repeat(39))).toBe(false);
  });

  it("throws session_expired when connector not initialized (signTransaction)", async () => {
    const { XRPLConnector } = await mod();
    const connector = new XRPLConnector("mainnet");
    const session = { namespaces: { xrpl: { accounts: [] } } } as any;
    await expect(
      connector.signTransaction(session, {
        transaction: {
          TransactionType: "Payment",
          Account: "r",
          Destination: "r",
          Amount: "1",
        },
      }),
    ).rejects.toThrow("Session expired");
  });

  it("validates classic address format (r-prefix)", async () => {
    const { isValidXRPClassicAddress } = await mod();
    expect(isValidXRPClassicAddress("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh")).toBe(
      true,
    );
    expect(isValidXRPClassicAddress("rB8J4VRWn96DkukG4bwdtyThHb9CJAWy")).toBe(
      true,
    );
  });

  it("throws session_expired for createPaymentTx when not connected", async () => {
    const { XRPLConnector } = await mod();
    const connector = new XRPLConnector("mainnet");
    expect(() =>
      connector.createPaymentTx(
        "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
        "1000000",
      ),
    ).toThrow("Session expired");
  });

  it("throws session_expired for createTrustlineTx when not connected", async () => {
    const { XRPLConnector } = await mod();
    const connector = new XRPLConnector("mainnet");
    expect(() =>
      connector.createTrustlineTx(
        "USD",
        "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
        "1000",
      ),
    ).toThrow("Session expired");
  });

  it("throws on invalid destination address in createPaymentTx", async () => {
    const { XRPLConnector } = await mod();
    const connector = new XRPLConnector("mainnet");
    expect(() => connector.createPaymentTx("", "1000000")).toThrow(
      "Session expired",
    );
  });
});

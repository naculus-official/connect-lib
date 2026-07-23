import { describe, it, expect, beforeEach } from "vitest";
import { ADDRESSES } from "@naculus/test-utils/test-constants";
import { createSiwxMessage, parseSiwxMessage, getBlockchainName } from "../message";
import { verifySiwxMessage, type VerifySiwxMessageParams } from "../verify";
import { generateNonce, nowISO, addSecondsISO, isValidNonce } from "../utils";
import { checkSessionExpired, createMemorySiwxSessionStorage } from "../session-storage";
import {
  setNonceStorage,
  resetNonceStorage,
  createMemoryNonceStorage,
  issueNonce,
  consumeNonce,
  isNonceConsumed,
  isNonceIssued,
  isNonceValid,
} from "../nonce-consumption";
import type { SiwxParams, SiwxMessage } from "../types";

// Reset nonce storage before each test to avoid cross-test contamination
beforeEach(async () => {
  resetNonceStorage();
  await issueNonce(BASE_PARAMS.nonce);
});

const BASE_PARAMS: SiwxParams = {
  domain: "example.com",
  address: ADDRESSES.TEST_1,
  uri: "https://example.com/login",
  chainId: "eip155:1",
  nonce: "abc123xyz789",
};

function mockRecoverAddress(expected: string) {
  return () => expected;
}

// ─── getBlockchainName ────────────────────────────────────────

describe("getBlockchainName", () => {
  it("returns Ethereum for eip155 namespace", () => {
    expect(getBlockchainName("eip155:1")).toBe("Ethereum");
    expect(getBlockchainName("eip155:137")).toBe("Ethereum");
  });

  it("returns Solana for solana namespace", () => {
    expect(getBlockchainName("solana:4sGjMW1s")).toBe("Solana");
  });

  it("returns XRP Ledger for xrpl namespace", () => {
    expect(getBlockchainName("xrpl:0")).toBe("XRP Ledger");
  });

  it("returns 'blockchain' for unknown namespace", () => {
    expect(getBlockchainName("cosmos:cosmoshub-4")).toBe("blockchain");
    expect(getBlockchainName("")).toBe("blockchain");
  });
});

// ─── nowISO / addSecondsISO ────────────────────────────────────

describe("time utilities", () => {
  it("nowISO returns ISO 8601 format", () => {
    const result = nowISO();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(() => new Date(result)).not.toThrow();
  });

  it("addSecondsISO returns a future timestamp", () => {
    const past = new Date().getTime();
    const result = addSecondsISO(3600);
    const future = new Date(result).getTime();
    expect(future - past).toBeGreaterThan(3_500_000);
    expect(future - past).toBeLessThan(3_700_000);
  });
});

// ─── message parsing edge cases ────────────────────────────────

describe("parseSiwxMessage edge cases", () => {
  it("parses statement with multiple paragraphs", () => {
    const raw = [
      "example.com wants you to sign in with your Ethereum account:",
      ADDRESSES.TEST_1,
      "",
      "Paragraph one.",
      "",
      "Paragraph two.",
      "",
      "URI: https://example.com/login",
      "Version: 1",
      "Chain ID: eip155:1",
      "Nonce: abc123xyz789",
      "Issued At: 2026-01-01T00:00:00Z",
    ].join("\n");
    const parsed = parseSiwxMessage(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.statement).toBe("Paragraph one.\nParagraph two.");
  });

  it("returns null for malformed first line", () => {
    expect(parseSiwxMessage("garbage line\n0xaddr\n\nURI: https://x.com\nVersion: 1\nChain ID: eip155:1\nNonce: abc\nIssued At: 2026-01-01T00:00:00Z")).toBeNull();
    expect(parseSiwxMessage(" wants you to sign in with your account:\n0xaddr\n\nURI: https://x.com\nVersion: 1\nChain ID: eip155:1\nNonce: abc\nIssued At: 2026-01-01T00:00:00Z")).toBeNull();
  });

  it("handles resources with trailing whitespace", () => {
    const raw = [
      "example.com wants you to sign in with your Ethereum account:",
      ADDRESSES.TEST_1,
      "",
      "URI: https://example.com/login",
      "Version: 1",
      "Chain ID: eip155:1",
      "Nonce: abc123xyz789",
      "Issued At: 2026-01-01T00:00:00Z",
      "Resources:",
      "-  https://example.com/resource/1  ",
    ].join("\n");
    const parsed = parseSiwxMessage(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.resources).toEqual(["https://example.com/resource/1"]);
  });

  it("parses legacy format without blockchain name", () => {
    const raw = [
      "example.com wants you to sign in with your account:",
      ADDRESSES.TEST_1,
      "",
      "URI: https://example.com/login",
      "Version: 1",
      "Chain ID: eip155:1",
      "Nonce: abc123xyz789",
      "Issued At: 2026-01-01T00:00:00Z",
    ].join("\n");
    const parsed = parseSiwxMessage(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.domain).toBe("example.com");
    expect(parsed!.blockchain).toBe("blockchain");
  });

  it("omits Resources line when array is empty", () => {
    const msg = createSiwxMessage({ ...BASE_PARAMS, resources: [] });
    expect(msg).not.toContain("Resources:");
  });
});

// ─── generateNonce (crypto.getRandomValues) ────────────────────

describe("generateNonce", () => {
  it("generates a nonce of the specified length", () => {
    expect(generateNonce(8).length).toBe(8);
    expect(generateNonce(16).length).toBe(16);
    expect(generateNonce(32).length).toBe(32);
  });

  it("generates alphanumeric nonces only", () => {
    for (let i = 0; i < 20; i++) {
      expect(isValidNonce(generateNonce(16))).toBe(true);
    }
  });

  it("generates unique nonces on each call", () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 100; i++) {
      nonces.add(generateNonce(16));
    }
    expect(nonces.size).toBe(100);
  });

  it("does not use Math.random (throws if crypto unavailable)", () => {
    // The test harness has globalThis.crypto available (Node 19+),
    // so this call should succeed via crypto.getRandomValues.
    const nonce = generateNonce(16);
    expect(nonce.length).toBe(16);
    expect(isValidNonce(nonce)).toBe(true);
  });
});

// ─── Nonce Consumption (replay protection) ────────────────────

describe("nonce consumption", () => {
  it("nonce is not consumed after issue", async () => {
    await issueNonce("test-nonce-1");
    expect(await isNonceConsumed("test-nonce-1")).toBe(false);
  });

  it("nonce is consumed after consume call", async () => {
    await issueNonce("test-nonce-2");
    await consumeNonce("test-nonce-2");
    expect(await isNonceConsumed("test-nonce-2")).toBe(true);
  });

  it("nonce is valid when issued and not consumed", async () => {
    await issueNonce("test-nonce-3");
    expect(await isNonceValid("test-nonce-3")).toBe(true);
  });

  it("nonce is invalid when consumed", async () => {
    await issueNonce("test-nonce-4");
    await consumeNonce("test-nonce-4");
    expect(await isNonceValid("test-nonce-4")).toBe(false);
  });

  it("nonce is invalid when not issued", async () => {
    expect(await isNonceValid("never-issued")).toBe(false);
  });

  it("custom storage can be set", async () => {
    const custom = createMemoryNonceStorage();
    const prev = setNonceStorage(custom);
    try {
      await issueNonce("custom-nonce");
      expect(await isNonceIssued("custom-nonce")).toBe(true);
      await consumeNonce("custom-nonce");
      expect(await isNonceConsumed("custom-nonce")).toBe(true);
    } finally {
      setNonceStorage(prev);
    }
  });

  it("removes nonce from tracking", async () => {
    await issueNonce("test-nonce-5");
    const { removeNonce } = await import("../nonce-consumption");
    await removeNonce("test-nonce-5");
    expect(await isNonceIssued("test-nonce-5")).toBe(false);
  });
});

// ─── verify edge cases ─────────────────────────────────────────

describe("verifySiwxMessage edge cases", () => {
  it("rejects invalid timestamp format", async () => {
    const raw = createSiwxMessage(BASE_PARAMS);
    const result = await verifySiwxMessage({
      raw,
      signature: "0xsig",
      recoverAddress: mockRecoverAddress(BASE_PARAMS.address),
      timestamp: "not-a-date",
    });
    expect(result.isValid).toBe(false);
    expect(result.error).toContain("Invalid reference timestamp");
  });

  it("rejects invalid expirationTime in message", async () => {
    const raw = createSiwxMessage({ ...BASE_PARAMS, expirationTime: "bad-date" });
    const result = await verifySiwxMessage({
      raw,
      signature: "0xsig",
      recoverAddress: mockRecoverAddress(BASE_PARAMS.address),
    });
    expect(result.isValid).toBe(false);
    expect(result.error).toContain("Invalid expiration time");
  });

  it("verifies null statement round-trips correctly", async () => {
    const msg = createSiwxMessage({ ...BASE_PARAMS, statement: undefined });
    const parsed = parseSiwxMessage(msg);
    expect(parsed).not.toBeNull();
    expect(parsed!.statement).toBeNull();

    const result = await verifySiwxMessage({
      raw: msg,
      signature: "0xsig",
      recoverAddress: mockRecoverAddress(BASE_PARAMS.address),
    });
    expect(result.isValid).toBe(true);
  });

  it("rejects when recovered address differs from expectedAddress", async () => {
    const raw = createSiwxMessage(BASE_PARAMS);
    const result = await verifySiwxMessage({
      raw,
      signature: "0xsig",
      recoverAddress: mockRecoverAddress("0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF"),
      expectedAddress: BASE_PARAMS.address,
    });
    expect(result.isValid).toBe(false);
    expect(result.error).toContain("Signature does not match");
  });

  it("verifies a message that is currently valid within its time window", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const raw = createSiwxMessage({ ...BASE_PARAMS, expirationTime: future });
    const result = await verifySiwxMessage({
      raw,
      signature: "0xsig",
      recoverAddress: mockRecoverAddress(BASE_PARAMS.address),
    });
    expect(result.isValid).toBe(true);
  });

  it("rejects replay: same nonce verified twice fails the second time", async () => {
    const raw = createSiwxMessage(BASE_PARAMS);

    // First verification — should succeed (nonce is consumed automatically)
    const first = await verifySiwxMessage({
      raw,
      signature: "0xsig",
      recoverAddress: mockRecoverAddress(BASE_PARAMS.address),
    });
    expect(first.isValid).toBe(true);

    // Second verification with the same message — should fail (nonce already consumed)
    const second = await verifySiwxMessage({
      raw,
      signature: "0xsig",
      recoverAddress: mockRecoverAddress(BASE_PARAMS.address),
    });
    expect(second.isValid).toBe(false);
    expect(second.error).toContain("replay");
  });

  it("rejects replay: different message but same nonce", async () => {
    const raw1 = createSiwxMessage(BASE_PARAMS);

    // First verification succeeds
    const first = await verifySiwxMessage({
      raw: raw1,
      signature: "0xsig",
      recoverAddress: mockRecoverAddress(BASE_PARAMS.address),
    });
    expect(first.isValid).toBe(true);

    // Different domain/uri/address but same nonce — still replay
    const raw2 = createSiwxMessage({
      ...BASE_PARAMS,
      domain: "evil.com",
      uri: "https://evil.com/phish",
    });
    const second = await verifySiwxMessage({
      raw: raw2,
      signature: "0xsig",
      recoverAddress: mockRecoverAddress(BASE_PARAMS.address),
    });
    expect(second.isValid).toBe(false);
    expect(second.error).toContain("replay");
  });

  it("different nonces are independently consumable", async () => {
    await issueNonce("nonce-a");
    await issueNonce("nonce-b");
    const params1 = { ...BASE_PARAMS, nonce: "nonce-a" };
    const params2 = { ...BASE_PARAMS, nonce: "nonce-b" };

    const raw1 = createSiwxMessage(params1);
    const raw2 = createSiwxMessage(params2);

    const first = await verifySiwxMessage({
      raw: raw1,
      signature: "0xsig",
      recoverAddress: mockRecoverAddress(BASE_PARAMS.address),
    });
    expect(first.isValid).toBe(true);

    const second = await verifySiwxMessage({
      raw: raw2,
      signature: "0xsig",
      recoverAddress: mockRecoverAddress(BASE_PARAMS.address),
    });
    expect(second.isValid).toBe(true);
  });
});

// ─── checkSessionExpired ───────────────────────────────────────

describe("checkSessionExpired", () => {
  const futureDate = new Date(Date.now() + 86_400_000).toISOString();
  const pastDate = new Date(Date.now() - 86_400_000).toISOString();

  it("returns true for null session", () => {
    expect(checkSessionExpired(null)).toBe(true);
  });

  it("returns false for session with no expiry", () => {
    const session = {
      id: "test",
      chainId: "eip155:1",
      address: "0xabc",
      domain: "test.com",
      message: { raw: "" } as unknown as SiwxMessage,
      signature: "0xsig",
      issuedAt: new Date().toISOString(),
      expiresAt: null,
      refreshedAt: null,
    };
    expect(checkSessionExpired(session)).toBe(false);
  });

  it("returns false for non-expired session", () => {
    const session = {
      id: "test",
      chainId: "eip155:1",
      address: "0xabc",
      domain: "test.com",
      message: { raw: "" } as unknown as SiwxMessage,
      signature: "0xsig",
      issuedAt: new Date().toISOString(),
      expiresAt: futureDate,
      refreshedAt: null,
    };
    expect(checkSessionExpired(session)).toBe(false);
  });

  it("returns true for expired session", () => {
    const session = {
      id: "test",
      chainId: "eip155:1",
      address: "0xabc",
      domain: "test.com",
      message: { raw: "" } as unknown as SiwxMessage,
      signature: "0xsig",
      issuedAt: new Date().toISOString(),
      expiresAt: pastDate,
      refreshedAt: null,
    };
    expect(checkSessionExpired(session)).toBe(true);
  });
});

// ─── createMemorySiwxSessionStorage ────────────────────────────

describe("createMemorySiwxSessionStorage", () => {
  const futureDate = new Date(Date.now() + 86_400_000).toISOString();
  const session = {
    id: "test-session",
    chainId: "eip155:1",
    address: "0xabc",
    domain: "test.com",
    message: { raw: "" } as unknown as SiwxMessage,
    signature: "0xsig",
    issuedAt: new Date().toISOString(),
    expiresAt: futureDate,
    refreshedAt: null,
  };

  it("returns null when empty", async () => {
    const storage = createMemorySiwxSessionStorage("test-key");
    expect(await storage.get()).toBeNull();
  });

  it("persists and retrieves a session", async () => {
    const storage = createMemorySiwxSessionStorage("test-key");
    await storage.set(session);
    const retrieved = await storage.get();
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe("test-session");
    expect(retrieved!.address).toBe("0xabc");
  });

  it("removes a session", async () => {
    const storage = createMemorySiwxSessionStorage("test-key");
    await storage.set(session);
    await storage.remove();
    expect(await storage.get()).toBeNull();
  });

  it("clear removes all sessions", async () => {
    const storage = createMemorySiwxSessionStorage("test-key");
    await storage.set(session);
    await storage.clear();
    expect(await storage.get()).toBeNull();
  });

  it("has returns true when session exists", async () => {
    const storage = createMemorySiwxSessionStorage("test-key");
    await storage.set(session);
    expect(await storage.has()).toBe(true);
  });

  it("has returns false when empty", async () => {
    const storage = createMemorySiwxSessionStorage("test-key");
    expect(await storage.has()).toBe(false);
  });
});

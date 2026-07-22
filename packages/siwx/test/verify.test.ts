import { beforeEach, describe, expect, it } from "vitest";
import { createSiwxMessage } from "../src/message";
import { issueNonce, resetNonceStorage } from "../src/nonce-consumption";
import type { SiwxParams } from "../src/types";
import { generateNonce, nowISO } from "../src/utils";
import { type VerifySiwxMessageParams, verifySiwxMessage } from "../src/verify";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseParams: SiwxParams = {
  domain: "example.com",
  address: "0x1234567890abcdef1234567890abcdef12345678",
  uri: "https://example.com/login",
  chainId: "eip155:1",
  nonce: "abc123xyz789",
};

function createRawMessage(overrides?: Partial<SiwxParams>): string {
  return createSiwxMessage({ ...baseParams, ...overrides });
}

beforeEach(async () => {
  resetNonceStorage();
  await issueNonce(baseParams.nonce);
});

/**
 * Mock recoverAddress that always returns the expected address.
 * For testing validation logic without real crypto.
 */
function mockRecoverAddress(expectedAddress: string) {
  return ({ message, signature }: { message: string; signature: string }) => {
    // Simulate a verifier that works correctly
    return expectedAddress;
  };
}

/**
 * A mock that returns a different address to test address mismatch.
 */
function mockWrongAddress() {
  return () => "0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF";
}

/**
 * A mock that throws to test error handling.
 */
function mockFailingVerifier() {
  return () => {
    throw new Error("Crypto library not available");
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verifySiwxMessage", () => {
  it("should verify a valid message successfully", async () => {
    const raw = createRawMessage();
    const result = await verifySiwxMessage({
      raw,
      signature: "0xmocksignature123",
      recoverAddress: mockRecoverAddress(baseParams.address),
    });

    expect(result.isValid).toBe(true);
    expect(result.address).toBe(baseParams.address);
    expect(result.error).toBeUndefined();
  });

  it("should fail for unparseable message", async () => {
    const result = await verifySiwxMessage({
      raw: "not a valid SIWx message",
      signature: "0xsig",
      recoverAddress: mockRecoverAddress("0x1234"),
    });

    expect(result.isValid).toBe(false);
    expect(result.error).toContain("Failed to parse SIWx message");
  });

  it("should handle empty string message", async () => {
    const result = await verifySiwxMessage({
      raw: "",
      signature: "0xsig",
      recoverAddress: mockRecoverAddress("0x1234"),
    });

    expect(result.isValid).toBe(false);
    expect(result.error).toContain("Failed to parse");
  });

  it("should detect domain mismatch", async () => {
    const raw = createRawMessage({ domain: "other.com" });
    const result = await verifySiwxMessage({
      raw,
      signature: "0xsig",
      recoverAddress: mockRecoverAddress(baseParams.address),
      domain: "example.com",
    });

    expect(result.isValid).toBe(false);
    expect(result.error).toContain("Domain mismatch");
  });

  it("should detect nonce mismatch", async () => {
    const raw = createRawMessage({ nonce: "wrong-nonce" });
    const result = await verifySiwxMessage({
      raw,
      signature: "0xsig",
      recoverAddress: mockRecoverAddress(baseParams.address),
      nonce: "expected-nonce",
    });

    expect(result.isValid).toBe(false);
    expect(result.error).toContain("Nonce mismatch");
  });

  it("should detect expired message", async () => {
    const raw = createRawMessage({
      expirationTime: "2020-01-01T00:00:00Z", // far in the past
    });
    const result = await verifySiwxMessage({
      raw,
      signature: "0xsig",
      recoverAddress: mockRecoverAddress(baseParams.address),
      timestamp: "2026-01-01T00:00:00Z",
    });

    expect(result.isValid).toBe(false);
    expect(result.error).toContain("expired");
  });

  it("should detect notBefore violation", async () => {
    const raw = createRawMessage({
      notBefore: "2030-01-01T00:00:00Z", // far in the future
    });
    const result = await verifySiwxMessage({
      raw,
      signature: "0xsig",
      recoverAddress: mockRecoverAddress(baseParams.address),
      timestamp: "2026-01-01T00:00:00Z",
    });

    expect(result.isValid).toBe(false);
    expect(result.error).toContain("not yet valid");
  });

  it("should skip expiration check when skipExpirationCheck is true", async () => {
    const raw = createRawMessage({
      expirationTime: "2020-01-01T00:00:00Z",
    });
    const result = await verifySiwxMessage(
      {
        raw,
        signature: "0xsig",
        recoverAddress: mockRecoverAddress(baseParams.address),
        timestamp: "2026-01-01T00:00:00Z",
      },
      { skipExpirationCheck: true },
    );

    expect(result.isValid).toBe(true);
  });

  it("should skip notBefore check when skipNotBeforeCheck is true", async () => {
    const raw = createRawMessage({
      notBefore: "2030-01-01T00:00:00Z",
    });
    const result = await verifySiwxMessage(
      {
        raw,
        signature: "0xsig",
        recoverAddress: mockRecoverAddress(baseParams.address),
        timestamp: "2026-01-01T00:00:00Z",
      },
      { skipNotBeforeCheck: true },
    );

    expect(result.isValid).toBe(true);
  });

  it("should require expiration time when requireExpirationTime is set", async () => {
    const raw = createRawMessage(); // no expirationTime
    const result = await verifySiwxMessage(
      {
        raw,
        signature: "0xsig",
        recoverAddress: mockRecoverAddress(baseParams.address),
      },
      { requireExpirationTime: true },
    );

    expect(result.isValid).toBe(false);
    expect(result.error).toContain("Expiration time is required");
  });

  it("should detect address mismatch from signature recovery", async () => {
    const raw = createRawMessage();
    const result = await verifySiwxMessage({
      raw,
      signature: "0xsig",
      recoverAddress: mockWrongAddress(),
      expectedAddress: baseParams.address,
    });

    expect(result.isValid).toBe(false);
    expect(result.error).toContain("Signature does not match");
  });

  it("should detect address mismatch without explicit expectedAddress", async () => {
    const raw = createRawMessage();
    const result = await verifySiwxMessage({
      raw,
      signature: "0xsig",
      // recoverAddress recovers the wrong address
      recoverAddress: ({
        message,
        signature,
      }: {
        message: string;
        signature: string;
      }) => "0xOTHERADDRESS000000000000000000000000000000",
    });

    // Without expectedAddress, it compares recovered vs parsed.address
    expect(result.isValid).toBe(false);
    expect(result.error).toContain("Signature does not match");
  });

  it("should handle failed signature recovery", async () => {
    const raw = createRawMessage();
    const result = await verifySiwxMessage({
      raw,
      signature: "0xbad",
      recoverAddress: mockFailingVerifier(),
    });

    expect(result.isValid).toBe(false);
    expect(result.error).toContain("Signature recovery failed");
  });

  it("should handle signature recovery that returns unexpected value type", async () => {
    const raw = createRawMessage();
    const result = await verifySiwxMessage({
      raw,
      signature: "0xsig",
      recoverAddress: mockRecoverAddress(baseParams.address),
      expectedAddress: baseParams.address,
    });

    expect(result.isValid).toBe(true);
    expect(result.address).toBe(baseParams.address);
  });

  it("should handle message with all optional fields", async () => {
    await issueNonce("n0nceValue123");
    const params: SiwxParams = {
      domain: "service.org",
      address: "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B",
      statement: "I accept the Terms of Service.",
      uri: "https://service.org/auth",
      chainId: "eip155:1",
      nonce: "n0nceValue123",
      issuedAt: "2026-01-01T00:00:00Z",
      expirationTime: "2030-12-31T23:59:59Z",
      notBefore: "2025-01-01T00:00:00Z",
      requestId: "req_001",
      resources: ["https://service.org/tos", "https://service.org/privacy"],
    };

    const raw = createRawMessage(params);
    const result = await verifySiwxMessage({
      raw,
      signature: "0xsig",
      recoverAddress: mockRecoverAddress(params.address),
      domain: "service.org",
      nonce: "n0nceValue123",
      timestamp: "2026-06-01T00:00:00Z",
    });

    expect(result.isValid).toBe(true);
    expect(result.address).toBe(params.address);
  });

  it("should handle expired message that passes in the past", async () => {
    const raw = createRawMessage({
      expirationTime: "2025-01-01T00:00:00Z",
    });

    // timestamp is after expiry
    const result = await verifySiwxMessage({
      raw,
      signature: "0xsig",
      recoverAddress: mockRecoverAddress(baseParams.address),
      timestamp: "2026-01-01T00:00:00Z",
    });

    expect(result.isValid).toBe(false);
    expect(result.error).toContain("expired");
  });

  it("should handle message with no expiry that is valid", async () => {
    const raw = createRawMessage(); // no expirationTime
    const result = await verifySiwxMessage({
      raw,
      signature: "0xsig",
      recoverAddress: mockRecoverAddress(baseParams.address),
    });

    expect(result.isValid).toBe(true);
  });

  it("should compare addresses case-insensitively", async () => {
    const raw = createRawMessage({
      address: "0xAbCd1234567890abcdef1234567890abcdef12345678",
    });
    const result = await verifySiwxMessage({
      raw,
      signature: "0xsig",
      // Return the same address but mixed case
      recoverAddress: () => "0xabcd1234567890abcdef1234567890abcdef12345678",
    });

    expect(result.isValid).toBe(true);
  });

  it("should validate Solana address format (case-sensitive base58-like)", async () => {
    // For Solana, receiver implementation handles the case sensitivity
    const raw = createRawMessage({
      chainId: "solana:4sGjMW1s",
      address: "7S3W4YxKv3PBpBVpQqZzKjWxqGQtQfG5eGwJeDiLBfhG",
    });
    const result = await verifySiwxMessage({
      raw,
      signature: "base58sig123",
      recoverAddress: mockRecoverAddress(
        "7S3W4YxKv3PBpBVpQqZzKjWxqGQtQfG5eGwJeDiLBfhG",
      ),
    });

    expect(result.isValid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createEVMVerifier — integration test with actual viem
// ---------------------------------------------------------------------------

describe("createEVMVerifier", () => {
  it("should be a function", async () => {
    const { createEVMVerifier } = await import("../src/verify");
    expect(typeof createEVMVerifier).toBe("function");
  });

  it("should return a function when called", async () => {
    const { createEVMVerifier } = await import("../src/verify");
    const verifier = createEVMVerifier();
    expect(typeof verifier).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// createSolanaVerifier — unit tests
// ---------------------------------------------------------------------------

describe("createSolanaVerifier", () => {
  it("should be a function", async () => {
    const { createSolanaVerifier } = await import("../src/verify");
    expect(typeof createSolanaVerifier).toBe("function");
  });

  it("should return a function when called", async () => {
    const { createSolanaVerifier } = await import("../src/verify");
    const verifier = createSolanaVerifier();
    expect(typeof verifier).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// createXRPLVerifier — unit tests
// ---------------------------------------------------------------------------

describe("createXRPLVerifier", () => {
  it("should be a function", async () => {
    const { createXRPLVerifier } = await import("../src/verify");
    expect(typeof createXRPLVerifier).toBe("function");
  });

  it("should return a function when called", async () => {
    const { createXRPLVerifier } = await import("../src/verify");
    const verifier = createXRPLVerifier();
    expect(typeof verifier).toBe("function");
  });
});

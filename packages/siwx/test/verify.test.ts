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
      domain: "example.com",
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
      domain: "example.com",
      recoverAddress: mockRecoverAddress("0x1234"),
    });

    expect(result.isValid).toBe(false);
    expect(result.error).toContain("Failed to parse SIWx message");
  });

  it("should handle empty string message", async () => {
    const result = await verifySiwxMessage({
      raw: "",
      signature: "0xsig",
      domain: "example.com",
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
    const raw = createRawMessage({ nonce: "wrongNonce" });
    const result = await verifySiwxMessage({
      raw,
      signature: "0xsig",
      domain: "example.com",
      recoverAddress: mockRecoverAddress(baseParams.address),
      nonce: "expectedNonce",
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
      domain: "example.com",
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
      domain: "example.com",
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
        domain: "example.com",
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
        domain: "example.com",
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
        domain: "example.com",
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
      domain: "example.com",
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
      domain: "example.com",
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
      domain: "example.com",
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
      domain: "example.com",
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
      domain: "example.com",
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
      domain: "example.com",
      recoverAddress: mockRecoverAddress(baseParams.address),
    });

    expect(result.isValid).toBe(true);
  });

  it("should compare addresses case-insensitively", async () => {
    const raw = createRawMessage({
      address: "0xAbCd1234567890abcdef1234567890abcdef1234",
    });
    const result = await verifySiwxMessage({
      raw,
      signature: "0xsig",
      // Return the same address but mixed case
      domain: "example.com",
      recoverAddress: () => "0xabcd1234567890abcdef1234567890abcdef1234",
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
      domain: "example.com",
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
// createSolanaVerifier — the returned closure, against real tweetnacl + bs58
//
// The tests above only assert that the factory and its closure are functions,
// so nothing here ever loaded bs58 or tweetnacl. These do: every vector below
// was produced with the installed packages from the fixed ed25519 seed
// Uint8Array[1..32] (and [255..224] for the second key), so they are
// reproducible rather than copied from somewhere.
// ---------------------------------------------------------------------------

const SOL = {
  message: "naculus.example wants you to sign in with your Solana account",
  publicKey: "9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj",
  signature:
    "4bQhyiVVns6LPhsB9G4AyPG7mmj9T5YMichfurRvsN5Ar6EgTcdb4VGVkK5gx2qLEkcECV6WGVudyQhPAQHgdV4Z",
  /** SOL.signature with the first byte flipped. */
  tamperedSignature:
    "4aFT4iR9RUCBGeSQgAxD3MMknW1KqaaytdY1F3rKbs9SbBbeGRrvyTDqaoAyZtDPucRBDSuCZEEDY9y5Vm45UPf3",
  /** A different key pair's public key. */
  otherPublicKey: "Dav6Vxmr7BEgvQW4osrzWutwgPEqQ4Ji3zWxKp6nX9AD",
  /** Valid base58, but 10 bytes — neither a signature (64) nor a key (32). */
  tenBytesA: "PuA8sodkHm3qY",
  tenBytesB: "WSdbz2xXoQVWG",
};

/**
 * The regression this suite exists for: every failure below used to be
 * rewritten as "install tweetnacl and bs58", which was never the cause.
 */
const DEPENDENCY_WORDING = /dependenc|install|pnpm add|npm install/i;

describe("createSolanaVerifier — verification behavior", () => {
  it("loads bs58 and tweetnacl as real modules", async () => {
    const bs58 = (await import("bs58")).default;
    const nacl = (await import("tweetnacl")).default;
    expect(typeof bs58.decode).toBe("function");
    expect(typeof nacl.sign.detached.verify).toBe("function");
  });

  it("returns true for a valid signature", async () => {
    const { createSolanaVerifier } = await import("../src/verify");
    const verifier = createSolanaVerifier();
    await expect(
      verifier({
        message: SOL.message,
        signature: SOL.signature,
        publicKey: SOL.publicKey,
      }),
    ).resolves.toBe(true);
  });

  it("returns false for a tampered signature", async () => {
    const { createSolanaVerifier } = await import("../src/verify");
    const verifier = createSolanaVerifier();
    await expect(
      verifier({
        message: SOL.message,
        signature: SOL.tamperedSignature,
        publicKey: SOL.publicKey,
      }),
    ).resolves.toBe(false);
  });

  it("returns false when the message does not match the signature", async () => {
    const { createSolanaVerifier } = await import("../src/verify");
    const verifier = createSolanaVerifier();
    await expect(
      verifier({
        message: SOL.message + "!",
        signature: SOL.signature,
        publicKey: SOL.publicKey,
      }),
    ).resolves.toBe(false);
  });

  it("returns false for a different public key", async () => {
    const { createSolanaVerifier } = await import("../src/verify");
    const verifier = createSolanaVerifier();
    await expect(
      verifier({
        message: SOL.message,
        signature: SOL.signature,
        publicKey: SOL.otherPublicKey,
      }),
    ).resolves.toBe(false);
  });
});

describe("createSolanaVerifier — malformed input is not a dependency problem", () => {
  const cases: Array<{
    name: string;
    params: { message: string; signature: string; publicKey: string };
    expected: RegExp;
  }> = [
    {
      name: "signature is not base58",
      params: {
        message: SOL.message,
        signature: "0OIl",
        publicKey: SOL.publicKey,
      },
      expected: /Non-base58 character/,
    },
    {
      name: "public key is not base58",
      params: {
        message: SOL.message,
        signature: SOL.signature,
        publicKey: "abc!",
      },
      expected: /Non-base58 character/,
    },
    {
      name: "signature decodes to the wrong length",
      params: {
        message: SOL.message,
        signature: SOL.tenBytesA,
        publicKey: SOL.publicKey,
      },
      expected: /bad signature size/,
    },
    {
      name: "public key decodes to the wrong length",
      params: {
        message: SOL.message,
        signature: SOL.signature,
        publicKey: SOL.tenBytesB,
      },
      expected: /bad public key size/,
    },
  ];

  for (const { name, params, expected } of cases) {
    it(`surfaces the original error when the ${name}`, async () => {
      const { createSolanaVerifier } = await import("../src/verify");
      const verifier = createSolanaVerifier();

      await expect(verifier(params)).rejects.toThrow(expected);
      await expect(verifier(params)).rejects.not.toThrow(DEPENDENCY_WORDING);
    });
  }
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

  /**
   * The two tests above assert that a function is a function. Everything this
   * verifier actually does — hex-encoding the message, checking the signature
   * against the public key, and deriving the account address from the key that
   * verified — went untested, in a file the review rules call an always-review
   * area. These exercise it against a real keypair, which also makes them the
   * acceptance gate for any `ripple-keypairs` upgrade: the library's `verify`
   * and `deriveAddress` are the two calls the verifier depends on.
   */
  it("verifies a real signature and returns the address that signed", async () => {
    const keypairs = await import("ripple-keypairs");
    const { createXRPLVerifier } = await import("../src/verify");

    const { publicKey, privateKey } = keypairs.deriveKeypair(
      keypairs.generateSeed(),
    );
    const message = "naculus.example wants you to sign in with your XRPL account";
    const messageHex = Buffer.from(message, "utf8").toString("hex").toUpperCase();
    const signature = keypairs.sign(messageHex, privateKey);

    const verified = await createXRPLVerifier()({ message, signature, publicKey });

    // Not just truthy: the verifier's contract is to return the address
    // derived from the key that verified, so the caller can compare it with
    // the identity the SIWx message claims.
    expect(verified).toBe(keypairs.deriveAddress(publicKey));
  });

  it("rejects a signature made over a different message", async () => {
    const keypairs = await import("ripple-keypairs");
    const { createXRPLVerifier } = await import("../src/verify");

    const { publicKey, privateKey } = keypairs.deriveKeypair(
      keypairs.generateSeed(),
    );
    const signedHex = Buffer.from("the message that was signed", "utf8")
      .toString("hex")
      .toUpperCase();
    const signature = keypairs.sign(signedHex, privateKey);

    const verified = await createXRPLVerifier()({
      message: "a different message entirely",
      signature,
      publicKey,
    });

    expect(verified).toBe(false);
  });

  it("refuses to verify without a public key rather than passing", async () => {
    const { createXRPLVerifier } = await import("../src/verify");
    await expect(
      createXRPLVerifier()({ message: "hello", signature: "00" }),
    ).rejects.toThrow(/publicKey is required/);
  });
});

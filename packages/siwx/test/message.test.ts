import { describe, expect, it } from "vitest";
import {
  createSiwxMessage,
  isSiwxMessage,
  parseSiwxMessage,
  SIWX_VERSION,
} from "../src/message";
import type { SiwxParams } from "../src/types";
import {
  generateNonce,
  isValidDomain,
  isValidNonce,
  parseChainId,
} from "../src/utils";

describe("createSiwxMessage", () => {
  const baseParams: SiwxParams = {
    domain: "example.com",
    address: "0x1234567890abcdef1234567890abcdef12345678",
    uri: "https://example.com/login",
    chainId: "eip155:1",
    nonce: "abc123xyz789",
  };

  it("should create a basic SIWx message", () => {
    const msg = createSiwxMessage(baseParams);
    expect(msg).toContain(
      "example.com wants you to sign in with your Ethereum account:",
    );
    expect(msg).toContain(baseParams.address);
    expect(msg).toContain("URI: https://example.com/login");
    expect(msg).toContain("Version: 1");
    expect(msg).toContain("Chain ID: eip155:1");
    expect(msg).toContain("Nonce: abc123xyz789");
    expect(msg).toContain("Issued At:");
  });

  it("should include statement when provided", () => {
    const params = {
      ...baseParams,
      statement: "Sign in to access your dashboard.",
    };
    const msg = createSiwxMessage(params);
    expect(msg).toContain("Sign in to access your dashboard.");
  });

  it("should include expiration time when provided", () => {
    const params = { ...baseParams, expirationTime: "2026-12-31T23:59:59Z" };
    const msg = createSiwxMessage(params);
    expect(msg).toContain("Expiration Time: 2026-12-31T23:59:59Z");
  });

  it("should include notBefore when provided", () => {
    const params = { ...baseParams, notBefore: "2026-01-01T00:00:00Z" };
    const msg = createSiwxMessage(params);
    expect(msg).toContain("Not Before: 2026-01-01T00:00:00Z");
  });

  it("should include request ID when provided", () => {
    const params = { ...baseParams, requestId: "req_abc123" };
    const msg = createSiwxMessage(params);
    expect(msg).toContain("Request ID: req_abc123");
  });

  it("should include resources when provided", () => {
    const params = {
      ...baseParams,
      resources: ["https://example.com/api/1", "https://example.com/api/2"],
    };
    const msg = createSiwxMessage(params);
    expect(msg).toContain("Resources:");
    expect(msg).toContain("- https://example.com/api/1");
    expect(msg).toContain("- https://example.com/api/2");
  });

  it("should produce a complete CAIP-122 compliant message", () => {
    const params: SiwxParams = {
      domain: "service.org",
      address: "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B",
      statement: "I accept the Terms of Service.",
      uri: "https://service.org/auth",
      version: 1,
      chainId: "eip155:1",
      nonce: "n-0S6_WzA2Mj",
      issuedAt: "2026-01-01T00:00:00Z",
      expirationTime: "2026-12-31T23:59:59Z",
      notBefore: "2026-01-01T00:00:00Z",
      requestId: "req_001",
      resources: ["https://service.org/tos", "https://service.org/privacy"],
    };

    const msg = createSiwxMessage(params);
    expect(msg).toMatchSnapshot();
  });
});

describe("parseSiwxMessage", () => {
  it("should parse a basic message", () => {
    const raw = [
      "example.com wants you to sign in with your Ethereum account:",
      "0x1234567890abcdef1234567890abcdef12345678",
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
    expect(parsed!.address).toBe("0x1234567890abcdef1234567890abcdef12345678");
    expect(parsed!.uri).toBe("https://example.com/login");
    expect(parsed!.version).toBe(1);
    expect(parsed!.chainId).toBe("eip155:1");
    expect(parsed!.nonce).toBe("abc123xyz789");
    expect(parsed!.issuedAt).toBe("2026-01-01T00:00:00Z");
    expect(parsed!.statement).toBeNull();
    expect(parsed!.resources).toEqual([]);
  });

  it("should parse a message with statement", () => {
    const raw = [
      "example.com wants you to sign in with your Ethereum account:",
      "0x1234567890abcdef1234567890abcdef12345678",
      "",
      "Sign in to access your dashboard.",
      "",
      "URI: https://example.com/login",
      "Version: 1",
      "Chain ID: eip155:1",
      "Nonce: abc123xyz789",
      "Issued At: 2026-01-01T00:00:00Z",
    ].join("\n");

    const parsed = parseSiwxMessage(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.statement).toBe("Sign in to access your dashboard.");
  });

  it("should parse a message with all optional fields", () => {
    const raw = [
      "service.org wants you to sign in with your Ethereum account:",
      "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B",
      "",
      "I accept the Terms of Service.",
      "",
      "URI: https://service.org/auth",
      "Version: 1",
      "Chain ID: eip155:1",
      "Nonce: n-0S6_WzA2Mj",
      "Issued At: 2026-01-01T00:00:00Z",
      "Expiration Time: 2026-12-31T23:59:59Z",
      "Not Before: 2026-01-01T00:00:00Z",
      "Request ID: req_001",
      "Resources:",
      "- https://service.org/tos",
      "- https://service.org/privacy",
    ].join("\n");

    const parsed = parseSiwxMessage(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.domain).toBe("service.org");
    expect(parsed!.address).toBe("0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B");
    expect(parsed!.statement).toBe("I accept the Terms of Service.");
    expect(parsed!.uri).toBe("https://service.org/auth");
    expect(parsed!.version).toBe(1);
    expect(parsed!.chainId).toBe("eip155:1");
    expect(parsed!.nonce).toBe("n-0S6_WzA2Mj");
    expect(parsed!.issuedAt).toBe("2026-01-01T00:00:00Z");
    expect(parsed!.expirationTime).toBe("2026-12-31T23:59:59Z");
    expect(parsed!.notBefore).toBe("2026-01-01T00:00:00Z");
    expect(parsed!.requestId).toBe("req_001");
    expect(parsed!.resources).toEqual([
      "https://service.org/tos",
      "https://service.org/privacy",
    ]);
  });

  it("should return null for invalid message format", () => {
    expect(parseSiwxMessage("")).toBeNull();
    expect(parseSiwxMessage("not a SIWx message")).toBeNull();
    expect(parseSiwxMessage("no newlines here")).toBeNull();
  });

  it("should return null for missing required fields", () => {
    const raw = [
      "example.com wants you to sign in with your Ethereum account:",
      "0x1234567890abcdef1234567890abcdef12345678",
    ].join("\n");
    expect(parseSiwxMessage(raw)).toBeNull();
  });

  it("should round-trip a message", () => {
    const params: SiwxParams = {
      domain: "example.com",
      address: "0x1234567890abcdef1234567890abcdef12345678",
      statement: "Sign in to continue.",
      uri: "https://example.com/login",
      chainId: "solana:4sGjMW1s",
      nonce: "r4nD0mN0nc3!",
      resources: ["https://example.com/resource"],
    };

    const raw = createSiwxMessage(params);
    const parsed = parseSiwxMessage(raw);

    expect(parsed).not.toBeNull();
    expect(parsed!.domain).toBe(params.domain);
    expect(parsed!.address).toBe(params.address);
    expect(parsed!.statement).toBe(params.statement);
    expect(parsed!.uri).toBe(params.uri);
    expect(parsed!.chainId).toBe(params.chainId);
    expect(parsed!.nonce).toBe(params.nonce);
    expect(parsed!.resources).toEqual(params.resources);
  });
});

describe("isSiwxMessage", () => {
  it("should return true for a valid SiwxMessage object", () => {
    const msg = {
      raw: "raw message",
      domain: "example.com",
      address: "0x1234",
      statement: null,
      uri: "https://example.com",
      version: 1,
      chainId: "eip155:1",
      nonce: "abc123",
      issuedAt: null,
      expirationTime: null,
      notBefore: null,
      resources: [],
      requestId: null,
      blockchain: "Ethereum",
    };
    expect(isSiwxMessage(msg)).toBe(true);
  });

  it("should return false for null", () => {
    expect(isSiwxMessage(null)).toBe(false);
  });

  it("should return false for non-objects", () => {
    expect(isSiwxMessage("string")).toBe(false);
    expect(isSiwxMessage(42)).toBe(false);
  });

  it("should return false for missing required fields", () => {
    expect(isSiwxMessage({ raw: "raw" })).toBe(false);
  });
});

describe("generateNonce", () => {
  it("should generate a nonce of the correct length", () => {
    const nonce = generateNonce();
    expect(nonce.length).toBe(16);
  });

  it("should generate a nonce of custom length", () => {
    const nonce = generateNonce(32);
    expect(nonce.length).toBe(32);
  });

  it("should generate alphanumeric characters only", () => {
    const nonce = generateNonce(100);
    expect(/^[A-Za-z0-9]+$/.test(nonce)).toBe(true);
  });

  it("should generate different nonces each call", () => {
    const nonce1 = generateNonce();
    const nonce2 = generateNonce();
    expect(nonce1).not.toBe(nonce2);
  });
});

describe("parseChainId", () => {
  it("should parse eip155:1", () => {
    const result = parseChainId("eip155:1");
    expect(result.namespace).toBe("eip155");
    expect(result.reference).toBe("1");
  });

  it("should parse solana mainnet", () => {
    const result = parseChainId("solana:4sGjMW1s");
    expect(result.namespace).toBe("solana");
    expect(result.reference).toBe("4sGjMW1s");
  });

  it("should parse xrpl:0", () => {
    const result = parseChainId("xrpl:0");
    expect(result.namespace).toBe("xrpl");
    expect(result.reference).toBe("0");
  });

  it("should throw for invalid chain ID", () => {
    expect(() => parseChainId("invalid")).toThrow("Invalid CAIP-2 chain ID");
    expect(() => parseChainId("")).toThrow("Invalid CAIP-2 chain ID");
  });
});

describe("isValidNonce", () => {
  it("should accept alphanumeric nonces", () => {
    expect(isValidNonce("abc123")).toBe(true);
    expect(isValidNonce("ABC123xyz")).toBe(true);
  });

  it("should reject nonces with special characters", () => {
    expect(isValidNonce("abc-123")).toBe(false);
    expect(isValidNonce("abc 123")).toBe(false);
    expect(isValidNonce("")).toBe(false);
  });
});

describe("isValidDomain", () => {
  it("should accept valid domains", () => {
    expect(isValidDomain("example.com")).toBe(true);
    expect(isValidDomain("localhost")).toBe(true);
    expect(isValidDomain("app.example.com")).toBe(true);
    expect(isValidDomain("example.com:3000")).toBe(true);
  });

  it("should reject invalid domains", () => {
    expect(isValidDomain("")).toBe(false);
    expect(isValidDomain("http://example.com")).toBe(false);
  });
});

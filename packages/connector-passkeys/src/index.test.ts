/// <reference types="vitest" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPasskeysConnector } from "./index";

// ── localStorage polyfill for Node 26 ────────────────────────────

if (typeof globalThis.localStorage === "undefined") {
  const store: Record<string, string> = {};
  const lsMock = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      Object.keys(store).forEach((k) => delete store[k]);
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: new Proxy(lsMock, {
      ownKeys: () => Object.keys(store),
      getOwnPropertyDescriptor: () => ({
        configurable: true,
        enumerable: true,
      }),
    }),
    writable: true,
    configurable: true,
  });
}

// WebAuthn mock
const mockCredentialId = "test-credential-id-12345";

function createMockPublicKeyCredential(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: mockCredentialId,
    rawId: new Uint8Array([1, 2, 3, 4, 5]),
    type: "public-key",
    response: {
      getPublicKey: () => new Uint8Array(32).fill(0x42).buffer,
      publicKey: new Uint8Array(32).fill(0x42).buffer,
      clientDataJSON: new Uint8Array(0),
      attestationObject: new Uint8Array(0),
      signature: new Uint8Array(64).fill(0x41),
      authenticatorData: new Uint8Array(0),
      userHandle: null,
    },
    ...overrides,
  } as unknown as PublicKeyCredential;
}

function createMockAssertion(overrides: Record<string, unknown> = {}) {
  return {
    id: mockCredentialId,
    rawId: new Uint8Array([1, 2, 3, 4, 5]),
    type: "public-key",
    response: {
      authenticatorData: new Uint8Array(0),
      clientDataJSON: new Uint8Array(0),
      signature: new Uint8Array(64).fill(0x41),
      userHandle: null,
      ...overrides,
    },
  } as unknown as PublicKeyCredential;
}

describe("PasskeysConnector", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("has correct identity", () => {
    const connector = createPasskeysConnector();
    expect(connector.id).toBe("passkeys");
    expect(connector.name).toBe("Passkeys");
    expect(connector.kind).toBe("passkeys");
    expect(connector.namespaces).toEqual(["eip155"]);
  });

  it("returns no credential initially", () => {
    const connector = createPasskeysConnector();
    expect(connector.hasCredential()).toBe(false);
    expect(connector.getAddress()).toBeNull();
  });

  it("does not connect when navigator.credentials is missing", async () => {
    const connector = createPasskeysConnector();
    await expect(connector.connect()).rejects.toThrow("WebAuthn not available");
  });

  it("creates a passkey and derives an address", async () => {
    (navigator as any).credentials = {
      create: vi.fn().mockResolvedValue(createMockPublicKeyCredential()),
      get: vi.fn(),
    };

    const connector = createPasskeysConnector();
    const session = await connector.connect();

    expect(session.walletType).toBe("passkeys");
    expect(session.walletId).toBe("passkeys");
    expect(session.namespaces.eip155).toBeDefined();
    expect(session.namespaces.eip155.accounts.length).toBe(1);
    expect(session.namespaces.eip155.accounts[0]).toContain("eip155:1:0x");
    expect(connector.hasCredential()).toBe(true);
    expect(connector.getAddress()).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("reuses existing passkey credential on reconnect", async () => {
    (navigator as any).credentials = {
      create: vi.fn().mockResolvedValue(createMockPublicKeyCredential()),
      get: vi.fn(),
    };

    const connector = createPasskeysConnector();
    const session1 = await connector.connect();
    const address1 = connector.getAddress();

    // Simulate a new connector instance with same storage
    const connector2 = createPasskeysConnector();
    const address2 = connector2.getAddress();

    // Should reload from localStorage
    expect(address2).toBe(address1);

    const session2 = await connector2.reconnect(session1);
    expect(session2.walletId).toBe("passkeys");
  });

  it("disconnects clears saved credential", async () => {
    (navigator as any).credentials = {
      create: vi.fn().mockResolvedValue(createMockPublicKeyCredential()),
      get: vi.fn(),
    };

    const connector = createPasskeysConnector();
    const session = await connector.connect();
    expect(connector.hasCredential()).toBe(true);

    await connector.disconnect(session);
    expect(connector.hasCredential()).toBe(false);
    expect(connector.getAddress()).toBeNull();
  });

  it("signs a message via WebAuthn authentication", async () => {
    (navigator as any).credentials = {
      create: vi.fn().mockResolvedValue(createMockPublicKeyCredential()),
      get: vi.fn().mockResolvedValue(createMockAssertion()),
    };

    const connector = createPasskeysConnector();
    const session = await connector.connect();

    const sig = await connector.signMessage(session, {
      message: "Hello Passkeys!",
    });
    expect(sig).toBeDefined();
    expect(sig).toContain("0x");
  });

  it("signMessage throws when no message provided", async () => {
    (navigator as any).credentials = {
      create: vi.fn().mockResolvedValue(createMockPublicKeyCredential()),
      get: vi.fn(),
    };

    const connector = createPasskeysConnector();
    const session = await connector.connect();

    await expect(connector.signMessage(session, {})).rejects.toThrow(
      "Message is required",
    );
  });

  it("throws for unsupported methods", async () => {
    const connector = createPasskeysConnector();
    const session = await connector.connect().catch(() => null);
    if (!session) return;

    await expect(connector.signTransaction(session, {})).rejects.toThrow(
      "not supported",
    );
    await expect(connector.sendTransaction(session, {})).rejects.toThrow(
      "not supported",
    );
    await expect(connector.sendCalls(session, [])).rejects.toThrow(
      "not supported",
    );
  });
});

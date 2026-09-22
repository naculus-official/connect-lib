import type { SessionChange } from "@naculus/connect-core";
import type { SignClientTypes } from "@walletconnect/types";
import { createEmptySession } from "@naculus/connect-core";
import { describe, expect, it, vi } from "vitest";
import { WalletConnectConnector } from "./index";
import { REQUIRED_EVM_EVENTS, REQUIRED_EVM_METHODS } from "./namespaces";

/**
 * The relay's session events reach SessionManager through
 * onSessionChanged. These tests capture the SignClient listeners the
 * connector registers and fire them as the relay would.
 */

const TOPIC = "topic-1";
const wcNamespaces = {
  eip155: {
    chains: ["eip155:1", "eip155:137"],
    accounts: [
      "eip155:1:0x1234567890123456789012345678901234567890",
      "eip155:137:0x1234567890123456789012345678901234567890",
    ],
    methods: [...REQUIRED_EVM_METHODS],
    events: [...REQUIRED_EVM_EVENTS],
  },
};

function harness() {
  const listeners = new Map<string, (event: unknown) => void>();
  const client = {
    init: vi.fn(),
    connect: vi.fn(),
    request: vi.fn(),
    disconnect: vi.fn(),
    session: {
      get: vi.fn(() => ({
        topic: TOPIC,
        namespaces: wcNamespaces,
        expiry: 1_900_000_000,
        peer: { metadata: { name: "Mock" } },
      })),
      getAll: vi.fn(() => []),
    },
    on: vi.fn((name: string, fn: (event: unknown) => void) => {
      listeners.set(name, fn);
    }),
  };
  const connector = new WalletConnectConnector({
    projectId: "test",
    metadata: { name: "t", description: "t", url: "https://t", icons: [] },
    client: client as never,
  });
  // Typed against WalletConnect's own event arguments so a payload shape the
  // relay does not send cannot be asserted here.
  const fire = <E extends SignClientTypes.Event>(
    name: E,
    event: SignClientTypes.EventArguments[E],
  ) => listeners.get(name)?.(event);
  return { connector, fire };
}

describe("WalletConnect onSessionChanged", () => {
  it("maps update / extend / delete / expire to CAIP-25 changes for the current topic only", async () => {
    const { connector, fire } = harness();
    const session = await connector.reconnect(
      createEmptySession({
        id: "s1",
        topic: TOPIC,
        walletId: "Mock",
        walletType: "walletconnect",
        namespaces: wcNamespaces,
        platform: "desktop-web",
        createdAt: "",
        updatedAt: "",
      }),
    );
    const changes: SessionChange[] = [];
    const off = connector.onSessionChanged?.(session, (c) => changes.push(c));

    // Another topic: ignored.
    fire("session_update", {
      id: 1,
      topic: "other",
      params: { namespaces: wcNamespaces },
    });
    expect(changes).toHaveLength(0);

    // Scope update dropping a chain. WalletConnect always sends methods and
    // events (BaseNamespace); chains may be absent and are derived from the
    // accounts.
    fire("session_update", {
      id: 2,
      topic: TOPIC,
      params: {
        namespaces: {
          eip155: {
            accounts: ["eip155:1:0x1234567890123456789012345678901234567890"],
            methods: [...REQUIRED_EVM_METHODS],
            events: [...REQUIRED_EVM_EVENTS],
          },
        },
      },
    });
    expect(changes[0]).toEqual({
      type: "scope",
      namespaces: {
        eip155: {
          chains: ["eip155:1"],
          accounts: ["eip155:1:0x1234567890123456789012345678901234567890"],
          methods: [...REQUIRED_EVM_METHODS],
          events: [...REQUIRED_EVM_EVENTS],
        },
      },
    });

    fire("session_extend", { id: 1, topic: TOPIC });
    expect(changes[1]).toEqual({
      type: "expiry",
      expiresAt: new Date(1_900_000_000 * 1000).toISOString(),
    });

    fire("session_expire", { topic: TOPIC });
    fire("session_delete", { id: 3, topic: TOPIC });
    expect(changes.slice(2)).toEqual([
      { type: "revoked", reason: "expired" },
      { type: "revoked", reason: "wallet" },
    ]);

    off?.();
    fire("session_delete", { id: 4, topic: TOPIC });
    expect(changes).toHaveLength(4);
  });
});

describe("WalletConnect connect with a CAIP-25 scope request", () => {
  it("proposes the requested namespaces instead of the defaults", async () => {
    const proposals: unknown[] = [];
    const client = {
      init: vi.fn(),
      connect: vi.fn(async (params: unknown) => {
        proposals.push(params);
        // Abort before approval: the proposal is what is under test.
        throw new Error("stop");
      }),
      request: vi.fn(),
      disconnect: vi.fn(),
      session: { get: vi.fn(), getAll: vi.fn(() => []) },
      on: vi.fn(),
    };
    const connector = new WalletConnectConnector({
      projectId: "test",
      metadata: { name: "t", description: "t", url: "https://t", icons: [] },
      client: client as never,
    });
    const scope = {
      required: {
        eip155: {
          chains: ["eip155:8453"],
          methods: [...REQUIRED_EVM_METHODS],
          events: [...REQUIRED_EVM_EVENTS],
        },
      },
    };
    await expect(connector.connect({ scope })).rejects.toThrow();
    expect(proposals[0]).toMatchObject({
      requiredNamespaces: scope.required,
      optionalNamespaces: {},
    });
  });
});

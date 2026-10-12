import type { ProviderInterface } from "@coinbase/wallet-sdk";
import { describe, expect, it } from "vitest";
import { CoinbaseConnector } from "./connector";

const ACCOUNT = "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B";
const RECIPIENTS = [
  "0xabababababababababababababababababababab",
  "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
] as const;

type Request = { method: string; params?: readonly unknown[] };

class InMemoryProvider {
  readonly requests: Request[] = [];
  private readonly listeners = new Map<
    string,
    Set<(...args: unknown[]) => void>
  >();
  private rejectSendCalls?: (reason: unknown) => void;
  changeChainOnFirstFallback = false;
  changeAccountOnFirstFallback = false;

  async request(request: Request): Promise<unknown> {
    this.requests.push(request);
    if (request.method === "eth_requestAccounts") return [ACCOUNT];
    if (request.method === "eth_chainId") return "0x1";
    if (request.method === "wallet_sendCalls") {
      return new Promise((_resolve, reject) => {
        this.rejectSendCalls = reject;
      });
    }
    if (request.method === "eth_sendTransaction") {
      if (this.changeAccountOnFirstFallback) {
        this.changeAccountOnFirstFallback = false;
        this.emit("accountsChanged", [
          "0x1234567890123456789012345678901234567890",
        ]);
      }
      if (this.changeChainOnFirstFallback) {
        this.changeChainOnFirstFallback = false;
        this.emit("chainChanged", "0x2105");
      }
      return `0x${"ab".repeat(32)}`;
    }
    throw new Error(`Unexpected method: ${request.method}`);
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  rejectPendingSendCalls(): void {
    this.rejectSendCalls?.({ code: 4200, message: "Unsupported method" });
  }
}

async function setupFallback() {
  const provider = new InMemoryProvider();
  const connector = new CoinbaseConnector({
    appName: "Fallback chain regression",
    appChainIds: [1, 8453],
    provider: provider as unknown as ProviderInterface,
  });
  const session = await connector.connect();
  session.namespaces.eip155.chains = ["eip155:1", "eip155:8453"];
  const result = connector.sendCalls(
    session,
    RECIPIENTS.map((to) => ({ to, value: "0x1", data: "0x" })),
    "eip155:1",
  );
  await Promise.resolve();
  return { provider, result, session };
}

function fallbackRequests(provider: InMemoryProvider): Request[] {
  return provider.requests.filter(
    (request) => request.method === "eth_sendTransaction",
  );
}

describe("Coinbase sendCalls fallback chain binding", () => {
  it("rejects before fallback when the chain changed during wallet_sendCalls", async () => {
    const { provider, result, session } = await setupFallback();
    provider.emit("chainChanged", "0x2105");
    expect(session.namespaces.eip155.chains).toEqual(["eip155:8453"]);
    provider.rejectPendingSendCalls();

    await expect(result).rejects.toMatchObject({ code: "chain_unsupported" });
    expect(fallbackRequests(provider)).toHaveLength(0);
  });

  it("binds every fallback request to the selected chain", async () => {
    const { provider, result } = await setupFallback();
    provider.rejectPendingSendCalls();

    await expect(result).resolves.toContain(",");
    expect(fallbackRequests(provider)).toHaveLength(2);
    for (const request of fallbackRequests(provider)) {
      expect(request.params?.[0]).toEqual(
        expect.objectContaining({ chainId: "0x1" }),
      );
    }
  });

  it("stops before the second fallback request when the chain changes", async () => {
    const { provider, result, session } = await setupFallback();
    provider.changeChainOnFirstFallback = true;
    provider.rejectPendingSendCalls();

    await expect(result).rejects.toMatchObject({
      code: "chain_unsupported",
      details: { sentTransactionHashes: [`0x${"ab".repeat(32)}`] },
    });
    expect(session.namespaces.eip155.chains).toEqual(["eip155:8453"]);
    expect(fallbackRequests(provider)).toHaveLength(1);
  });

  it("stops before the second fallback request when the account changes", async () => {
    const { provider, result } = await setupFallback();
    provider.changeAccountOnFirstFallback = true;
    provider.rejectPendingSendCalls();

    await expect(result).rejects.toMatchObject({
      code: "session_expired",
      details: { sentTransactionHashes: [`0x${"ab".repeat(32)}`] },
    });
    expect(fallbackRequests(provider)).toHaveLength(1);
  });
});

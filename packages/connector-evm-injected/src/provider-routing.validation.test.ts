import { createConnectorManager } from "@naculus/connect-core";
import { describe, expect, it } from "vitest";
import { createEIP6963Connector, type Eip6963EthereumProvider } from "./index";

const ACCOUNT = "0x1234567890abcdef1234567890abcdef12345678";
const RECIPIENT = "0x000000000000000000000000000000000000dead";

type RecordedRequest = { method: string; params?: unknown[] };

function createProvider() {
  const requests: RecordedRequest[] = [];
  const provider: Eip6963EthereumProvider = {
    async request(request) {
      requests.push(request as RecordedRequest);
      switch (request.method) {
        case "wallet_getPermissions":
        case "wallet_requestPermissions":
          return [];
        case "eth_requestAccounts":
        case "eth_accounts":
          return [ACCOUNT];
        case "eth_chainId":
          return "0x1";
        case "personal_sign":
          return `0x${"11".repeat(65)}`;
        case "eth_sendTransaction":
          return `0x${"22".repeat(32)}`;
        case "wallet_sendCalls":
          return { id: "0xbundle" };
        case "wallet_switchEthereumChain":
          return null;
        default:
          throw new Error(`Unexpected mock request: ${request.method}`);
      }
    },
    on() {},
    removeListener() {},
  };
  return { provider, requests };
}

async function createOverlappingSessions(disconnectA = false) {
  const connector = createEIP6963Connector();
  const manager = createConnectorManager({ autoSelect: false });
  const a = createProvider();
  const b = createProvider();

  connector.registerProvider(
    {
      uuid: "wallet-a",
      name: "Wallet A",
      icon: "data:image/svg+xml;base64,",
      rdns: "example.wallet-a",
    },
    a.provider,
  );
  connector.registerProvider(
    {
      uuid: "wallet-b",
      name: "Wallet B",
      icon: "data:image/svg+xml;base64,",
      rdns: "example.wallet-b",
    },
    b.provider,
  );
  manager.register(connector.id, connector);

  const sessionA = await manager.connect(connector.id, "wallet-a");
  if (disconnectA) await manager.disconnect();
  const sessionB = await manager.connect(connector.id, "wallet-b");
  a.requests.length = 0;
  b.requests.length = 0;

  return { connector, manager, sessionA, sessionB, a, b };
}

function expectOnlyBReceived(
  method: string,
  a: { requests: RecordedRequest[] },
  b: { requests: RecordedRequest[] },
) {
  expect(a.requests.filter((request) => request.method === method)).toEqual([]);
  expect(
    b.requests.filter((request) => request.method === method),
  ).toHaveLength(1);
}

describe("selected injected-wallet provider routing validation", () => {
  it("routes signMessage to the selected provider", async () => {
    const { manager, a, b } = await createOverlappingSessions();
    await manager.signMessage({ message: "routing validation" });
    expectOnlyBReceived("personal_sign", a, b);
  });

  it("routes sendTransaction to the selected provider", async () => {
    const { manager, a, b } = await createOverlappingSessions();
    await manager.sendTransaction({ transaction: { to: RECIPIENT } });
    expectOnlyBReceived("eth_sendTransaction", a, b);
  });

  it("routes switchChain to the selected provider", async () => {
    const { manager, a, b } = await createOverlappingSessions();
    await manager.switchChain("eip155:1");
    expectOnlyBReceived("wallet_switchEthereumChain", a, b);
  });

  it("routes sendCalls to the selected provider", async () => {
    const { manager, sessionB, a, b } = await createOverlappingSessions();
    await manager.sendCalls(sessionB, [{ to: RECIPIENT, value: "0x0" }]);
    expectOnlyBReceived("wallet_sendCalls", a, b);
  });

  it("routes to B after disconnecting A before connecting B", async () => {
    const { manager, a, b } = await createOverlappingSessions(true);
    await manager.signMessage({ message: "negative control" });
    expectOnlyBReceived("personal_sign", a, b);
  });

  it("disconnecting B leaves A connected and routed to A", async () => {
    const { connector, sessionA, sessionB, a, b } =
      await createOverlappingSessions();

    await connector.disconnect(sessionB);
    await connector.signMessage?.(sessionA, { message: "still connected" });

    expect(
      a.requests.filter(({ method }) => method === "personal_sign"),
    ).toHaveLength(1);
    expect(
      b.requests.filter(({ method }) => method === "personal_sign"),
    ).toEqual([]);
  });

  it("rejects a session whose walletId has no active entry", async () => {
    const { connector, sessionB, a, b } = await createOverlappingSessions();
    const unknownSession = { ...sessionB, walletId: "wallet-unknown" };

    await expect(
      connector.signMessage?.(unknownSession, { message: "fail closed" }),
    ).rejects.toMatchObject({ code: "session_expired" });
    expect(
      a.requests.filter(({ method }) => method === "personal_sign"),
    ).toEqual([]);
    expect(
      b.requests.filter(({ method }) => method === "personal_sign"),
    ).toEqual([]);
  });
});

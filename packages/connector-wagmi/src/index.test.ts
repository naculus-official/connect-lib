import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNaculusConnector } from "./index";

const TEST_PROJECT_ID = "test-project-id";
const TEST_METADATA = {
  name: "Test DApp",
  description: "Test Description",
  url: "https://test.dapp.com",
  icons: ["https://test.dapp.com/icon.png"],
};

function createMockEmitter() {
  return {
    emit: vi.fn(),
    on: vi.fn(),
  };
}

describe("createNaculusConnector", () => {
  it("should return a CreateConnectorFn", () => {
    const fn = createNaculusConnector({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });
    expect(fn).toBeInstanceOf(Function);
  });

  it("should produce a Connector when called with wagmi params", () => {
    const fn = createNaculusConnector({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });

    const connector = fn({
      chains: [],
      emitter: createMockEmitter() as any,
      providers: [],
    });
    expect(connector).toBeDefined();
    expect(connector.id).toBe("naculus");
    expect(connector.name).toBe("Naculus");
    expect(connector.type).toBe("walletconnect");
  });

  it("should have required connector methods", () => {
    const fn = createNaculusConnector({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });

    const connector = fn({
      chains: [],
      emitter: createMockEmitter() as any,
      providers: [],
    });
    expect(typeof connector.connect).toBe("function");
    expect(typeof connector.disconnect).toBe("function");
    expect(typeof connector.getAccounts).toBe("function");
    expect(typeof connector.getChainId).toBe("function");
    expect(typeof connector.isAuthorized).toBe("function");
    expect(typeof connector.switchChain).toBe("function");
    expect(typeof connector.onAccountsChanged).toBe("function");
    expect(typeof connector.onChainChanged).toBe("function");
    expect(typeof connector.onDisconnect).toBe("function");
    expect(typeof connector.getProvider).toBe("function");
    expect(typeof connector.setup).toBe("function");
  });

  it("should return correct default chainId", async () => {
    const fn = createNaculusConnector({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });

    const connector = fn({
      chains: [],
      emitter: createMockEmitter() as any,
      providers: [],
    });
    const chainId = await connector.getChainId();
    expect(chainId).toBe(1); // Default EVM chain
  });

  it("should return empty accounts when not connected", async () => {
    const fn = createNaculusConnector({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });

    const connector = fn({
      chains: [],
      emitter: createMockEmitter() as any,
      providers: [],
    });
    const accounts = await connector.getAccounts();
    expect(accounts).toEqual([]);
  });

  it("should return not authorized when not connected", async () => {
    const fn = createNaculusConnector({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });

    const connector = fn({
      chains: [],
      emitter: createMockEmitter() as any,
      providers: [],
    });
    const authorized = await connector.isAuthorized();
    expect(authorized).toBe(false);
  });
});

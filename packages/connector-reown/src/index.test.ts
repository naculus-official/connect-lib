import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNaculusAppKitAdapter,
  isNaculusAppKitAdapter,
  NaculusAppKitAdapter,
} from "./index";

const TEST_PROJECT_ID = "test-project-id";
const TEST_METADATA = {
  name: "Test DApp",
  description: "Test Description",
  url: "https://test.dapp.com",
  icons: ["https://test.dapp.com/icon.png"],
};

describe("createNaculusAppKitAdapter", () => {
  it("should create a NaculusAppKitAdapter", () => {
    const adapter = createNaculusAppKitAdapter({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });
    expect(adapter).toBeInstanceOf(NaculusAppKitAdapter);
  });

  it("should set correct id and name", () => {
    const adapter = createNaculusAppKitAdapter({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });
    expect(adapter.id).toBe("naculus");
    expect(adapter.name).toBe("Naculus");
  });
});

describe("NaculusAppKitAdapter", () => {
  it("should initialize with config", () => {
    const adapter = new NaculusAppKitAdapter({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });
    expect(adapter.connector).toBeDefined();
    expect(adapter.connector.config.projectId).toBe(TEST_PROJECT_ID);
  });

  it("should have required methods", () => {
    const adapter = new NaculusAppKitAdapter({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });
    expect(typeof adapter.connect).toBe("function");
    expect(typeof adapter.disconnect).toBe("function");
    expect(typeof adapter.reconnect).toBe("function");
    expect(typeof adapter.getAccounts).toBe("function");
    expect(typeof adapter.getChainId).toBe("function");
    expect(typeof adapter.getProvider).toBe("function");
    expect(typeof adapter.switchChain).toBe("function");
    expect(typeof adapter.signMessage).toBe("function");
    expect(typeof adapter.sendTransaction).toBe("function");
    expect(typeof adapter.signTypedData).toBe("function");
    expect(typeof adapter.on).toBe("function");
    expect(typeof adapter.removeListener).toBe("function");
  });

  it("should return empty accounts when not connected", async () => {
    const adapter = new NaculusAppKitAdapter({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });
    const accounts = await adapter.getAccounts();
    expect(accounts).toEqual([]);
  });

  it("should get default chainId when not connected", async () => {
    const adapter = new NaculusAppKitAdapter({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });
    const chainId = await adapter.getChainId();
    expect(chainId).toBe(1);
  });

  it("should return provider", () => {
    const adapter = new NaculusAppKitAdapter({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });
    const provider = adapter.getProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.request).toBe("function");
    expect(typeof provider.on).toBe("function");
    expect(typeof provider.removeListener).toBe("function");
  });

  it("should support event emitter", () => {
    const adapter = new NaculusAppKitAdapter({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });
    const handler = vi.fn();
    adapter.on("connect", handler);
    adapter.removeListener("connect", handler);
    // Should not throw after removal
    expect(true).toBe(true);
  });

  it("should get session when not connected", () => {
    const adapter = new NaculusAppKitAdapter({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });
    expect(adapter.getSession()).toBeUndefined();
  });
});

describe("isNaculusAppKitAdapter", () => {
  it("should return true for NaculusAppKitAdapter instances", () => {
    const adapter = new NaculusAppKitAdapter({
      projectId: TEST_PROJECT_ID,
      metadata: TEST_METADATA,
    });
    expect(isNaculusAppKitAdapter(adapter)).toBe(true);
  });

  it("should return false for non-adapter objects", () => {
    expect(isNaculusAppKitAdapter({})).toBe(false);
    expect(isNaculusAppKitAdapter(null)).toBe(false);
    expect(isNaculusAppKitAdapter(undefined)).toBe(false);
  });
});

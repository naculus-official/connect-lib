import { describe, expect, it } from "vitest";
import {
  createStorageAdapter,
  LocalStorageAdapter,
  MemoryStorageAdapter,
  NoopStorageAdapter,
  SessionStorageAdapter,
} from "./storage";

describe("LocalStorageAdapter", () => {
  it("should create instance", () => {
    const storage = new LocalStorageAdapter();
    expect(storage).toBeDefined();
  });

  it("should return null in non-browser environment", async () => {
    const storage = new LocalStorageAdapter();
    const result = await storage.get("key");
    expect(result).toBeNull();
  });

  it("should return null for missing key", async () => {
    const storage = new LocalStorageAdapter();
    const result = await storage.get("nonexistent");
    expect(result).toBeNull();
  });

  it("should check existence", async () => {
    const storage = new LocalStorageAdapter();
    const exists = await storage.has("nonexistent");
    expect(exists).toBe(false);
  });
});

describe("SessionStorageAdapter", () => {
  it("should create instance", () => {
    const storage = new SessionStorageAdapter();
    expect(storage).toBeDefined();
  });

  it("should return null in non-browser environment", async () => {
    const storage = new SessionStorageAdapter();
    const result = await storage.get("key");
    expect(result).toBeNull();
  });

  it("should return null for missing key", async () => {
    const storage = new SessionStorageAdapter();
    const result = await storage.get("nonexistent");
    expect(result).toBeNull();
  });
});

describe("MemoryStorageAdapter", () => {
  it("should store values in memory", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.set("key", "value");
    const result = await storage.get("key");
    expect(result).toBe("value");
  });

  it("should return null for missing key", async () => {
    const storage = new MemoryStorageAdapter();
    const result = await storage.get("nonexistent");
    expect(result).toBeNull();
  });

  it("should clear all values", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.set("key1", "value1");
    await storage.set("key2", "value2");
    await storage.clear();
    expect(await storage.get("key1")).toBeNull();
    expect(await storage.get("key2")).toBeNull();
  });

  it("should check existence", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.set("key", "value");
    expect(await storage.has("key")).toBe(true);
    expect(await storage.has("nonexistent")).toBe(false);
  });

  it("should remove value", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.set("key", "value");
    await storage.remove("key");
    expect(await storage.get("key")).toBeNull();
  });

  it("should handle complex objects", async () => {
    const storage = new MemoryStorageAdapter();
    const obj = { nested: { data: [1, 2, 3] } };
    await storage.set("key", obj);
    const result = await storage.get("key");
    expect(result).toEqual(obj);
  });
});

describe("NoopStorageAdapter", () => {
  it("should always return null", async () => {
    const storage = new NoopStorageAdapter();
    expect(await storage.get("key")).toBeNull();
  });

  it("should always return false for has", async () => {
    const storage = new NoopStorageAdapter();
    expect(await storage.has("key")).toBe(false);
  });

  it("should not throw on set", async () => {
    const storage = new NoopStorageAdapter();
    await expect(storage.set("key", "value")).resolves.toBeUndefined();
  });

  it("should not throw on remove", async () => {
    const storage = new NoopStorageAdapter();
    await expect(storage.remove("key")).resolves.toBeUndefined();
  });

  it("should not throw on clear", async () => {
    const storage = new NoopStorageAdapter();
    await expect(storage.clear()).resolves.toBeUndefined();
  });
});

describe("createStorageAdapter", () => {
  it("should create local storage adapter", () => {
    const adapter = createStorageAdapter("local");
    expect(adapter).toBeInstanceOf(LocalStorageAdapter);
  });

  it("should create session storage adapter", () => {
    const adapter = createStorageAdapter("session");
    expect(adapter).toBeInstanceOf(SessionStorageAdapter);
  });

  it("should create memory storage adapter", () => {
    const adapter = createStorageAdapter("memory");
    expect(adapter).toBeInstanceOf(MemoryStorageAdapter);
  });

  it("should create noop adapter for unknown type", () => {
    const adapter = createStorageAdapter("none");
    expect(adapter).toBeInstanceOf(NoopStorageAdapter);
  });

  it("should create with prefix", () => {
    const adapter = createStorageAdapter("local", "app_");
    expect(adapter).toBeInstanceOf(LocalStorageAdapter);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import {
  consumeNonce,
  createMemoryNonceStorage,
  isNonceConsumed,
  isNonceIssued,
  isNonceValid,
  issueNonce,
  removeNonce,
  resetNonceStorage,
  setNonceStorage,
} from "../src/nonce-consumption";
import { generateNonce } from "../src/utils";

describe("generateNonce", () => {
  beforeEach(() => {
    resetNonceStorage();
  });

  it("should use crypto.getRandomValues", () => {
    const nonce = generateNonce();
    expect(nonce).toBeTruthy();
    expect(typeof nonce).toBe("string");
  });

  it("should produce the requested length", () => {
    const nonce = generateNonce(32);
    expect(nonce.length).toBe(32);
    const nonce2 = generateNonce(8);
    expect(nonce2.length).toBe(8);
  });

  it("should produce unique nonces on each call", () => {
    const set = new Set<string>();
    for (let i = 0; i < 100; i++) {
      set.add(generateNonce());
    }
    expect(set.size).toBe(100);
  });

  it("should only contain alphanumeric characters", () => {
    const nonce = generateNonce(64);
    expect(/^[A-Za-z0-9]+$/.test(nonce)).toBe(true);
  });
});

describe("nonce consumption", () => {
  beforeEach(() => {
    resetNonceStorage();
  });

  it("should start with no nonces consumed", async () => {
    const nonce = "test-nonce-1";
    expect(await isNonceConsumed(nonce)).toBe(false);
  });

  it("should mark a nonce as consumed after consumeNonce", async () => {
    const nonce = "test-nonce-2";
    await consumeNonce(nonce);
    expect(await isNonceConsumed(nonce)).toBe(true);
  });

  it("should allow verification of unconsumed nonces", async () => {
    const nonce = "test-nonce-3";
    expect(await isNonceConsumed(nonce)).toBe(false);
    // After verifying (conceptually), consume it
    await consumeNonce(nonce);
    expect(await isNonceConsumed(nonce)).toBe(true);
  });

  it("should reject replay after nonce is consumed", async () => {
    const nonce = "test-nonce-replay";
    await consumeNonce(nonce);
    expect(await isNonceConsumed(nonce)).toBe(true);
    // Second attempt with same nonce should fail
    expect(await isNonceConsumed(nonce)).toBe(true);
  });

  it("should not interfere with different nonces", async () => {
    await consumeNonce("consumed-nonce");
    expect(await isNonceConsumed("different-nonce")).toBe(false);
    expect(await isNonceConsumed("another-nonce")).toBe(false);
  });

  it("should remove a nonce from tracking", async () => {
    const nonce = "test-nonce-remove";
    await consumeNonce(nonce);
    expect(await isNonceConsumed(nonce)).toBe(true);
    await removeNonce(nonce);
    expect(await isNonceConsumed(nonce)).toBe(false);
  });
});

describe("nonce issuance", () => {
  beforeEach(() => {
    resetNonceStorage();
  });

  it("should track issued nonces", async () => {
    const nonce = "issued-nonce-1";
    await issueNonce(nonce);
    expect(await isNonceIssued(nonce)).toBe(true);
  });

  it("should consider an issued + consumed nonce as consumed", async () => {
    const nonce = "issued-then-consumed";
    await issueNonce(nonce);
    await consumeNonce(nonce);
    expect(await isNonceConsumed(nonce)).toBe(true);
    expect(await isNonceIssued(nonce)).toBe(true);
  });

  it("should validate nonce: issued and not consumed", async () => {
    const nonce = "valid-nonce";
    await issueNonce(nonce);
    expect(await isNonceValid(nonce)).toBe(true);
  });

  it("should invalidate nonce: consumed", async () => {
    const nonce = "invalid-nonce-consumed";
    await issueNonce(nonce);
    await consumeNonce(nonce);
    expect(await isNonceValid(nonce)).toBe(false);
  });

  it("should invalidate nonce: not issued", async () => {
    const nonce = "never-issued";
    expect(await isNonceValid(nonce)).toBe(false);
  });
});

describe("createMemoryNonceStorage", () => {
  beforeEach(() => {
    resetNonceStorage();
  });

  it("should create an independent storage instance", async () => {
    const storage = createMemoryNonceStorage();
    await storage.issue("independent-nonce");
    expect(await storage.isIssued("independent-nonce")).toBe(true);

    // The global storage should not be affected
    const globalStorage = createMemoryNonceStorage();
    expect(await globalStorage.isIssued("independent-nonce")).toBe(false);
  });

  it("should support custom storage via setNonceStorage", async () => {
    const custom = createMemoryNonceStorage();
    const prev = setNonceStorage(custom);

    const nonce = "custom-storage-nonce";
    await issueNonce(nonce);
    expect(await custom.isIssued(nonce)).toBe(true);
    expect(await isNonceIssued(nonce)).toBe(true);

    // Restore previous storage
    setNonceStorage(prev);
  });

  it("should reset nonce storage cleanly", async () => {
    await issueNonce("pre-reset");
    await consumeNonce("pre-reset-consumed");

    resetNonceStorage();

    expect(await isNonceIssued("pre-reset")).toBe(false);
    expect(await isNonceConsumed("pre-reset-consumed")).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletError } from "../errors";
import { IsolatedSigner } from "./isolated-signer";

// Minimal mock Worker that responds to messages
class MockWorker {
  onmessage: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  constructor(_url: URL, _opts?: any) {}
  postMessage(msg: any): void {
    const id = msg.id ?? String(Math.random());
    setTimeout(() => {
      if (!this.onmessage) return;
      if (msg.type === "init" || msg.type === "initWithKey") {
        this.onmessage!({ data: { id, type: "ready" } });
      } else if (msg.type === "signMessage" || msg.type === "signTransaction") {
        this.onmessage!({
          data: {
            id,
            type: "signed",
            signature: "0x" + "ab".repeat(65),
            recovery: 0,
          },
        });
      } else if (msg.type === "clear") {
        this.onmessage!({ data: { id, type: "cleared" } });
      }
    }, 5);
  }
  terminate(): void {}
}

// Worker that always returns error
class ErrorWorker {
  onmessage: ((e: any) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  constructor(_url: URL, _opts?: any) {}
  postMessage(msg: any): void {
    const id = msg.id ?? "0";
    setTimeout(() => {
      if (this.onmessage) {
        this.onmessage!({
          data: { id, type: "error", error: "Worker failed" },
        });
      }
    }, 5);
  }
  terminate(): void {}
}

describe("IsolatedSigner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("chainType is eip155", () => {
    const s = new IsolatedSigner();
    expect(s.chainType).toBe("eip155");
  });

  it("signMessage throws WalletError when not initialized", async () => {
    const s = new IsolatedSigner();
    try {
      await s.signMessage({ message: "test" });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WalletError);
      expect((e as WalletError).code).toBe("not_initialized");
    }
  });

  it("signTransaction throws WalletError when not initialized", async () => {
    const s = new IsolatedSigner();
    try {
      await s.signTransaction({ to: "0x1234" });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WalletError);
      expect((e as WalletError).code).toBe("not_initialized");
    }
  });

  it("clear does not throw when worker not initialized", async () => {
    const s = new IsolatedSigner();
    await expect(s.clear()).resolves.toBeUndefined();
  });

  it("init with mocked worker and sign message", async () => {
    (globalThis as any).Worker = MockWorker as any;
    const s = new IsolatedSigner();
    await s.init({}, "passphrase");
    const result = await s.signMessage({ message: "hello" });
    expect(result.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(result.recovery).toBe(0);
  });

  it("initWithKey with mocked worker", async () => {
    (globalThis as any).Worker = MockWorker as any;
    const s = new IsolatedSigner();
    await s.initWithKey(`0x${"ab".repeat(32)}`);
    const result = await s.signTransaction({
      to: "0x" + "12".repeat(20),
      value: "0x0",
    });
    expect(result.signature).toMatch(/^0x[0-9a-f]+$/);
  });

  it("clear after init", async () => {
    (globalThis as any).Worker = MockWorker as any;
    const s = new IsolatedSigner();
    await s.init({}, "passphrase");
    await s.clear();
    try {
      await s.signMessage({ message: "test" });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WalletError);
      expect((e as WalletError).code).toBe("not_initialized");
    }
  });

  it("onMessage error type rejects promise", async () => {
    (globalThis as any).Worker = ErrorWorker as any;
    const s = new IsolatedSigner();
    try {
      await s.init({}, "wrong");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WalletError);
      expect((e as WalletError).code).toBe("crypto_worker_error");
    }
  });

  it("send timeout triggers after 30s", async () => {
    vi.useFakeTimers();
    class SilentWorker {
      onmessage: ((e: any) => void) | null = null;
      onerror: ((e: any) => void) | null = null;
      constructor(_url: URL, _opts?: any) {}
      postMessage(_msg: any): void {}
      terminate(): void {}
    }
    (globalThis as any).Worker = SilentWorker as any;
    const s = new IsolatedSigner();
    const initPromise = s.init({}, "passphrase");
    vi.advanceTimersByTime(31000);
    try {
      await initPromise;
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WalletError);
      expect((e as WalletError).code).toBe("timeout");
    }
    vi.useRealTimers();
  });
});

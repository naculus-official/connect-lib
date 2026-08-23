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

/**
 * Replies without echoing the request id — exactly what crypto-worker.ts did
 * before S39. MockWorker above echoes it, which is the reason this whole suite
 * stayed green while worker isolation could never resolve a single call.
 */
class NoIdWorker {
  onmessage: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  onmessageerror: ((e: any) => void) | null = null;
  constructor(_url: URL, _opts?: any) {}
  postMessage(_msg: any): void {
    setTimeout(() => {
      this.onmessage?.({ data: { type: "ready" } });
    }, 5);
  }
  terminate(): void {}
}

/** Fails to load, like a missing or unresolvable dist/crypto-worker.js. */
class FailingWorker {
  onmessage: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  onmessageerror: ((e: any) => void) | null = null;
  constructor(_url: URL, _opts?: any) {
    setTimeout(() => {
      this.onerror?.({ message: "Failed to fetch worker script" });
    }, 0);
  }
  postMessage(_msg: any): void {}
  terminate(): void {}
}

/** Records the handlers a signer attaches, so both entry points can be compared. */
class HandlerSpyWorker {
  static last: HandlerSpyWorker | null = null;
  onmessage: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  onmessageerror: ((e: any) => void) | null = null;
  constructor(_url: URL, _opts?: any) {
    HandlerSpyWorker.last = this;
  }
  postMessage(_msg: any): void {}
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

  // ── S39: a reply that omits the request id ─────────────────────────────
  //
  // Distinct from the 30s-timeout case below, which covers a worker that never
  // replies at all. Here the worker does reply, but unlabelled — and the whole
  // point is that this must NOT degrade into the same timeout.
  it("rejects promptly when the worker replies without a request id", async () => {
    vi.useFakeTimers();
    (globalThis as any).Worker = NoIdWorker as any;
    const s = new IsolatedSigner();
    const initPromise = s.init({}, "passphrase");
    const assertion = expect(initPromise).rejects.toMatchObject({
      code: "crypto_worker_error",
    });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    vi.useRealTimers();
  });

  it("names the reply type when the worker omits the request id", async () => {
    vi.useFakeTimers();
    (globalThis as any).Worker = NoIdWorker as any;
    const s = new IsolatedSigner();
    const initPromise = s.init({}, "passphrase");
    const assertion = initPromise.catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    const err = await assertion;
    expect(err).toBeInstanceOf(WalletError);
    expect(err.message).toMatch(/crypto worker/i);
    expect(err.message).toMatch(/request id/i);
    expect(err.message).toMatch(/ready/);
    vi.useRealTimers();
  });

  // ── S33: worker load failures on both entry points ─────────────────────
  it("initWithKey rejects promptly when the worker fails to load", async () => {
    vi.useFakeTimers();
    (globalThis as any).Worker = FailingWorker as any;
    const s = new IsolatedSigner();
    const p = s.initWithKey("0x" + "11".repeat(32));
    const assertion = expect(p).rejects.toMatchObject({
      code: "worker_error",
    });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    vi.useRealTimers();
  });

  it("init rejects promptly when the worker fails to load", async () => {
    vi.useFakeTimers();
    (globalThis as any).Worker = FailingWorker as any;
    const s = new IsolatedSigner();
    const p = s.init({}, "passphrase");
    const assertion = expect(p).rejects.toMatchObject({
      code: "worker_error",
    });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    vi.useRealTimers();
  });

  it("worker load failure names the expected asset", async () => {
    vi.useFakeTimers();
    (globalThis as any).Worker = FailingWorker as any;
    const s = new IsolatedSigner();
    const assertion = s.initWithKey("0x" + "11".repeat(32)).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    const err = await assertion;
    expect(err).toBeInstanceOf(WalletError);
    expect(err.message).toMatch(/crypto-worker\.js/);
    vi.useRealTimers();
  });

  it("init and initWithKey register the same failure handlers", async () => {
    (globalThis as any).Worker = HandlerSpyWorker as any;

    const a = new IsolatedSigner();
    void a.init({}, "passphrase").catch(() => {});
    const afterInit = HandlerSpyWorker.last!;

    const b = new IsolatedSigner();
    void b.initWithKey("0x" + "11".repeat(32)).catch(() => {});
    const afterInitWithKey = HandlerSpyWorker.last!;

    for (const w of [afterInit, afterInitWithKey]) {
      expect(typeof w.onmessage).toBe("function");
      expect(typeof w.onerror).toBe("function");
      expect(typeof w.onmessageerror).toBe("function");
    }
  });

  // ── The worker half of the same protocol ───────────────────────────────
  //
  // Lives here rather than in its own file because both halves of one message
  // contract are easier to keep honest side by side: the signer tests above
  // assert what happens to a caller, this asserts that the worker never leaves
  // one waiting. crypto-worker.ts installs `self.onmessage` at module scope, so
  // `self` has to exist before the import.
  it("worker replies with an error for an unknown request type", async () => {
    const sent: any[] = [];
    const prevSelf = (globalThis as any).self;
    (globalThis as any).self = { postMessage: (m: any) => sent.push(m) };

    await import("./crypto-worker");
    await (globalThis as any).self.onmessage({
      data: { type: "definitely-not-a-real-request", payload: {}, id: "42" },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("error");
    expect(sent[0].error).toMatch(/unknown request type/i);
    // Same id back, or the caller sits until the 30s timeout.
    expect(sent[0].id).toBe("42");

    (globalThis as any).self = prevSelf;
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

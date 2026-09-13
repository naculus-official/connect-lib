import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForSafeEnvironment } from "./environment";

/**
 * Regression cover for Safe environment spoofing.
 *
 * `window.location.ancestorOrigins` is WebKit-derived and absent in Firefox,
 * so a guard written as `if (parentOrigin && event.origin !== parentOrigin)`
 * silently accepted every sender there. Environment detection decides whether
 * the SDK believes it is inside a Safe App — and with what Safe address — so
 * an unauthenticated answer is an auth problem, not a cosmetic one.
 */

type FakeWindow = Record<string, unknown>;

function installWindow(ancestorOrigins?: string[]) {
  const listeners = new Set<(e: unknown) => void>();
  const posted: unknown[] = [];
  const parent = { postMessage: (msg: unknown) => posted.push(msg) };
  const win: FakeWindow = {
    top: {},
    parent,
    location: { ancestorOrigins },
    addEventListener: (t: string, h: (e: unknown) => void) => {
      if (t === "message") listeners.add(h);
    },
    removeEventListener: (_t: string, h: (e: unknown) => void) => {
      listeners.delete(h);
    },
  };
  win.self = win;
  vi.stubGlobal("window", win);
  return {
    parent,
    requestId: () => (posted.at(-1) as { messageId: string })?.messageId,
    emit: (e: Record<string, unknown>) => {
      for (const h of listeners) h(e);
    },
  };
}

const payload = (messageId?: string) => ({
  safeAddress: "0x2222222222222222222222222222222222222222",
  chainId: 1,
  ...(messageId ? { messageId } : {}),
});

afterEach(() => vi.unstubAllGlobals());

describe("waitForSafeEnvironment origin gate", () => {
  it("accepts any parent-frame origin by default, as the official SDK does", async () => {
    // @safe-global/safe-apps-sdk defaults `allowedOrigins` to null and gates
    // only on `source === window.parent`. No built-in domain list is invented
    // here, so the default stays permissive and pinning is opt-in.
    const h = installWindow(undefined); // Firefox: no ancestorOrigins
    const pending = waitForSafeEnvironment(500);
    h.emit({
      source: h.parent,
      origin: "https://self-hosted-safe.example.com",
      data: payload(h.requestId()),
    });
    await expect(pending).resolves.toMatchObject({ isSafeApp: true });
  });

  it("rejects an origin outside a consumer-supplied allowedOrigins list", async () => {
    const h = installWindow(undefined);
    const pending = waitForSafeEnvironment(60, [
      /^https:\/\/app\.safe\.global$/,
    ]);
    h.emit({
      source: h.parent,
      origin: "https://evil.example.com",
      data: payload(h.requestId()),
    });
    await expect(pending).rejects.toThrow(/timed out/);
  });

  it("accepts an origin inside a consumer-supplied allowedOrigins list", async () => {
    const h = installWindow(undefined);
    const pending = waitForSafeEnvironment(500, [
      /^https:\/\/app\.safe\.global$/,
    ]);
    h.emit({
      source: h.parent,
      origin: "https://app.safe.global",
      data: payload(h.requestId()),
    });
    await expect(pending).resolves.toMatchObject({ isSafeApp: true });
  });

  it("rejects a reply that did not come from the parent frame", async () => {
    const h = installWindow(undefined);
    const pending = waitForSafeEnvironment(60);
    h.emit({
      source: { postMessage: () => {} }, // some other window
      origin: "https://anything.example.com",
      data: payload(h.requestId()),
    });
    await expect(pending).rejects.toThrow(/timed out/);
  });

  it("rejects a reply whose echoed messageId does not match the request", async () => {
    const h = installWindow(undefined);
    const pending = waitForSafeEnvironment(60);
    h.emit({
      source: h.parent,
      origin: "https://app.safe.global",
      data: payload("not-the-request-id"),
    });
    await expect(pending).rejects.toThrow(/timed out/);
  });

  it("accepts a reply from the parent at a known Safe origin", async () => {
    const h = installWindow(undefined);
    const pending = waitForSafeEnvironment(500);
    h.emit({
      source: h.parent,
      origin: "https://app.safe.global",
      data: payload(h.requestId()),
    });
    await expect(pending).resolves.toMatchObject({
      isSafeApp: true,
      chainId: 1,
    });
  });

  it("honours ancestorOrigins when the browser provides it", async () => {
    const h = installWindow(["https://safe.mycompany.internal"]);
    const pending = waitForSafeEnvironment(500);
    h.emit({
      source: h.parent,
      origin: "https://safe.mycompany.internal",
      data: payload(h.requestId()),
    });
    await expect(pending).resolves.toMatchObject({ isSafeApp: true });
  });
});

// ─── isInIframe / isSafeAppEnvironment ────────────────────────────────
//
// waitForSafeEnvironment was covered above; isSafeAppEnvironment takes the
// other handshake (detectViaHandshake) and is the cheap pre-check most callers
// reach for first, so its refusals need pinning down too.

import { isInIframe, isSafeAppEnvironment } from "./environment";

describe("isInIframe", () => {
  it("is false outside a browser", () => {
    vi.stubGlobal("window", undefined);
    expect(isInIframe()).toBe(false);
  });

  it("is false at the top level", () => {
    const win: Record<string, unknown> = { top: null, parent: {} };
    win.self = win;
    win.top = win;
    vi.stubGlobal("window", win);
    expect(isInIframe()).toBe(false);
  });

  it("is true when self and top differ", () => {
    const win: Record<string, unknown> = { top: {}, parent: {} };
    win.self = win;
    vi.stubGlobal("window", win);
    expect(isInIframe()).toBe(true);
  });

  it("treats a cross-origin top access throw as being framed", () => {
    // Reading window.top across origins throws; that itself proves framing.
    const win: Record<string, unknown> = { parent: {} };
    win.self = win;
    Object.defineProperty(win, "top", {
      get() {
        throw new Error("cross-origin");
      },
    });
    vi.stubGlobal("window", win);
    expect(isInIframe()).toBe(true);
  });
});

describe("isSafeAppEnvironment", () => {
  it("is false outside a browser", async () => {
    vi.stubGlobal("window", undefined);
    await expect(isSafeAppEnvironment()).resolves.toBe(false);
  });

  it("is false when not framed, without attempting a handshake", async () => {
    const win: Record<string, unknown> = { top: null, parent: {} };
    win.self = win;
    win.top = win;
    win.addEventListener = vi.fn();
    vi.stubGlobal("window", win);
    await expect(isSafeAppEnvironment()).resolves.toBe(false);
    expect(win.addEventListener).not.toHaveBeenCalled();
  });

  it("resolves false when the parent never answers", async () => {
    const h = installWindow(undefined);
    await expect(isSafeAppEnvironment()).resolves.toBe(false);
    void h;
  });

  it("resolves true for a Safe reply from the parent frame", async () => {
    const h = installWindow(undefined);
    const pending = isSafeAppEnvironment();
    h.emit({
      source: h.parent,
      origin: "https://app.safe.global",
      data: { type: "SAFE_ENV_INFO" },
    });
    await expect(pending).resolves.toBe(true);
  });

  it("ignores a Safe-shaped reply that did not come from the parent", async () => {
    const h = installWindow(undefined);
    const pending = isSafeAppEnvironment();
    h.emit({
      source: { postMessage: () => {} },
      origin: "https://app.safe.global",
      data: { type: "SAFE_ENV_INFO" },
    });
    await expect(pending).resolves.toBe(false);
  });
});

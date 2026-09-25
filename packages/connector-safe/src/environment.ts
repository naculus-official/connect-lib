/**
 * Safe App Environment Detection
 *
 * Utilities to detect whether the current page is running inside a Safe App iframe.
 * Safe Apps communicate with the Safe interface via window.parent.postMessage.
 * The detection strategy has two tiers:
 *
 * 1. **Synchronous heuristic:** Check if we are in an iframe (window.parent !== window)
 * 2. **Async SDK handshake:** Attempt an SDK-initiated handshake to confirm the
 *    Safe environment and retrieve Safe info
 *
 * Reference: https://docs.safe.global/safe-core-aa-sdk/safe-apps
 */

/**
 * Quick synchronous check: whether the current page is rendered inside an iframe.
 *
 * This is a cheap guard — a positive result does NOT guarantee it's a Safe App
 * iframe; it only means we're in some kind of embedded context.
 * Use `waitForSafeEnvironment()` for authoritative detection.
 */
export function isInIframe(): boolean {
  if (typeof window === "undefined" || typeof window.parent === "undefined") {
    return false;
  }
  try {
    return window.self !== window.top;
  } catch {
    // Cross-origin iframe access to window.top throws — that's also an iframe.
    return true;
  }
}

/**
 * Attempt to detect whether the current page is running inside a Safe App iframe
 * by checking for Safe-specific environment signals.
 *
 * This performs a quick check via `window.parent` postMessage capabilities
 * when Safe SDK is available. In a real Safe App, after initializing the SDK,
 * `sdk.safe.getInfo()` will resolve successfully. Before SDK init, we provide
 * this as a lightweight check.
 *
 * @returns A promise that resolves to `true` if a Safe App environment is detected.
 */
export async function isSafeAppEnvironment(
  allowedOrigins?: SafeAllowedOrigins,
): Promise<boolean> {
  // Must be in a browser environment
  if (typeof window === "undefined") return false;

  // Must be in an iframe
  if (!isInIframe()) return false;

  // Best effort detection: try a postMessage handshake.
  // Safe App frames respond to "ready" messages. If we get a response
  // within the timeout, we know it's a Safe environment.
  try {
    return await detectViaHandshake(500, allowedOrigins);
  } catch {
    // Handshake timed out — this is not a Safe App iframe
    return false;
  }
}

/**
 * Wait for the Safe environment to be ready, returning the Safe info.
 *
 * In a Safe App iframe, the Safe Apps SDK needs to establish communication
 * with the parent frame. This function uses the SDK's internal message
 * protocol to wait until the environment is confirmed.
 *
 * @param timeoutMs Maximum time to wait (default 5000ms)
 * @param allowedOrigins Optional RegExps the answering origin must match, as
 *   in @safe-global/safe-apps-sdk. The browser-derived parent origin is always
 *   required; this list can narrow it further.
 * @throws If the environment is not a Safe App or the handshake times out.
 */
export async function waitForSafeEnvironment(
  timeoutMs = 5000,
  allowedOrigins?: SafeAllowedOrigins,
): Promise<import("./types").SafeEnvironment> {
  if (typeof window === "undefined") {
    throw new Error("Safe App environment detection not available in SSR");
  }

  if (!isInIframe()) {
    throw new Error("Not in an iframe — Safe App environment required");
  }

  // Use the SDK's internal handshake mechanism by posting a "ready" message
  // and listening for the Safe interface response.
  const safeInfo = await handshakeForSafeInfo(timeoutMs, allowedOrigins);

  return {
    isSafeApp: true,
    safeAddress: safeInfo.safeAddress as `0x${string}` | undefined,
    chainId: safeInfo.chainId as number | undefined,
    owners: safeInfo.owners as `0x${string}`[] | undefined,
    threshold: safeInfo.threshold as number | undefined,
    version: safeInfo.version as string | undefined,
    implementation: safeInfo.implementation as `0x${string}` | undefined,
  };
}

/**
 * Origins permitted to answer a Safe handshake.
 *
 * An optional additional restriction, mirroring the `allowedOrigins` option
 * of the official `@safe-global/safe-apps-sdk` PostMessageCommunicator. The
 * exact browser-derived parent origin is always enforced first. No built-in
 * domain list is hard-coded because the Safe interface is self-hostable.
 */
export type SafeAllowedOrigins = readonly RegExp[];

/**
 * Resolve the parent frame to one exact origin before starting a handshake.
 *
 * Chromium/WebKit expose `ancestorOrigins`; Firefox does not, but supplies the
 * embedding page as `document.referrer` unless the parent deliberately strips
 * it. If neither source is available, there is no safe `postMessage` target:
 * fail closed instead of sending the correlation id to `"*"`.
 */
function getParentOrigin(): string | null {
  const candidate =
    window.location.ancestorOrigins?.[0] ||
    (typeof document !== "undefined" ? document.referrer : "");
  if (!candidate) return null;

  try {
    return new URL(candidate).origin;
  } catch {
    return null;
  }
}

/**
 * Gate every handshake reply on the sender actually being our parent frame.
 *
 * This is the same hard gate the official SDK applies
 * (`source === window.parent`), and it is origin-independent, which matters:
 * `window.location.ancestorOrigins` is a WebKit-derived API that Firefox does
 * not implement, so a guard written only as
 * `if (parentOrigin && event.origin !== parentOrigin)` accepted every sender
 * on that browser.
 *
 * A malicious *parent* can still claim to be a Safe interface — no postMessage
 * protocol can prevent that without a pinned origin — which is exactly why
 * `allowedOrigins` exists for consumers that need to pin one.
 */
function isTrustedSafeMessage(
  event: MessageEvent,
  requestId: string,
  allowedOrigins?: SafeAllowedOrigins,
): boolean {
  // The browser sets `source`; another window cannot forge it.
  if (event.source !== window.parent) return false;
  if (window.parent === window.self) return false;

  // Browser-supplied, not guessed: only present where the engine implements it.
  const parentOrigin = getParentOrigin();
  if (!parentOrigin || event.origin !== parentOrigin) return false;

  if (allowedOrigins && !allowedOrigins.some((re) => re.test(event.origin))) {
    return false;
  }

  // Correlate when the peer echoes our id. The Safe interface is not required
  // to echo it on these probes, so a missing id is tolerated; a mismatched one
  // is not.
  const data = event.data as { messageId?: unknown; requestId?: unknown };
  if (typeof data?.messageId === "string" && data.messageId !== requestId)
    return false;
  if (typeof data?.requestId === "string" && data.requestId !== requestId)
    return false;

  return true;
}

/**
 * Correlation id for a handshake. Always cryptographically random: a
 * predictable id would let a sender that slips past the origin gate replay a
 * plausible-looking reply.
 */
function safeUUID(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    try {
      return crypto.randomUUID();
    } catch {
      // Non-secure contexts throw; fall through to getRandomValues.
    }
  }
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error(
    "A cryptographically secure random source is required for the Safe handshake.",
  );
}

/**
 * Internal: Try a lightweight handshake to confirm Safe App presence.
 *
 * The Safe interface responds to certain postMessage patterns.
 * We listen for a specific environment message from the parent.
 */
async function detectViaHandshake(
  timeoutMs: number,
  allowedOrigins?: SafeAllowedOrigins,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const requestId = safeUUID();
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Handshake timed out"));
    }, timeoutMs);

    const handler = (event: MessageEvent) => {
      if (!isTrustedSafeMessage(event, requestId, allowedOrigins)) return;
      // Safe App messages have a specific data structure.
      // We look for Safe environment data messages.
      const data = event.data;
      if (data && typeof data === "object") {
        // Safe SDK sends messages with source "iframe" or containing safe info
        const isSafeMessage =
          (data.source === "iframe" && data.method === "ready") ||
          (data.requestId && data.env !== undefined) ||
          data.type === "SAFE_ENV_INFO";

        if (isSafeMessage) {
          cleanup();
          resolve(true);
        }
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("message", handler);
    };

    window.addEventListener("message", handler);

    // Ask the parent frame to identify itself as a Safe interface
    try {
      const parentOrigin = getParentOrigin();
      if (!parentOrigin) {
        throw new Error("Cannot determine parent origin");
      }
      window.parent.postMessage(
        { source: "sdk", method: "ready", messageId: requestId },
        parentOrigin,
      );
    } catch {
      cleanup();
      reject(new Error("Cannot post message to parent"));
    }
  });
}

/**
 * Internal: Attempt a full Safe info handshake via postMessage.
 *
 * This mimics what the Safe Apps SDK does internally but without
 * requiring the full SDK to be loaded. Used by `waitForSafeEnvironment`
 * for environments where the SDK may not yet be initialized.
 */
async function handshakeForSafeInfo(
  timeoutMs: number,
  allowedOrigins?: SafeAllowedOrigins,
): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const requestId = safeUUID();
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Safe environment handshake timed out"));
    }, timeoutMs);

    const handler = (event: MessageEvent) => {
      if (!isTrustedSafeMessage(event, requestId, allowedOrigins)) return;
      const data = event.data;
      if (data && typeof data === "object") {
        // Look for Safe environment info response
        const isSafeEnvResponse =
          data.type === "SAFE_ENV_INFO" ||
          (data.source === "iframe" && data.env !== undefined) ||
          (data.safeAddress !== undefined && data.chainId !== undefined);

        if (isSafeEnvResponse) {
          cleanup();
          resolve(data.env ?? data);
        }
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("message", handler);
    };

    window.addEventListener("message", handler);

    // Request environment info from the parent Safe interface
    try {
      const parentOrigin = getParentOrigin();
      if (!parentOrigin) {
        throw new Error("Cannot determine parent origin");
      }
      window.parent.postMessage(
        {
          source: "sdk",
          method: "getEnvInfo",
          messageId: requestId,
        },
        parentOrigin,
      );
    } catch {
      cleanup();
      reject(new Error("Cannot post message to parent"));
    }
  });
}

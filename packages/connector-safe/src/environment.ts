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
export async function isSafeAppEnvironment(): Promise<boolean> {
  // Must be in a browser environment
  if (typeof window === "undefined") return false;

  // Must be in an iframe
  if (!isInIframe()) return false;

  // Best effort detection: try a postMessage handshake.
  // Safe App frames respond to "ready" messages. If we get a response
  // within the timeout, we know it's a Safe environment.
  try {
    return await detectViaHandshake(500);
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
 * @throws If the environment is not a Safe App or the handshake times out.
 */
export async function waitForSafeEnvironment(
  timeoutMs = 5000,
): Promise<import("./types").SafeEnvironment> {
  if (typeof window === "undefined") {
    throw new Error("Safe App environment detection not available in SSR");
  }

  if (!isInIframe()) {
    throw new Error("Not in an iframe — Safe App environment required");
  }

  // Use the SDK's internal handshake mechanism by posting a "ready" message
  // and listening for the Safe interface response.
  const safeInfo = await handshakeForSafeInfo(timeoutMs);

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
 * Safe UUID generator that works in all browser contexts.
 * In non-secure contexts (HTTP), `crypto.randomUUID()` throws,
 * so we fall back to Math.random-based generation.
 */
function safeUUID(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    try {
      return crypto.randomUUID();
    } catch {
      // Fall through for non-secure contexts
    }
  }
  // Fallback for insecure contexts or older browsers
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Internal: Try a lightweight handshake to confirm Safe App presence.
 *
 * The Safe interface responds to certain postMessage patterns.
 * We listen for a specific environment message from the parent.
 */
async function detectViaHandshake(timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Handshake timed out"));
    }, timeoutMs);

    const handler = (event: MessageEvent) => {
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
      window.parent.postMessage(
        { source: "sdk", method: "ready", messageId: safeUUID() },
        "*",
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
): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Safe environment handshake timed out"));
    }, timeoutMs);

    const handler = (event: MessageEvent) => {
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
      window.parent.postMessage(
        {
          source: "sdk",
          method: "getEnvInfo",
          messageId: safeUUID(),
        },
        "*",
      );
    } catch {
      cleanup();
      reject(new Error("Cannot post message to parent"));
    }
  });
}

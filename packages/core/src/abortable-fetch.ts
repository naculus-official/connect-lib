/**
 * abortable-fetch
 *
 * Shared helpers for fetch + AbortController timeout patterns.
 * Replaces duplicated AbortController + setTimeout boilerplate across the codebase.
 */

// ─── abortableFetch ────────────────────────────────────────────────────

/**
 * Fetch with timeout via AbortController.
 * Returns the Response on success, throws on timeout or network error.
 */
export async function abortableFetch(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── rpcCall ───────────────────────────────────────────────────────────

/**
 * Make a JSON-RPC call with abort/timeout support.
 */
export async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  options?: { timeoutMs?: number; headers?: Record<string, string> },
): Promise<T> {
  const response = await abortableFetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    timeoutMs: options?.timeoutMs ?? 10_000,
  });

  if (!response.ok) {
    throw new Error(`RPC returned status ${response.status}`);
  }

  const json = (await response.json()) as {
    result?: T;
    error?: { code: number; message: string };
  };

  if (json.error) {
    throw new Error(json.error.message);
  }

  return json.result as T;
}

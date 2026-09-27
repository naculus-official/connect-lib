/**
 * abortable-fetch
 *
 * Shared helpers for fetch + AbortController timeout patterns.
 * Replaces duplicated AbortController + setTimeout boilerplate across the codebase.
 */

// ─── withTimeout ───────────────────────────────────────────────────────

/**
 * Run `task` with an AbortSignal that fires after `timeoutMs`.
 * The timer stays armed until `task` settles, so it also covers reading the
 * response body, and is cleared on every path.
 */
async function withTimeout<T>(
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── abortableFetch ────────────────────────────────────────────────────

/**
 * Fetch with timeout via AbortController.
 * Returns the Response on success, throws on timeout or network error.
 */
export async function abortableFetch(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  return withTimeout(options.timeoutMs ?? 10_000, (signal) =>
    fetch(url, { ...options, signal }),
  );
}

// ─── rpcCall ───────────────────────────────────────────────────────────

/**
 * Builds the error thrown for a failed RPC call, so callers can keep their
 * own domain error types. Network errors and timeouts are never mapped.
 */
export interface RpcErrorFactory {
  /** Non-ok HTTP status */
  http(status: number): Error;
  /** JSON-RPC `error` member in the response body */
  rpc(error: { code: number; message: string }): Error;
}

const defaultRpcErrors: RpcErrorFactory = {
  http: (status) => new Error(`RPC returned status ${status}`),
  rpc: (error) => new Error(error.message),
};

/**
 * Make a JSON-RPC call with abort/timeout support.
 * The timeout covers both the request and reading the response body.
 */
export async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  options?: {
    timeoutMs?: number;
    headers?: Record<string, string>;
    toError?: RpcErrorFactory;
  },
): Promise<T> {
  const toError = options?.toError ?? defaultRpcErrors;

  return withTimeout(options?.timeoutMs ?? 10_000, async (signal) => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...options?.headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal,
    });

    if (!response.ok) {
      throw toError.http(response.status);
    }

    const json = (await response.json()) as {
      result?: T;
      error?: { code: number; message: string };
    };

    if (json.error) {
      throw toError.rpc(json.error);
    }

    return json.result as T;
  });
}

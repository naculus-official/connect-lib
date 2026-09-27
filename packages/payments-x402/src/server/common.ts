/** Why a payment was refused: an x402 error code and a sentence for logs. */
export interface Failure {
  ok: false;
  /** x402 error code (`specs/x402-specification-v2.md` §9 where one fits). */
  reason: string;
  detail: string;
}

export function failure(reason: string, detail: string): Failure {
  return { ok: false, reason, detail };
}

export function isFailure(value: unknown): value is Failure {
  return isRecord(value) && value.ok === false;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `value` has exactly `keys` as its own keys (any order). */
export function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length && keys.every((k) => Object.hasOwn(value, k))
  );
}

/**
 * Structural equality of JSON values. Keys whose value is `undefined` count
 * as absent, so a requirement built in code compares equal to its decoded
 * JSON echo.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => jsonEqual(item, b[i]))
    );
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keysA = Object.keys(a).filter((k) => a[k] !== undefined);
  const keysB = Object.keys(b).filter((k) => b[k] !== undefined);
  return (
    keysA.length === keysB.length &&
    keysA.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
  );
}

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Strict base64 → bytes; null for anything that is not canonical base64. */
export function decodeBase64(value: string): Uint8Array | null {
  if (!BASE64.test(value)) return null;
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export function unixNow(now?: () => number): number {
  return now ? now() : Math.floor(Date.now() / 1000);
}

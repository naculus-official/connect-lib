/**
 * SIWx Utility Functions
 */

/**
 * Generate a cryptographically-random nonce.
 * Uses crypto.getRandomValues for browser/Node compatibility.
 * Produces an alphanumeric string of the specified length (default 16).
 */
export function generateNonce(length: number = 16): string {
  const charset =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const array = new Uint8Array(length);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(array);
  } else {
    // Fallback for environments without crypto.getRandomValues
    for (let i = 0; i < length; i++) {
      array[i] = Math.floor(Math.random() * 256);
    }
  }
  let result = "";
  for (let i = 0; i < length; i++) {
    result += charset[array[i] % charset.length];
  }
  return result;
}

/**
 * Format the current time as an ISO 8601 string (UTC).
 */
export function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Add seconds to the current time and return an ISO 8601 string.
 */
export function addSecondsISO(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/**
 * Parse a CAIP-2 chain ID into namespace and reference.
 * Example: "eip155:1" -> { namespace: "eip155", reference: "1" }
 */
export function parseChainId(chainId: string): {
  namespace: string;
  reference: string;
} {
  const colonIndex = chainId.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(
      `Invalid CAIP-2 chain ID: "${chainId}". Expected format: "namespace:reference"`,
    );
  }
  return {
    namespace: chainId.slice(0, colonIndex),
    reference: chainId.slice(colonIndex + 1),
  };
}

/**
 * Validate that a nonce contains only alphanumeric characters.
 */
export function isValidNonce(nonce: string): boolean {
  return /^[A-Za-z0-9]+$/.test(nonce);
}

/**
 * Validate that a domain is a valid RFC 4501 URI host.
 * Accepts hostnames (e.g. "example.com", "localhost") and optional port.
 */
export function isValidDomain(domain: string): boolean {
  // Allow localhost, hostnames, IPs with optional port
  return /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(:[0-9]+)?$/.test(
    domain,
  );
}

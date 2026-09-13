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
  const secureCrypto = globalThis.crypto;
  if (!secureCrypto?.getRandomValues) {
    throw new Error(
      "A cryptographically secure random source is required to generate a SIWx nonce.",
    );
  }
  secureCrypto.getRandomValues(array);
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
  if (!/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/.test(chainId)) {
    throw new Error(
      `Invalid CAIP-2 chain ID: "${chainId}". Expected format: "namespace:reference"`,
    );
  }
  const colonIndex = chainId.indexOf(":");
  return {
    namespace: chainId.slice(0, colonIndex),
    reference: chainId.slice(colonIndex + 1),
  };
}

/**
 * Validate the nonce grammar required by EIP-4361/CAIP-122 text messages:
 * at least eight ASCII alphanumeric characters.
 */
export function isValidNonce(nonce: string): boolean {
  return /^[A-Za-z0-9]{8,}$/.test(nonce);
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

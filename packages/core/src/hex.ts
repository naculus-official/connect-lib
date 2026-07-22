/**
 * Convert a string to hex string prefixed with 0x.
 * Uses TextEncoder + manual hex conversion — no Node.js Buffer dependency.
 */
export function hexEncode(message: string): `0x${string}` {
  const bytes = new TextEncoder().encode(message);
  let hex = "0x";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex as `0x${string}`;
}

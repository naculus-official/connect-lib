/**
 * Convert a string to hex string prefixed with 0x.
 * Uses TextEncoder + manual hex conversion — no Node.js Buffer dependency.
 * If the input is already a 0x-prefixed hex string, it is returned as-is.
 */
export function hexEncode(message: string): `0x${string}` {
  if (/^0x[0-9a-fA-F]*$/.test(message)) return message as `0x${string}`;

  const bytes = new TextEncoder().encode(message);
  let hex = "0x";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex as `0x${string}`;
}

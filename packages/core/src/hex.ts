/**
 * Convert a string to hex string prefixed with 0x.
 * Uses @noble/hashes utf8ToBytes + bytesToHex (no Node.js Buffer dependency).
 * If the input is already a 0x-prefixed hex string, it is returned as-is.
 */
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

export function hexEncode(message: string): `0x${string}` {
  if (/^0x[0-9a-fA-F]*$/.test(message)) return message as `0x${string}`;
  return `0x${bytesToHex(utf8ToBytes(message))}` as `0x${string}`;
}

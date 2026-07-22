/**
 * BigInt ↔ String Conversion Utilities
 *
 * Provides safe conversion between bigint and string representations
 * for fee values, integrating with wallet-engine and UI layers.
 *
 * @see SRS-001 §6.3
 */

/**
 * Convert a bigint fee value to its decimal string representation.
 *
 * @param value - Fee value in wei as bigint
 * @returns Decimal string (e.g., "15000000000" for 15 gwei)
 *
 * @example
 * ```ts
 * toDecString(15000000000n) // "15000000000"
 * toDecString(0n)           // "0"
 * ```
 */
export function toDecString(value: bigint): string {
  return value.toString();
}

/**
 * Parse a decimal string into a bigint.
 *
 * @param value - Decimal string (e.g., "15000000000")
 * @returns bigint representation
 *
 * @example
 * ```ts
 * parseBigInt("15000000000") // 15000000000n
 * parseBigInt("0")           // 0n
 * ```
 */
export function parseBigInt(value: string): bigint {
  return BigInt(value);
}

/**
 * Convert a bigint to a human-readable string with a label (e.g., "25 gwei").
 *
 * @param wei - Value in wei as bigint
 * @param decimals - Number of decimals for the display unit (default: 9 for gwei)
 * @param unit - Unit label (default: "gwei")
 * @returns Human-readable string
 *
 * @example
 * ```ts
 * toHumanReadable(25000000000n)     // "25 gwei"
 * toHumanReadable(15000000000n, 9, "gwei") // "15 gwei"
 * toHumanReadable(1000000000000000000n, 18, "ETH") // "1 ETH"
 * ```
 */
export function toHumanReadable(
  wei: bigint,
  decimals: number = 9,
  unit: string = "gwei",
): string {
  if (wei === 0n) return `0 ${unit}`;

  const divisor = 10n ** BigInt(decimals);
  const whole = wei / divisor;
  const remainder = wei % divisor;

  if (remainder === 0n) {
    return `${whole.toString()} ${unit}`;
  }

  const remainderStr = remainder.toString().padStart(decimals, "0");
  const trimmed = remainderStr.replace(/0+$/, "");
  return `${whole.toString()}.${trimmed} ${unit}`;
}

/**
 * Amount formatting utilities for ERC-20 tokens.
 *
 * Provides parseUnits (human-readable → raw bigint) and
 * formatUnits (raw bigint → human-readable string).
 *
 * Handles any decimal count (0–255 as per ERC-20 spec).
 */

import { ERC20TokenError } from "./errors";

/**
 * Convert a human-readable amount (string, number, or bigint) to the smallest unit.
 *
 * @example
 * parseUnits("1.5", 6)   → 1500000n    (USDC: 1.5 → 1,500,000)
 * parseUnits("0.01", 18) → 10000000000000000n
 * parseUnits("100", 0)   → 100n
 *
 * @throws {ERC20TokenError} on invalid input
 */
export function parseUnits(
  amount: string | number | bigint,
  decimals: number,
): bigint {
  if (
    typeof decimals !== "number" ||
    !Number.isInteger(decimals) ||
    decimals < 0
  ) {
    throw new ERC20TokenError(
      "invalid_amount",
      `Invalid decimals value: ${decimals}. Must be a non-negative integer.`,
    );
  }

  // Handle bigint directly (already in raw units)
  if (typeof amount === "bigint") {
    return amount;
  }

  let str: string;
  if (typeof amount === "number") {
    if (!Number.isFinite(amount)) {
      throw new ERC20TokenError(
        "invalid_amount",
        `Amount is not a finite number: ${amount}`,
      );
    }
    if (amount < 0) {
      throw new ERC20TokenError(
        "invalid_amount",
        `Amount must be non-negative, got: ${amount}`,
      );
    }
    str = amount.toString();
  } else {
    // string
    str = amount.trim();
  }

  if (str === "" || str === ".") {
    throw new ERC20TokenError(
      "invalid_amount",
      `Amount string is empty or invalid: "${amount}"`,
    );
  }

  // Validate characters
  if (!/^[0-9]*\.?[0-9]*$/.test(str)) {
    throw new ERC20TokenError(
      "invalid_amount",
      `Amount contains invalid characters: "${amount}"`,
    );
  }

  // Handle negative (should not happen after trimming, but just in case)
  if (str.startsWith("-")) {
    throw new ERC20TokenError(
      "invalid_amount",
      `Amount must be non-negative, got: "${amount}"`,
    );
  }

  // Split into integer and fractional parts
  const dotIndex = str.indexOf(".");
  let integerPart: string;
  let fractionalPart: string;

  if (dotIndex === -1) {
    integerPart = str;
    fractionalPart = "";
  } else {
    integerPart = str.slice(0, dotIndex);
    fractionalPart = str.slice(dotIndex + 1);
  }

  // Check fractional length
  if (fractionalPart.length > decimals) {
    throw new ERC20TokenError(
      "invalid_amount",
      `Amount "${amount}" has ${fractionalPart.length} decimal places, but max is ${decimals}.`,
    );
  }

  // Pad fractional part to required decimals
  fractionalPart = fractionalPart.padEnd(decimals, "0");

  // Remove leading zeros from integer part (but keep at least "0")
  integerPart = integerPart.replace(/^0+/, "") || "0";

  const combined = integerPart + fractionalPart;

  try {
    return BigInt(combined);
  } catch {
    throw new ERC20TokenError(
      "invalid_amount",
      `Failed to parse amount as bigint: "${amount}"`,
    );
  }
}

/**
 * Convert a raw bigint amount to a human-readable decimal string.
 *
 * @example
 * formatUnits(1500000n, 6)       → "1.5"
 * formatUnits(10000000000000000n, 18) → "0.01"
 * formatUnits(0n, 18)            → "0"
 */
export function formatUnits(amount: bigint, decimals: number): string {
  if (
    typeof decimals !== "number" ||
    !Number.isInteger(decimals) ||
    decimals < 0
  ) {
    throw new ERC20TokenError(
      "invalid_amount",
      `Invalid decimals value: ${decimals}. Must be a non-negative integer.`,
    );
  }

  const negative = amount < 0n;
  const absAmount = negative ? -amount : amount;

  const str = absAmount.toString();
  const padded = str.padStart(decimals + 1, "0");

  const dotPos = padded.length - decimals;
  let integerPart = padded.slice(0, dotPos);
  let fractionalPart = padded.slice(dotPos);

  // Remove trailing zeros from fractional part
  fractionalPart = fractionalPart.replace(/0+$/, "");

  // Remove leading zeros (but keep at least "0")
  integerPart = integerPart.replace(/^0+/, "") || "0";

  if (fractionalPart.length === 0) {
    return negative ? `-${integerPart}` : integerPart;
  }

  return negative
    ? `-${integerPart}.${fractionalPart}`
    : `${integerPart}.${fractionalPart}`;
}

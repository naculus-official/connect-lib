/**
 * SIWx Verification — verify SiwxMessage signatures
 *
 * This module provides chain-agnostic SIWx message verification.
 * It validates message structure, time constraints, and delegates
 * cryptographic signature recovery to a user-provided callback.
 *
 * Chain-specific verifier factories are provided for convenience:
 *   - createEVMVerifier()       — uses viem recoverMessageAddress
 *   - createSolanaVerifier()    — uses tweetnacl + bs58
 *   - createXRPLVerifier()      — uses ripple-keypairs
 *
 * Usage:
 * ```ts
 * import { verifySiwxMessage, createEVMVerifier } from "@naculus/siwx";
 *
 * const result = await verifySiwxMessage({
 *   raw: rawMessage,
 *   signature: "0x...",
 *   recoverAddress: createEVMVerifier(),
 *   expectedAddress: "0x...",
 *   domain: "example.com",
 *   nonce: "abc123",
 * });
 * ```
 */

import { parseSiwxMessage } from "./message";
import {
  consumeNonce,
  isNonceConsumed,
  isNonceIssued,
} from "./nonce-consumption";
import type { SiwxMessage, SiwxVerificationResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parameters for verifySiwxMessage.
 */
export interface VerifySiwxMessageParams {
  /** The raw SIWx message string that was signed */
  raw: string;
  /** The cryptographic signature (hex-encoded for EVM, base58 for Solana) */
  signature: string;
  /**
   * Callback that recovers the signer address from a message + signature.
   * The `message` passed here is the raw message string (not the Ethereum-prefixed one;
   * the verifier is responsible for applying any required prefix/hash).
   */
  recoverAddress: (params: {
    message: string;
    signature: string;
  }) => string | Promise<string>;
  /** Expected signer address. If provided, verification checks address match. */
  expectedAddress?: string;
  /** Expected domain. If provided, verification checks domain match. */
  domain?: string;
  /** Expected nonce. If provided, verification checks nonce match. */
  nonce?: string;
  /**
   * Reference timestamp (ISO 8601) for checking expirationTime/notBefore.
   * Defaults to current time.
   */
  timestamp?: string;
}

/**
 * Additional options controlling validation strictness.
 */
export interface VerifyOptions {
  /** When true, messages without expirationTime are rejected (default: false) */
  requireExpirationTime?: boolean;
  /** When true, expirationTime check is skipped (default: false) */
  skipExpirationCheck?: boolean;
  /** When true, notBefore check is skipped (default: false) */
  skipNotBeforeCheck?: boolean;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Verify a SIWx message and its cryptographic signature.
 *
 * Steps:
 * 1. Parse the raw message
 * 2. Validate structural integrity
 * 3. Check optional constraints (domain, nonce, expiry, notBefore)
 * 4. Recover the signer address from the signature
 * 5. Compare recovered address with expected address (if provided)
 *
 * Returns a SiwxVerificationResult with the recovered address and validity flag.
 */
export async function verifySiwxMessage(
  params: VerifySiwxMessageParams,
  options?: VerifyOptions,
): Promise<SiwxVerificationResult> {
  // 1. Parse message
  const parsed = parseSiwxMessage(params.raw);
  if (!parsed) {
    return {
      address: params.expectedAddress ?? "",
      isValid: false,
      error: "Failed to parse SIWx message: invalid format",
    };
  }

  // 2. Validate constraints
  const constraintError = validateConstraints(parsed, params, options);
  if (constraintError) {
    return {
      address: parsed.address,
      isValid: false,
      error: constraintError,
    };
  }

  // 3. Recover address from signature
  let recoveredAddress: string;
  try {
    recoveredAddress = await params.recoverAddress({
      message: params.raw,
      signature: params.signature,
    });
  } catch (err) {
    return {
      address: parsed.address,
      isValid: false,
      error:
        "Signature recovery failed: " +
        (err instanceof Error ? err.message : String(err)),
    };
  }

  // 4. Compare addresses (case-insensitive for hex addresses)
  const expected = params.expectedAddress ?? parsed.address;
  const addressesMatch = compareAddresses(recoveredAddress, expected);

  if (!addressesMatch) {
    return {
      address: expected,
      isValid: false,
      error:
        "Signature does not match expected address. Recovered: " +
        recoveredAddress +
        ", Expected: " +
        expected,
    };
  }

  // 5. Validate and consume nonce to prevent replay attacks
  if (parsed.nonce) {
    // Nonce must have been issued by this system (not arbitrary)
    const wasIssued = await isNonceIssued(parsed.nonce);
    if (!wasIssued) {
      return {
        address: recoveredAddress,
        isValid: false,
        error: `unissued nonce: nonce="${parsed.nonce}" was not issued by this system`,
      };
    }
    const alreadyConsumed = await isNonceConsumed(parsed.nonce);
    if (alreadyConsumed) {
      return {
        address: recoveredAddress,
        isValid: false,
        error: `replay: nonce already consumed for nonce="${parsed.nonce}"`,
      };
    }
    await consumeNonce(parsed.nonce);
  }

  return {
    address: recoveredAddress,
    isValid: true,
  };
}

// ---------------------------------------------------------------------------
// Constraint validation
// ---------------------------------------------------------------------------

function validateConstraints(
  parsed: SiwxMessage,
  params: VerifySiwxMessageParams,
  options?: VerifyOptions,
): string | null {
  // Domain check
  if (params.domain !== undefined && parsed.domain !== params.domain) {
    return (
      'Domain mismatch: expected "' +
      params.domain +
      '", got "' +
      parsed.domain +
      '"'
    );
  }

  // Nonce check
  if (params.nonce !== undefined && parsed.nonce !== params.nonce) {
    return (
      'Nonce mismatch: expected "' +
      params.nonce +
      '", got "' +
      parsed.nonce +
      '"'
    );
  }

  // Require expiration time
  if (options?.requireExpirationTime && !parsed.expirationTime) {
    return "Expiration time is required but not present in message";
  }

  // Timestamp-based checks
  const refTime = params.timestamp
    ? new Date(params.timestamp).getTime()
    : Date.now();

  if (isNaN(refTime)) {
    return (
      'Invalid reference timestamp: "' + (params.timestamp ?? "undefined") + '"'
    );
  }

  // Expiration time check
  if (parsed.expirationTime && !options?.skipExpirationCheck) {
    const expTime = new Date(parsed.expirationTime).getTime();
    if (isNaN(expTime)) {
      return (
        'Invalid expiration time in message: "' + parsed.expirationTime + '"'
      );
    }
    if (refTime > expTime) {
      return "SIWx message expired at " + parsed.expirationTime;
    }
  }

  // NotBefore check
  if (parsed.notBefore && !options?.skipNotBeforeCheck) {
    const nbfTime = new Date(parsed.notBefore).getTime();
    if (isNaN(nbfTime)) {
      return 'Invalid notBefore time in message: "' + parsed.notBefore + '"';
    }
    if (refTime < nbfTime) {
      return (
        "SIWx message is not yet valid (notBefore: " + parsed.notBefore + ")"
      );
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Address comparison
// ---------------------------------------------------------------------------

/**
 * Compare two blockchain addresses case-insensitively.
 * Handles Ethereum addresses (case-insensitive hex) and Solana base58 addresses.
 */
function compareAddresses(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// ---------------------------------------------------------------------------
// Chain-specific verifier factories
// ---------------------------------------------------------------------------

/**
 * Create an EVM (EIP-4361 SIWE) verifier using viem's recoverMessageAddress.
 *
 * Requires `viem` to be installed.
 * Throws if viem cannot be imported.
 */
export function createEVMVerifier(): (params: {
  message: string;
  signature: string;
}) => Promise<string> {
  return async ({ message, signature }) => {
    try {
      const { recoverMessageAddress } = await import("viem");
      return await recoverMessageAddress({
        message,
        signature: signature as `0x${string}`,
      });
    } catch {
      throw new Error(
        "viem is required for EVM SIWx verification. " +
          "Install it via: pnpm add viem",
      );
    }
  };
}

/**
 * Create a Solana (SIWS) verifier using tweetnacl and bs58.
 *
 * Requires `tweetnacl` and `bs58` to be installed.
 * Throws if dependencies cannot be imported.
 */
export function createSolanaVerifier(): (params: {
  message: string;
  signature: string;
  publicKey: string;
}) => Promise<boolean> {
  return async ({ message, signature, publicKey }) => {
    try {
      const nacl = await import("tweetnacl");
      const bs58 = await import("bs58");

      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = bs58.default.decode(signature);
      const publicKeyBytes = bs58.default.decode(publicKey);

      return nacl.default.sign.detached.verify(
        messageBytes,
        signatureBytes,
        publicKeyBytes,
      );
    } catch {
      throw new Error(
        "tweetnacl and bs58 are required for Solana SIWx verification. " +
          "Install them via: pnpm add tweetnacl bs58",
      );
    }
  };
}

/**
 * Create an XRPL verifier using ripple-keypairs.
 *
 * Requires `ripple-keypairs` to be installed.
 * Throws if dependency cannot be imported.
 */
export function createXRPLVerifier(): (params: {
  message: string;
  signature: string;
}) => Promise<string> {
  return async ({ message, signature }) => {
    try {
      const keypairs = await import("ripple-keypairs");
      return (keypairs as any).verifyMessage(message, signature);
    } catch {
      throw new Error(
        "ripple-keypairs is required for XRPL SIWx verification. " +
          "Install it via: pnpm add ripple-keypairs",
      );
    }
  };
}

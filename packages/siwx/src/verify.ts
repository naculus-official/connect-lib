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
import { consumeNonceIfValid, isNonceIssued } from "./nonce-consumption";
import type { SiwxMessage, SiwxVerificationResult } from "./types";
import {
  type EthCall,
  decodeErc6492Signature,
  hashPersonalMessage,
  verifyErc1271,
} from "./contract-signature";

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
    /** Public key/address needed by non-recoverable signature schemes. */
    publicKey?: string;
  }) => string | boolean | Promise<string | boolean>;
  /** Expected signer address. If provided, verification checks address match. */
  expectedAddress?: string;
  /** Public key for schemes such as Solana and XRPL that cannot recover it. */
  publicKey?: string;
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
  /**
   * Verify a message without binding it to a domain.
   *
   * Domain binding is what stops a signature harvested on a phishing site
   * from being replayed against the real one: the signature is genuine and
   * the nonce is genuine, and the domain line is the only field that says who
   * the user meant to sign in to. Verification therefore requires
   * `params.domain` by default, and opting out has to be spelled out.
   *
   * Legitimate uses are narrow — inspecting a message whose origin is already
   * established by other means, or tests. Never set it on a login path.
   */
  allowUnboundDomain?: boolean;
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
 * 3. Check constraints (domain is required, then nonce, expiry, notBefore)
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
    const verificationKey =
      params.publicKey ?? params.expectedAddress ?? parsed.address;
    const recovered = await params.recoverAddress({
      message: params.raw,
      signature: params.signature,
      publicKey: verificationKey,
    });
    if (typeof recovered === "boolean") {
      if (!recovered) {
        return {
          address: params.expectedAddress ?? parsed.address,
          isValid: false,
          error: "Signature verification failed",
        };
      }
      // A boolean only proves that `verificationKey` signed. It does not prove
      // that an unrelated address named by the message owns that key. This is
      // naturally bound for Solana, where the public key is the address. Other
      // schemes (XRPL, for example) must return the address derived from the
      // verified public key instead of a bare true.
      const claimedAddress = params.expectedAddress ?? parsed.address;
      if (!compareAddresses(parsed.chainId, verificationKey, claimedAddress)) {
        return {
          address: claimedAddress,
          isValid: false,
          error:
            "Signature verifier confirmed a public key that is not the claimed account address",
        };
      }
      recoveredAddress = verificationKey;
    } else {
      recoveredAddress = recovered;
    }
  } catch (err) {
    return {
      address: parsed.address,
      isValid: false,
      error:
        "Signature recovery failed: " +
        (err instanceof Error ? err.message : String(err)),
    };
  }

  // 4. Compare addresses using the namespace's canonical rules.
  const expected = params.expectedAddress ?? parsed.address;
  if (
    params.expectedAddress !== undefined &&
    !compareAddresses(parsed.chainId, parsed.address, params.expectedAddress)
  ) {
    return {
      address: params.expectedAddress,
      isValid: false,
      error:
        "SIWx message address does not match expected address. Message: " +
        parsed.address +
        ", Expected: " +
        params.expectedAddress,
    };
  }
  const addressesMatch = compareAddresses(
    parsed.chainId,
    recoveredAddress,
    expected,
  );

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
    const consumed = await consumeNonceIfValid(parsed.nonce);
    if (!consumed) {
      // The atomic operation owns the security decision. This read is only for
      // a useful diagnostic after the operation has already failed.
      const wasIssued = await isNonceIssued(parsed.nonce);
      return {
        address: recoveredAddress,
        isValid: false,
        error: wasIssued
          ? `replay: nonce already consumed for nonce="${parsed.nonce}"`
          : `unissued nonce: nonce="${parsed.nonce}" was not issued by this system`,
      };
    }
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
  // Domain binding. Absent expected domain means the caller has no way to
  // tell a message signed for their site from one signed for an attacker's.
  if (params.domain === undefined && !options?.allowUnboundDomain) {
    return (
      "Refusing to verify without domain binding: pass `domain` so a " +
      'signature obtained on another site cannot be replayed here, or set ' +
      "`allowUnboundDomain` if this is deliberately not a login check."
    );
  }

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

  if (Number.isNaN(refTime)) {
    return (
      'Invalid reference timestamp: "' + (params.timestamp ?? "undefined") + '"'
    );
  }

  // Expiration time check
  if (parsed.expirationTime && !options?.skipExpirationCheck) {
    const expTime = new Date(parsed.expirationTime).getTime();
    if (Number.isNaN(expTime)) {
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
    if (Number.isNaN(nbfTime)) {
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
function compareAddresses(chainId: string, a: string, b: string): boolean {
  const namespace = chainId.split(":", 1)[0];
  return namespace === "eip155" ? a.toLowerCase() === b.toLowerCase() : a === b;
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
export interface EVMVerifierOptions {
  /**
   * Performs an `eth_call`. Supplying it enables contract-account
   * verification (ERC-1271, and ERC-6492 for an account that is already
   * deployed). Without it only externally owned accounts can be verified,
   * because `ecrecover` has nothing to say about a contract signature.
   */
  call?: EthCall;
  /** Returns the deployed bytecode at an address, or "0x" when there is none. */
  getCode?: (address: string) => Promise<string>;
}

export function createEVMVerifier(
  options?: EVMVerifierOptions,
): (params: {
  message: string;
  signature: string;
  publicKey?: string;
}) => Promise<string | boolean> {
  return async ({ message, signature, publicKey }) => {
    let recoverMessageAddress: typeof import("viem").recoverMessageAddress;
    try {
      ({ recoverMessageAddress } = await import("viem"));
    } catch (err) {
      throw new Error(
        "viem is required for EVM SIWx verification. Install it via: pnpm add viem",
        { cause: err },
      );
    }

    // Contract accounts sign through their own logic, so there is no address
    // to recover; they are verified against the address that claims them.
    const account = publicKey;
    const wrapped = decodeErc6492Signature(signature);

    if (options?.call && account) {
      const hash = hashPersonalMessage(message);

      if (wrapped) {
        const code = options.getCode
          ? await options.getCode(account).catch(() => "0x")
          : "0x";
        if (code && code !== "0x") {
          // Deployed after signing: the wrapper is now redundant and the
          // inner signature is what the account would answer for.
          return verifyErc1271(account, hash, wrapped.signature, options.call);
        }
        // Still counterfactual. Deciding this requires deploying the account
        // inside an eth_call against a validator contract, which this module
        // deliberately does not carry an address for — see the note on
        // ERC6492_MAGIC_SUFFIX. Report unverified rather than guess.
        return false;
      }

      const contractResult = await verifyErc1271(
        account,
        hash,
        signature,
        options.call,
      );
      if (contractResult) return true;
      // Fall through: an EOA's signature is not an ERC-1271 one.
    }

    if (wrapped) {
      // No chain access, so the wrapper cannot be resolved. Recovering from
      // the envelope bytes would return a meaningless address.
      return false;
    }

    return recoverMessageAddress({
      message,
      signature: signature as `0x${string}`,
    });
  };
}

/**
 * Rethrow a failed dynamic import with a message that names the real cause.
 *
 * The packages guarded this way are declared dependencies of `@naculus/siwx`
 * and are installed alongside it, so reaching this path means module
 * resolution broke — a `pnpm.overrides` entry, a broken hoist, a bundler
 * `external` rule. It does not mean the consumer forgot to install something,
 * and the message must not tell them to.
 */
function moduleLoadFailed(pkg: string, err: unknown): never {
  throw new Error(
    `Could not load "${pkg}", a dependency of @naculus/siwx. It ships with ` +
      `this package, so this is a module resolution failure, not a missing ` +
      `install.`,
    { cause: err },
  );
}

/**
 * Create a Solana (SIWS) verifier using tweetnacl and bs58.
 *
 * Both ship as dependencies of this package; a consumer does not install them
 * separately.
 *
 * Only the imports are guarded. Decoding and verification failures belong to
 * the caller's input and propagate unchanged: an invalid base58 string throws
 * `Non-base58 character` from bs58, and a wrong-length signature or key throws
 * `bad signature size` / `bad public key size` from tweetnacl. Translating
 * those into "install the package" was wrong — it named a cause that was never
 * true and sent the reader looking in the wrong place.
 */
export function createSolanaVerifier(): (params: {
  message: string;
  signature: string;
  publicKey?: string;
}) => Promise<boolean> {
  return async ({ message, signature, publicKey }) => {
    if (!publicKey)
      throw new Error("Solana publicKey is required for verification");
    const nacl = (
      await import("tweetnacl").catch((err) =>
        moduleLoadFailed("tweetnacl", err),
      )
    ).default;
    const bs58 = (
      await import("bs58").catch((err) => moduleLoadFailed("bs58", err))
    ).default;

    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signature);
    const publicKeyBytes = bs58.decode(publicKey);

    return nacl.sign.detached.verify(
      messageBytes,
      signatureBytes,
      publicKeyBytes,
    );
  };
}

/**
 * Create an XRPL verifier using ripple-keypairs.
 *
 * `ripple-keypairs` is a runtime dependency of this package. Import failures
 * therefore indicate a broken module-resolution/bundling setup, while invalid
 * signatures remain ordinary input failures and are not rewritten as install
 * errors.
 */
export function createXRPLVerifier(): (params: {
  message: string;
  signature: string;
  publicKey?: string;
}) => Promise<string | boolean> {
  return async ({ message, signature, publicKey }) => {
    if (!publicKey)
      throw new Error("XRPL publicKey is required for verification");
    const keypairs = await import("ripple-keypairs").catch((err) =>
      moduleLoadFailed("ripple-keypairs", err),
    );
    const messageHex = Array.from(new TextEncoder().encode(message))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (!keypairs.verify(messageHex, signature, publicKey)) return false;
    // Unlike Solana, an XRPL account address is not the public key itself.
    // Return the address derived from the key that actually verified so the
    // common verifier can compare signer identity with the SIWx claim.
    return keypairs.deriveAddress(publicKey);
  };
}

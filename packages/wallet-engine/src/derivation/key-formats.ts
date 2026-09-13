/**
 * The text forms other wallets read and write.
 *
 * No EIP or SLIP specifies how a private key is written down. The derivation
 * standards — BIP-39, BIP-32/44, SLIP-0010, SLIP-0044 — decide which key
 * belongs to which account, and those are what guarantee a recovery phrase
 * opens the same accounts everywhere. The text encoding of a raw key is
 * convention, and it converged: hex with an `0x` prefix on Ethereum, base58 of
 * the 64-byte keypair on Solana.
 *
 * Convention is enough to interoperate, but only if it is followed exactly.
 * Handing a user 64 raw bytes and expecting them to find a base58 encoder is
 * an export that does not work — which is the same as no export, for the
 * person trying to move their funds somewhere else.
 *
 * These functions exist so both directions are covered and testable:
 * everything this wallet emits can be pasted into MetaMask or Phantom, and
 * everything those emit can be pasted back.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { base58 } from "@scure/base";
import { WalletError } from "../errors";

export type KeyNamespace = "eip155" | "solana";

export interface DetectedKey {
  namespace: KeyNamespace;
  /** 32-byte secp256k1 key, or 32-byte ed25519 seed. */
  secret: Uint8Array;
}

/**
 * The form MetaMask, Rabby and geth read: `0x` and 64 hex characters.
 *
 * A 32-byte value, not 64 — the length is in characters.
 */
export function toEvmPrivateKeyHex(secret: Uint8Array): `0x${string}` {
  if (secret.length !== 32) {
    throw new WalletError("invalid_key", "An EVM private key is 32 bytes.");
  }
  if (!secp256k1.utils.isValidPrivateKey(secret)) {
    throw new WalletError(
      "invalid_key",
      "Value is outside the secp256k1 order and cannot be an EVM key.",
    );
  }
  return `0x${bytesToHex(secret)}`;
}

/**
 * The form Phantom, Solflare and `solana-keygen` read: base58 of 64 bytes,
 * secret followed by public key.
 *
 * The layout comes from NaCl's `crypto_sign` secret key and is what every
 * Solana tool expects; the public half is derived here rather than trusted
 * from a caller, so an exported key can never disagree with its own address.
 */
export function toSolanaPrivateKeyBase58(seed: Uint8Array): string {
  return base58.encode(solanaKeypairBytes(seed));
}

/** The JSON array `solana-keygen` writes to a keypair file. */
export function toSolanaKeypairJson(seed: Uint8Array): string {
  return JSON.stringify(Array.from(solanaKeypairBytes(seed)));
}

/** secret ‖ public, the 64-byte layout every Solana tool expects. */
function solanaKeypairBytes(seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) {
    throw new WalletError("invalid_key", "An ed25519 seed is 32 bytes.");
  }
  const combined = new Uint8Array(64);
  combined.set(seed);
  combined.set(ed25519.getPublicKey(seed), 32);
  return combined;
}

/**
 * Work out which chain a pasted key belongs to.
 *
 * Mostly verification rather than inference. The 64-byte Solana form carries
 * its own proof: the trailing 32 bytes must be the ed25519 public key of the
 * leading 32, which either holds or does not.
 *
 * A bare 32-byte value is refused rather than guessed at. No mainstream tool
 * emits one — MetaMask prefixes, Phantom gives 64 bytes, `solana-keygen` gives
 * a JSON array — and a Solana *address* is also 32 base58 bytes, so accepting
 * that shape mostly means accepting a pasted address as if it were a key. The
 * result would be an account the user cannot control and cannot recover, with
 * nothing to indicate why it is empty.
 */
export function detectPrivateKey(input: string): DetectedKey {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new WalletError("invalid_input", "No key was provided.");
  }

  // Prefixed hex: unambiguous, and the prefix is what every EVM tool emits.
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    const secret = hexToBytes(trimmed.slice(2));
    if (!secp256k1.utils.isValidPrivateKey(secret)) {
      throw new WalletError(
        "invalid_key",
        "That value is outside the secp256k1 order, so it is not a valid EVM key.",
      );
    }
    return { namespace: "eip155", secret };
  }

  // solana-keygen keypair file: a JSON array of 64 bytes.
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new WalletError(
        "invalid_input",
        "That looks like a keypair file but is not valid JSON.",
      );
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ) {
      throw new WalletError(
        "invalid_key",
        "A Solana keypair file is an array of 64 byte values.",
      );
    }
    return verifySolanaKeypair(Uint8Array.from(parsed as number[]));
  }

  // Base58: 64 bytes is a Solana keypair, and it proves itself.
  let decoded: Uint8Array | null = null;
  try {
    decoded = base58.decode(trimmed);
  } catch {
    decoded = null;
  }
  if (decoded?.length === 64) {
    return verifySolanaKeypair(decoded);
  }

  if (decoded?.length === 32 || /^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new WalletError(
      "invalid_input",
      "A bare 32-byte value does not say which chain it belongs to, and a Solana address has the same shape as one. Paste an EVM key as 0x followed by 64 hex characters, or a Solana key as the base58 or JSON form Phantom and solana-keygen export.",
    );
  }

  throw new WalletError(
    "invalid_input",
    "Unrecognized private key format. Expected 0x-prefixed hex for EVM, or base58 / a 64-byte JSON array for Solana.",
  );
}

/**
 * Confirm a 64-byte value really is a Solana keypair.
 *
 * The check is exact: the trailing half must be the public key of the leading
 * half. A mismatch means the two were never a pair, and importing it would
 * produce an address whose key cannot sign for it.
 */
function verifySolanaKeypair(bytes: Uint8Array): DetectedKey {
  const seed = bytes.slice(0, 32);
  const claimed = bytes.slice(32);
  const derived = ed25519.getPublicKey(seed);
  if (bytesToHex(derived) !== bytesToHex(claimed)) {
    throw new WalletError(
      "invalid_key",
      "The public half of that keypair does not match its secret half, so it is not a usable Solana key.",
    );
  }
  return { namespace: "solana", secret: seed };
}

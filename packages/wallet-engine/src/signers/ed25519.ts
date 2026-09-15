/**
 * ed25519 signer for Solana.
 *
 * Two differences from the EVM signer are worth stating, because both are
 * places where copying the EVM behavior would produce a signature the chain
 * rejects:
 *
 * - **No message prefix.** EIP-191 wraps a message before hashing; Solana does
 *   not. A wallet there signs the raw bytes, so prefixing would produce a
 *   signature that verifies against nothing anyone else computes.
 * - **No recovery id.** secp256k1 signatures carry `v` so a verifier can
 *   recover the signer. ed25519 has no such thing — verification takes the
 *   public key as an input — so `recovery` is deliberately absent rather than
 *   filled with a placeholder.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { WalletError } from "../errors";
import type {
  Signer,
  SignRequest,
  SignResult,
  TransactionRequest,
} from "./types";

/** The 32-byte ed25519 seed, accepted as hex with or without the prefix. */
function ed25519SecretKey(privateKey: string): Uint8Array {
  const raw = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new WalletError(
      "invalid_key",
      "An ed25519 secret key is 32 bytes of hex.",
    );
  }
  return hexToBytes(raw);
}

export class Ed25519Signer implements Signer {
  readonly chainType = "solana";

  /**
   * Sign a message exactly as a Solana wallet does: the raw UTF-8 bytes.
   *
   * This is what `signMessage` on Phantom and the Wallet Standard
   * `solana:signMessage` feature produce, so a signature from here verifies
   * the same way theirs does.
   */
  async signMessage(
    req: SignRequest,
    privateKey: `0x${string}`,
  ): Promise<SignResult> {
    if (typeof req?.message !== "string") {
      throw new WalletError("invalid_input", "A message string is required.");
    }
    const secret = ed25519SecretKey(privateKey);
    const signature = ed25519.sign(
      new TextEncoder().encode(req.message),
      secret,
    );
    return { signature: `0x${bytesToHex(signature)}` };
  }

  /**
   * Sign already-serialized bytes — a Solana transaction message, typically.
   *
   * The division of labour matches every Solana wallet: the caller builds and
   * serializes the transaction with `@solana/web3.js` or `@solana/kit`, and
   * the signer signs the bytes. Nothing here needs to understand instructions,
   * account metas or a recent blockhash.
   */
  async signBytes(
    bytes: Uint8Array,
    privateKey: `0x${string}`,
  ): Promise<SignResult> {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      throw new WalletError(
        "invalid_input",
        "signBytes requires a non-empty byte array.",
      );
    }
    const secret = ed25519SecretKey(privateKey);
    return { signature: `0x${bytesToHex(ed25519.sign(bytes, secret))}` };
  }

  /**
   * Not implemented, and not a gap to fill later with the current signature.
   *
   * `TransactionRequest` describes an EVM transaction — gas, nonce, EIP-1559
   * fee fields — none of which a Solana transaction has. Accepting one and
   * signing something would mean inventing a mapping no other wallet shares.
   * Serialize with Solana tooling and use `signBytes`.
   */
  async signTransaction(
    _req: TransactionRequest,
    _privateKey: `0x${string}`,
  ): Promise<SignResult> {
    throw new WalletError(
      "method_unsupported",
      "Solana transactions are not built from an EVM TransactionRequest. Serialize the transaction with Solana tooling and call signBytes.",
    );
  }
}

export const ed25519Signer = new Ed25519Signer();

/**
 * Solana key derivation from a BIP-39 mnemonic.
 *
 * The path is `m/44'/501'/0'/0'`, which is what Phantom, Solflare and Backpack
 * derive by default. Matching it is the whole point: a user must be able to
 * take the same recovery phrase to any of them and find the same account. A
 * path of our own choosing would produce a valid wallet at an address no other
 * software would ever show them.
 *
 * Base58 comes from `@scure/base` rather than being written here. Encoding an
 * address is a path where a mistake sends funds somewhere unrecoverable, and
 * the workspace already trusts `@scure`/`@noble` for exactly this class of
 * work.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { WalletError } from "../errors";
import { deriveEd25519 } from "./slip10";

/**
 * The account path Phantom, Solflare and Backpack use.
 *
 * Every segment is hardened, as ed25519 requires.
 */
export const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";

export interface SolanaKeypair {
  /** 32-byte ed25519 seed, the value Solana tooling calls the secret key. */
  secretKey: Uint8Array;
  /** 32-byte ed25519 public key. */
  publicKey: Uint8Array;
  /** Base58 public key — the account address. */
  address: string;
}

/**
 * Derive a Solana account from a BIP-39 seed.
 *
 * Takes the seed rather than the mnemonic so the caller keeps one place that
 * turns a phrase into a seed, and so this never has to hold the phrase itself.
 */
export function deriveSolanaKeypair(
  seed: Uint8Array,
  path: string = SOLANA_DERIVATION_PATH,
): SolanaKeypair {
  const secretKey = deriveEd25519(seed, path);
  const publicKey = ed25519.getPublicKey(secretKey);
  return {
    secretKey,
    publicKey,
    address: base58.encode(publicKey),
  };
}

/**
 * The 64-byte form Solana tooling expects.
 *
 * `@solana/web3.js` and the wallet file format both store secret ‖ public
 * concatenated. Returning it lets a user move the account into the Solana CLI
 * or any other tool without this SDK.
 */
export function toSolanaSecretKeyBytes(keypair: SolanaKeypair): Uint8Array {
  if (keypair.secretKey.length !== 32 || keypair.publicKey.length !== 32) {
    throw new WalletError(
      "invalid_key",
      "A Solana keypair is 32 bytes of secret and 32 bytes of public key.",
    );
  }
  const combined = new Uint8Array(64);
  combined.set(keypair.secretKey);
  combined.set(keypair.publicKey, 32);
  return combined;
}

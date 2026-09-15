/**
 * Solana signer roles.
 *
 * A connected Solana wallet is not one undifferentiated "it signs things".
 * Three different questions get asked of it, and a wallet can answer yes to
 * one and no to another:
 *
 * - **identity** — which account is this? Needed to fill an `authority`,
 *   `owner` or `feePayer` *field* in an instruction. Requires no signing at
 *   all, and every connected wallet can do it.
 * - **signer** — will it contribute a signature to a transaction that someone
 *   else assembled and someone else will submit? This is what a multisig
 *   proposal, a co-signed escrow, or a relayer-submitted transaction needs.
 * - **payer** — will it sign *and* broadcast through its own RPC, returning a
 *   transaction signature? This is what an ordinary swap or transfer needs.
 *
 * Collapsing these into one "signer" is why a send-only wallet looks fine at
 * connect time and fails at the moment the user has already approved
 * everything else. Asking for the role you need returns `null` up front
 * instead, which is a dialog you can avoid opening.
 *
 * The shape follows the role split `@solana/kit`'s wallet plugin exposes as
 * `walletIdentity` / `walletSigner` / `walletPayer`, without taking a
 * dependency on it.
 */

import { WalletError } from "@naculus/connect-core";
import type { DiscoveredSolanaWallet, SolanaProvider } from "./types";

/**
 * What a wallet said it can do, recorded where the evidence exists.
 *
 * Deliberately two-state rather than three. For a Wallet Standard wallet the
 * `features` record is a declaration, so a missing key is a real "no"; for a
 * legacy injected provider the object itself is the declaration, so a missing
 * method is equally a real "no". There is no third case here where we simply
 * have not been told, and inventing one would be decoration.
 *
 * This cannot be recovered later by probing the provider:
 * `createProviderFromWalletStandard` returns an adapter whose
 * `signAndSendTransaction` always *exists* and throws at call time when the
 * underlying feature is absent. `typeof provider.signAndSendTransaction ===
 * "function"` is therefore true for every Wallet Standard wallet, including
 * the ones that cannot do it.
 */
export interface SolanaWalletFeatures {
  signMessage: boolean;
  signTransaction: boolean;
  signAllTransactions: boolean;
  signAndSendTransaction: boolean;
}

/** Which account this is, with no ability to sign for it. */
export interface SolanaIdentity {
  /** Base58 public key. */
  readonly address: string;
  /** CAIP-2 chain this account is being used on. */
  readonly chain: string;
}

/** An account that will contribute a signature without submitting anything. */
export interface SolanaSigner extends SolanaIdentity {
  /** Sign an off-chain message (SIWS, auth challenges). */
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
  /** Sign a serialized transaction and hand it back unsent. */
  signTransaction: (transaction: Uint8Array) => Promise<Uint8Array>;
  /**
   * Sign several in one approval.
   *
   * Absent — not throwing — when the wallet has no batch feature, so a caller
   * can choose between one prompt and N prompts before prompting at all.
   */
  signAllTransactions?: (transactions: Uint8Array[]) => Promise<Uint8Array[]>;
}

/** An account that signs and broadcasts through the wallet's own RPC. */
export interface SolanaPayer extends SolanaIdentity {
  /** Returns the base58 transaction signature the cluster accepted. */
  signAndSendTransaction: (transaction: Uint8Array) => Promise<string>;
}

/**
 * The roles a connected account can actually fill.
 *
 * `identity` is never null: an account we are connected to always has an
 * address. `signer` and `payer` are null exactly when the wallet cannot do
 * that job.
 */
export interface SolanaRoles {
  identity: SolanaIdentity;
  signer: SolanaSigner | null;
  payer: SolanaPayer | null;
  features: SolanaWalletFeatures;
}

/** Feature keys the Wallet Standard defines for the `solana` namespace. */
export function featuresFromWalletStandard(
  features: Record<string, unknown>,
): SolanaWalletFeatures {
  return {
    signMessage: "solana:signMessage" in features,
    signTransaction: "solana:signTransaction" in features,
    signAllTransactions: "solana:signAllTransactions" in features,
    signAndSendTransaction: "solana:signAndSendTransaction" in features,
  };
}

/** For a legacy injected provider, the methods on the object are the answer. */
export function featuresFromLegacyProvider(
  provider: SolanaProvider,
): SolanaWalletFeatures {
  return {
    signMessage: typeof provider.signMessage === "function",
    signTransaction: typeof provider.signTransaction === "function",
    signAllTransactions: typeof provider.signAllTransactions === "function",
    signAndSendTransaction:
      typeof provider.signAndSendTransaction === "function",
  };
}

/**
 * Split a connected wallet into the roles it can fill.
 *
 * Pure: takes the wallet, the account and the chain, and holds no session
 * state. `SolanaConnector.getRoles` wires it to the live session.
 */
export function solanaRoles(
  wallet: DiscoveredSolanaWallet,
  address: string,
  chain: string,
): SolanaRoles {
  const { features, provider } = wallet;
  const identity: SolanaIdentity = { address, chain };

  const signer: SolanaSigner | null = features.signTransaction
    ? {
        ...identity,
        ...(features.signMessage
          ? {
              signMessage: async (message: Uint8Array) =>
                (await provider.signMessage(message)).signature,
            }
          : {}),
        signTransaction: (transaction: Uint8Array) =>
          provider.signTransaction(transaction),
        ...(features.signAllTransactions
          ? {
              signAllTransactions: (transactions: Uint8Array[]) =>
                provider.signAllTransactions(transactions),
            }
          : {}),
      }
    : null;

  const payer: SolanaPayer | null = features.signAndSendTransaction
    ? {
        ...identity,
        signAndSendTransaction: async (transaction: Uint8Array) =>
          (await provider.signAndSendTransaction(transaction)).signature,
      }
    : null;

  return { identity, signer, payer, features };
}

/**
 * The role, or a `WalletError` naming the wallet that cannot fill it.
 *
 * For call sites that genuinely require a role and would otherwise write the
 * same `if (!signer) throw` three times. `method_unsupported` is the
 * error a caller can branch on to offer a different wallet rather than
 * reporting a failure the user caused.
 */
export function requireRole<K extends "signer" | "payer">(
  roles: SolanaRoles,
  role: K,
  walletName: string,
): NonNullable<SolanaRoles[K]> {
  const value = roles[role];
  if (!value) {
    throw new WalletError(
      "method_unsupported",
      role === "signer"
        ? `${walletName} cannot sign a transaction without also sending it. This flow needs a wallet that supports solana:signTransaction.`
        : `${walletName} cannot submit a transaction itself. This flow needs a wallet that supports solana:signAndSendTransaction.`,
    );
  }
  return value as NonNullable<SolanaRoles[K]>;
}

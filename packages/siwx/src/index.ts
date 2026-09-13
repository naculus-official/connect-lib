/**
 * @naculus/siwx — CAIP-122 Sign-In With X
 *
 * Chain-agnostic SIWx message creation, parsing, verification, and utilities.
 * Supports EVM (EIP-4361), Solana, XRPL, and other CAIP-122 compliant chains.
 */

import type { SignInVerificationInput } from "./chain-verifiers/types";

/**
 * Load optional chain verifiers only when they are used. Keeping these behind
 * an import boundary means consumers can import the core SIWx API without
 * installing every chain's optional cryptography package.
 */
export async function verifyCosmwasmSignInMessage(
  input: SignInVerificationInput,
): Promise<boolean> {
  const { verifyCosmwasmSignInMessage: verify } = await import(
    "./chain-verifiers/cosmwasm"
  );
  return verify(input);
}

export async function verifyPolkadotSignInMessage(
  input: SignInVerificationInput,
): Promise<boolean> {
  const { verifyPolkadotSignInMessage: verify } = await import(
    "./chain-verifiers/polkadot"
  );
  return verify(input);
}

export async function verifyStarknetSignInMessage(
  input: SignInVerificationInput,
): Promise<boolean> {
  const { verifyStarknetSignInMessage: verify } = await import(
    "./chain-verifiers/starknet"
  );
  return verify(input);
}
export {
  createSiwxMessage,
  DEFAULT_NONCE_LENGTH,
  getBlockchainName,
  isSiwxMessage,
  parseSiwxMessage,
  SIWX_VERSION,
} from "./message";
export type {
  SessionChangeCallback,
  SessionExpiryCallback,
  SiwxRefreshParams,
  SiwxSession,
  SiwxSessionManagerOptions,
  SiwxSignInParams,
} from "./session";
// ── Session Management ──────────────────────────────────────────
export {
  DEFAULT_SESSION_EXPIRY_SECONDS,
  DEFAULT_SESSION_STORAGE_KEY,
  SiwxSessionManager,
} from "./session";
export type { SiwxSessionStorage } from "./session-storage";
// ── Nonce issuance and replay protection ───────────────────────
export {
  consumeNonce,
  consumeNonceIfValid,
  createMemoryNonceStorage,
  isNonceConsumed,
  isNonceIssued,
  isNonceValid,
  issueNonce,
  removeNonce,
  resetNonceStorage,
  setNonceStorage,
} from "./nonce-consumption";
export type { SiwxNonceStorage } from "./nonce-consumption";
// ── Session Storage ────────────────────────────────────────────
export {
  checkSessionExpired,
  createLocalStorageSiwxSessionStorage,
  createMemorySiwxSessionStorage,
} from "./session-storage";
export type {
  ChainNamespace,
  SiwxMessage,
  SiwxParams,
  SiwxResult,
  SiwxVerificationResult,
} from "./types";
export {
  addSecondsISO,
  generateNonce,
  isValidDomain,
  isValidNonce,
  nowISO,
  parseChainId,
} from "./utils";
export type {
  VerifyOptions,
  VerifySiwxMessageParams,
} from "./verify";
export {
  createEVMVerifier,
  createSolanaVerifier,
  createXRPLVerifier,
  verifySiwxMessage,
} from "./verify";

// ── Contract-account signatures (ERC-1271 / ERC-6492) ─────────────────
export {
  ERC1271_MAGIC_VALUE,
  ERC6492_MAGIC_SUFFIX,
  decodeErc6492Signature,
  encodeIsValidSignatureCall,
  hashPersonalMessage,
  isErc1271Accepted,
  isErc6492Signature,
  verifyErc1271,
  type Erc6492Envelope,
  type EthCall,
} from "./contract-signature";

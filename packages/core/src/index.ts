// ── Account Abstraction (ERC-4337) ───────────────────────────────────
export * from "./account-abstraction";
export * from "./address-validation";
export * from "./auto-reconnect";
// ── Chain Registry (SRS-007: Token Configs) ──────────────────────────
export * from "./capabilities";
export * from "./delegation";
export * from "./eip5792";
export { CHAINS } from "./chain-registry";
export * from "./connector";
export * from "./connector-manager";
export * from "./constants";
export * from "./solana-payment";
export * from "./errors";
export * from "./fee-estimation";
export * from "./hex";
export * from "./logger";
export * from "./notification";
export * from "./payment-timeline";
export * from "./permissions";
export * from "./platform";
export * from "./resolver";
export { RouteEngine } from "./routes/RouteEngine";
export type {
  ChainInfo,
  Route,
  RouteQuote,
  RouteStep,
  Token,
} from "./routes/types";
export * from "./rpc";
export * from "./session";
// ── Session Keys / Ephemeral Keys ────────────────────────────────────
export * from "./session-keys";
export * from "./session-manager";
// ── Transaction Simulation (SRS-010) ──────────────────────────────────
export * from "./simulation";
export * from "./storage";
export * from "./token";
export * from "./token-list";

// ── Token Price Oracle ──────────────────────────────────────────────
export {
  getNativeTokenPriceUsd,
  type NativeTokenPriceOptions,
} from "./token-price";

// ── Passphrase prompt bridge ──────────────────────────────────────
// Framework-agnostic on purpose: an encrypted storage adapter asks for a
// passphrase from inside code that knows nothing about components, so both
// the React and Vue layers need the same object to bridge that.
export {
  PassphraseCancelledError,
  PassphraseGate,
} from "./passphrase-gate";
export type {
  PassphraseIntent,
  PassphraseRequest,
} from "./passphrase-gate";

// ── Solana RPC ────────────────────────────────────────────────────
// Framework-neutral for the same reason as the passphrase gate above: a Vue
// composable and a React hook over this are each about ten lines.
export {
  formatSol,
  getLatestBlockhash,
  getSignatureStatus,
  getSolanaBalance,
  LAMPORTS_PER_SOL,
  parseSol,
  SolanaRpcError,
} from "./solana-rpc";
export type {
  SolanaBalance,
  SolanaConfirmationStatus,
} from "./solana-rpc";

// ── CAIP-2 / CAIP-10 ──────────────────────────────────────────────
export {
  eip155Reference,
  isEvmAddress,
  namespaceOf,
  parseCaip10,
} from "./caip";
export type { Caip10Account } from "./caip";
export { parseChainId, validateChainId } from "./session-manager/types";

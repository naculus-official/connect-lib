/**
 * @naculus/connector-safe — Safe (Gnosis Safe) Wallet Connector
 *
 * Provides a UniversalConnector implementation for Safe (Gnosis Safe) via
 * @safe-global/safe-apps-sdk. This connector is only available when the page
 * is running inside a Safe App iframe.
 *
 * Key features:
 * - Safe App iframe environment detection
 * - Transaction submission (returns safeTxHash, not on-chain tx hash)
 * - Batch transactions (multi-call signing)
 * - Message signing (EIP-191)
 * - Typed data signing (EIP-712)
 * - Safe info retrieval
 *
 * @packageDocumentation
 */

export { createSafeConnector, SafeConnector } from "./connector";
export {
  isInIframe,
  isSafeAppEnvironment,
  waitForSafeEnvironment,
} from "./environment";
export type {
  SafeConnectorConfig,
  SafeEnvironment,
  SafeEventName,
  SafeTransactionRequest,
  SafeTransactionResponse,
} from "./types";
export { isSafeTransactionRequest } from "./types";

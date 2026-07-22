/**
 * WalletSigner — a chain-agnostic signing interface
 *
 * Phase 1 of the first-principles refactoring: extract a pure signing
 * abstraction from the EIP-1193-style UniversalConnector.request().
 *
 * Every connector eventually implements this interface so that callers
 * can sign payloads and listen to account/chain changes without
 * coupling to the JSON-RPC transport layer.
 */

/** Wallet address (hex string, 0x-prefixed) */
export type Address = `0x${string}`;

/** Events emitted by a WalletSigner */
export type WalletEvent = "accountChanged" | "chainChanged";

export interface WalletSigner {
  /** Current wallet address, or null when disconnected */
  getAddress(): Address | null;

  /**
   * Sign raw bytes.
   *
   * @param payload - chain-agnostic Uint8Array to sign
   * @returns signature as a 0x-prefixed hex string
   */
  sign(payload: Uint8Array): Promise<`0x${string}`>;

  /**
   * Escape hatch: raw JSON-RPC request.
   *
   * Required by connectors that are fundamentally remote RPC
   * dispatchers (e.g. WalletConnect).  Set to undefined when the
   * connector does not support arbitrary RPC.
   */
  request?(args: { method: string; params?: unknown[] }): Promise<unknown>;

  /** Register a wallet event handler */
  on(event: WalletEvent, handler: (...args: unknown[]) => void): void;

  /** Remove a previously registered event handler */
  off(event: WalletEvent, handler: (...args: unknown[]) => void): void;
}

import type { UniversalWalletSession } from "@naculus/connect-core";
import {
  SOLANA_DEVNET,
  SOLANA_MAINNET,
  SOLANA_TESTNET,
} from "@naculus/connect-core";
export interface SolanaPublicKey {
  toBytes(): Uint8Array;
  toString(): string;
}

export interface SolanaProvider {
  connect(opts?: {
    onlyIfTrusted?: boolean;
  }): Promise<{ publicKey: SolanaPublicKey }>;
  disconnect(): Promise<void>;
  signMessage(
    message: Uint8Array,
    encoding?: string,
  ): Promise<{ signature: Uint8Array }>;
  signTransaction(tx: Uint8Array): Promise<Uint8Array>;
  signAllTransactions(txs: Uint8Array[]): Promise<Uint8Array[]>;
  signAndSendTransaction(tx: Uint8Array): Promise<{ signature: string }>;
  request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (
    event: string,
    handler: (...args: unknown[]) => void,
  ) => void;
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  publicKey?: SolanaPublicKey;
}

export interface DiscoveredSolanaWallet {
  id: string;
  name: string;
  icon: string;
  rdns?: string;
  provider: SolanaProvider;
  /** How the wallet was discovered */
  source: "wallet-standard" | "legacy";
}

/**
 * Minimal wallet-standard Wallet interface.
 * See: https://github.com/wallet-standard/wallet-standard
 */
export interface WalletStandardWallet {
  name: string;
  icon: string;
  rdns?: string;
  version: string;
  accounts: readonly {
    address: string;
    publicKey: Uint8Array;
    chains?: string[];
  }[];
  features: Record<string, unknown>;
}

export interface SolanaConnectorSession {
  wallet: DiscoveredSolanaWallet;
  publicKey: string;
  /**
   * The session handed to the caller.
   *
   * Held so an in-wallet account switch can update `namespaces.solana.accounts`.
   * Without it the connector had no way to reach the accounts it published, and
   * the account recorded at connect time was the only one it ever reported.
   */
  session: UniversalWalletSession;
}

/**
 * Re-exported from core so the CAIP-2 references have one definition.
 * They were copy-pasted here, into utils.ts and into connector-walletconnect,
 * which is how a wrong Solana genesis value survived in one copy while the
 * others were right.
 */
export const SOLANA_CHAINS = {
  mainnet: SOLANA_MAINNET,
  devnet: SOLANA_DEVNET,
  testnet: SOLANA_TESTNET,
} as const;

export type SolanaChain = (typeof SOLANA_CHAINS)[keyof typeof SOLANA_CHAINS];

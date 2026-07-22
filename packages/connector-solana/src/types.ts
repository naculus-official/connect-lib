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
}

export const SOLANA_CHAINS = {
  mainnet: "solana:0",
  devnet: "solana:1",
  testnet: "solana:2",
} as const;

export type SolanaChain = (typeof SOLANA_CHAINS)[keyof typeof SOLANA_CHAINS];

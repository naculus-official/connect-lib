import type {
  DiscoveredSolanaWallet,
  SolanaProvider,
  WalletStandardWallet,
} from "./types";

/**
 * Known wallet metadata for Solana wallets.
 */
export const SOLANA_WALLET_META: Record<
  string,
  { name: string; icon: string; rdns: string }
> = {
  phantom: {
    name: "Phantom",
    icon: "https://phantom.app/favicon.ico",
    rdns: "app.phantom",
  },
  solflare: {
    name: "Solflare",
    icon: "https://solflare.com/favicon.ico",
    rdns: "solflare-wallet",
  },
};

/**
 * Adapt a wallet-standard Wallet to our legacy SolanaProvider interface.
 */
export function createProviderFromWalletStandard(
  wallet: WalletStandardWallet,
): SolanaProvider {
  const f = wallet.features as Record<string, any>;
  const connectFeature = f["standard:connect"];
  const disconnectFeature = f["standard:disconnect"];
  const signMessageFeature = f["solana:signMessage"];
  const signTxFeature = f["solana:signTransaction"];
  const signAllTxFeature = f["solana:signAllTransactions"];
  const signSendTxFeature = f["solana:signAndSendTransaction"];
  const eventsFeature = f["standard:events"];

  return {
    async connect(opts) {
      const result = await connectFeature.connect(opts);
      const account = result.accounts?.[0] ?? result;
      return {
        publicKey: {
          toString() {
            return account.address;
          },
          toBytes() {
            return account.publicKey;
          },
        },
      };
    },
    async disconnect() {
      await disconnectFeature?.disconnect();
    },
    async signMessage(message) {
      const result = await signMessageFeature.signMessage(message);
      return { signature: result.signature };
    },
    async signTransaction(tx) {
      const result = await signTxFeature.signTransaction(tx);
      return result.signedTransaction ?? result;
    },
    async signAllTransactions(txs) {
      const result = await signAllTxFeature.signAllTransactions(txs);
      return result.signedTransactions ?? result;
    },
    async signAndSendTransaction(tx) {
      const result = await signSendTxFeature.signAndSendTransaction(tx);
      return { signature: result.signature };
    },
    on(event, handler) {
      eventsFeature?.on(event, handler);
    },
  };
}

export function isPhantomInstalled(): boolean {
  if (typeof window === "undefined") return false;
  const win = window as unknown as Record<string, unknown>;
  const phantom = win.phantom as { solana?: SolanaProvider } | undefined;
  const solana = win.solana as SolanaProvider | undefined;
  return !!(phantom?.solana || solana?.isPhantom);
}

export function isSolflareInstalled(): boolean {
  if (typeof window === "undefined") return false;
  const win = window as unknown as Record<string, unknown>;
  const solflare = win.solflare as SolanaProvider | undefined;
  return !!solflare?.isSolflare;
}

declare global {
  interface Window {
    solana?: SolanaProvider;
    phantom?: { solana?: SolanaProvider };
    solflare?: SolanaProvider;
  }
  interface WindowEventMap {
    "wallet-standard:register-wallet": CustomEvent<WalletStandardWallet>;
  }
}

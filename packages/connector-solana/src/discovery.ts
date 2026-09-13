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
  const requireFeature = <T>(name: string): T => {
    const feature = f[name] as T | undefined;
    if (!feature) {
      throw new Error(
        `Wallet Standard wallet is missing required feature: ${name}`,
      );
    }
    return feature;
  };
  const connectFeature = requireFeature<{
    connect: (opts?: unknown) => Promise<unknown>;
  }>("standard:connect");
  const disconnectFeature = f["standard:disconnect"];
  const signMessageFeature = requireFeature<{
    signMessage: (message: Uint8Array) => Promise<any>;
  }>("solana:signMessage");
  const signTxFeature = requireFeature<{
    signTransaction: (tx: Uint8Array) => Promise<any>;
  }>("solana:signTransaction");
  const signAllTxFeature = f["solana:signAllTransactions"];
  const signSendTxFeature = f["solana:signAndSendTransaction"];
  const eventsFeature = f["standard:events"] as
    | { on?: (event: string, handler: (...args: unknown[]) => void) => unknown }
    | undefined;
  /** Unsubscribe callbacks returned by `standard:events`, keyed by handler. */
  const unsubscribes = new Map<(...args: unknown[]) => void, (() => void)[]>();

  return {
    async connect(opts) {
      const result = await connectFeature.connect(opts);
      const candidate =
        result && typeof result === "object" && "accounts" in result
          ? (result as { accounts?: readonly unknown[] }).accounts?.[0]
          : result;
      if (!isWalletStandardAccount(candidate)) {
        throw new Error(
          "Wallet Standard connect returned no valid Solana account",
        );
      }
      const account = candidate;
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
      if (!signAllTxFeature)
        throw new Error("Wallet does not support solana:signAllTransactions");
      const result = await signAllTxFeature.signAllTransactions(txs);
      return result.signedTransactions ?? result;
    },
    async signAndSendTransaction(tx) {
      if (!signSendTxFeature)
        throw new Error(
          "Wallet does not support solana:signAndSendTransaction",
        );
      const result = await signSendTxFeature.signAndSendTransaction(tx);
      return { signature: result.signature };
    },
    on(event, handler) {
      // `standard:events` returns an unsubscribe function. Discarding it left
      // the adapter with no way to detach, so a reconnect stacked another
      // handler on the same wallet and every account change was reported once
      // per connect that had ever happened.
      const off = eventsFeature?.on?.(event, handler);
      if (typeof off === "function") {
        let existing = unsubscribes.get(handler);
        if (!existing) {
          existing = [];
          unsubscribes.set(handler, existing);
        }
        existing.push(off as () => void);
      }
    },
    off(_event, handler) {
      for (const off of unsubscribes.get(handler) ?? []) {
        try {
          off();
        } catch {
          // A wallet that throws on unsubscribe must not block teardown.
        }
      }
      unsubscribes.delete(handler);
    },
  };
}

function isWalletStandardAccount(
  value: unknown,
): value is { address: string; publicKey: Uint8Array } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { address?: unknown }).address === "string" &&
    (value as { publicKey?: unknown }).publicKey instanceof Uint8Array
  );
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

import type {
  CoinbaseWalletSDK,
  Preference,
  ProviderInterface,
} from "@coinbase/wallet-sdk";

/**
 * Configuration for the Coinbase Wallet connector.
 */
export interface CoinbaseConnectorConfig {
  /** Application name (displayed in Coinbase authorization screen) */
  appName: string;
  /** Application logo URL (optional) */
  appLogoUrl?: string;
  /** Initial supported chain IDs (defaults to [1] — Ethereum mainnet) */
  appChainIds?: number[];
  /**
   * Preference for wallet mode.
   * - "all": Show all options (extension + WalletLink)
   * - "smartWalletOnly": Only Smart Wallet
   * - "eoaOnly": Only EOA (externally owned account)
   * @default "all"
   */
  preference?: Preference["options"];
  /** QR code response URL callback (WalletLink mode) */
  onQRCodeResponse?: (url: string) => void;
  /** Override default RPC URLs by CAIP-2 chain ID */
  overrideRpcUrl?: Record<string, string>;
}

/**
 * Internal Coinbase session state.
 */
export interface CoinbaseSession {
  /** The Coinbase Wallet SDK provider instance */
  provider: ProviderInterface;
  /** The Coinbase Wallet SDK instance (for cleanup) */
  sdk: CoinbaseWalletSDK;
  /** Connected accounts */
  accounts: `0x${string}`[];
  /** Connected chain ID (CAIP-2 format, e.g. "eip155:1") */
  chainId: number;
}

/**
 * Options passed from createCoinbaseWalletSDK.
 */
export interface CoinbaseSDKOptions {
  appName: string;
  appLogoUrl?: string | null;
  appChainIds: number[];
  preference: Preference;
}

/**
 * Connection mode determined at connect time.
 */
export type CoinbaseConnectionMode =
  | "extension"
  | "walletlink"
  | "smart-wallet";

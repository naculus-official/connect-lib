import type { Preference, ProviderInterface } from "@coinbase/wallet-sdk";
import { CoinbaseWalletSDK } from "@coinbase/wallet-sdk";
import type {
  BatchCall,
  ConnectorSupport,
  UniversalConnector,
  UniversalWalletSession,
  WalletCapabilities,
} from "@naculus/connect-core";
import {
  CONNECTOR_ERROR_MESSAGES,
  createEmptySession,
  DEFAULT_RPC_URLS,
  detectPlatform,
  EIP155_MAINNET,
  extractAccounts,
  WalletError,
} from "@naculus/connect-core";
import { CoinbaseProviderAdapter } from "./provider";
import type {
  CoinbaseConnectionMode,
  CoinbaseConnectorConfig,
  CoinbaseSession,
} from "./types";

/**
 * Coinbase Wallet connector for connect SDK.
 *
 * Supports:
 * - Coinbase Wallet browser extension detection
 * - WalletLink mode (QR code / deep link for mobile app)
 * - Smart Wallet (via `smartWalletOnly` preference)
 * - EIP-1193 provider for all EVM interactions
 *
 * Coexists with the EIP-6963 injected connector: the extension path
 * duplicates what EIP-6963 provides, but this connector adds WalletLink
 * and Smart Wallet modes that EIP-6963 cannot cover.
 *
 * @example
 * ```typescript
 * const connector = new CoinbaseConnector({
 *   appName: "My DApp",
 *   appChainIds: [1, 137],
 * });
 *
 * const session = await connector.connect();
 * ```
 */
export class CoinbaseConnector implements UniversalConnector {
  /** Unique connector identifier */
  readonly id = "coinbase";

  /** Display name for UI */
  readonly name = "Coinbase Wallet";

  /** Connector type identifier (shared with EIP-6963 for wallet-type parity) */
  readonly kind = "eip6963";

  /** Supported chain namespaces (EVM only) */
  readonly namespaces = ["eip155"];

  /** Feature support flags */
  readonly supports: ConnectorSupport = {
    desktop: true,
    mobile: true,
    deepLink: true,
    qr: true,
    trustedReconnect: false, // CB SDK does not support silent reconnection
  };

  /** Connector configuration */
  readonly config: {
    appName: string;
    appLogoUrl?: string;
    appChainIds: number[];
    preference: Preference["options"];
    onQRCodeResponse?: (url: string) => void;
    overrideRpcUrl?: Record<string, string>;
  };

  private sdk?: CoinbaseWalletSDK;
  private providerAdapter?: CoinbaseProviderAdapter;
  private lastSession?: UniversalWalletSession;
  private sessionExpiryHandler?: () => void;

  /** Connected mode determined during connect */
  private connectionMode?: CoinbaseConnectionMode;

  constructor(config: CoinbaseConnectorConfig) {
    if (!config.appName) {
      throw new WalletError(
        "invalid_input",
        "CoinbaseConnector requires appName.",
      );
    }

    this.config = {
      appName: config.appName,
      appLogoUrl: config.appLogoUrl,
      appChainIds: config.appChainIds ?? [1],
      preference: config.preference ?? "all",
      onQRCodeResponse: config.onQRCodeResponse,
      overrideRpcUrl: config.overrideRpcUrl,
    };
  }

  /**
   * Get or initialize the Coinbase Wallet SDK instance.
   */
  private getSDK(): CoinbaseWalletSDK {
    if (this.sdk) {
      return this.sdk;
    }

    this.sdk = new CoinbaseWalletSDK({
      appName: this.config.appName,
      appLogoUrl: this.config.appLogoUrl ?? null,
      appChainIds: this.config.appChainIds,
    });

    return this.sdk;
  }

  /**
   * Get the provider from the SDK with the configured preference.
   */
  private getProvider(): ProviderInterface {
    const sdk = this.getSDK();

    const preference: Preference = {
      options: this.config.preference,
    };

    const provider = sdk.makeWeb3Provider(preference);

    this.providerAdapter = new CoinbaseProviderAdapter(provider);

    return provider;
  }

  /**
   * Connect to Coinbase Wallet.
   *
   * If the browser extension is installed, it will be used automatically.
   * Otherwise, WalletLink mode will show a QR code or redirect to the
   * Coinbase Wallet mobile app.
   *
   * @param input - Optional input with chainId override
   * @returns UniversalWalletSession
   */
  async connect(input?: unknown): Promise<UniversalWalletSession> {
    const provider = this.getProvider();
    const connectInput =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : undefined;

    // Subscribe to events so we can react to wallet-side changes
    this.setupEventListeners(provider);

    try {
      // Request accounts — this triggers the connection flow
      const accounts = (await provider.request({
        method: "eth_requestAccounts",
      })) as `0x${string}`[];

      if (!accounts || accounts.length === 0) {
        throw new WalletError(
          "user_rejected",
          "No accounts returned from Coinbase Wallet.",
        );
      }

      const chainIdHex = (await provider.request({
        method: "eth_chainId",
      })) as string;

      const chainIdNum = Number.parseInt(chainIdHex, 16);

      // Detect connection mode
      this.connectionMode = this.detectConnectionMode(provider);

      // Build the session
      const caip2ChainId = `eip155:${chainIdNum}`;
      const walletSession = createEmptySession({
        id: crypto.randomUUID(),
        topic: undefined, // Coinbase SDK does not use topics
        walletId: "coinbase-wallet",
        walletType: "eip6963",
        namespaces: {
          eip155: {
            chains: [caip2ChainId],
            accounts: accounts.map((a) => `${caip2ChainId}:${a}`),
            // Standard EIP-1193 methods supported by Coinbase Wallet
            // These are the minimal set required for core dApp interactions.
            // Extend as needed for app-specific requirements.
            methods: [
              "eth_sendTransaction",
              "eth_signTransaction",
              "personal_sign",
              "eth_signTypedData_v4",
              "wallet_switchEthereumChain",
              "eth_requestAccounts",
              "eth_accounts",
              "eth_chainId",
            ],
            events: ["accountsChanged", "chainChanged", "disconnect"],
          },
        },
        platform: detectPlatform(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // On-chain balance check is optional; just include a basic session
      this.lastSession = walletSession;
      return walletSession;
    } catch (error) {
      this.cleanup();
      const message =
        error instanceof Error
          ? error.message
          : "Coinbase Wallet connect failed.";
      if (
        message.toLowerCase().includes("rejected") ||
        message.toLowerCase().includes("user denied")
      ) {
        throw new WalletError("user_rejected", message, error);
      }

      throw new WalletError("wallet_unavailable", message, error);
    }
  }

  /**
   * Reconnect — Coinbase SDK does not support silent reconnection.
   * @throws WalletError always (trustedReconnect is false)
   */
  async reconnect(
    _session: UniversalWalletSession,
  ): Promise<UniversalWalletSession> {
    throw new WalletError(
      "session_expired",
      "Coinbase Wallet does not support silent reconnection. Please call connect() again.",
    );
  }

  /**
   * Disconnect from Coinbase Wallet.
   * Cleans up the provider and SDK state.
   */
  async disconnect(_session: UniversalWalletSession): Promise<void> {
    try {
      if (this.providerAdapter) {
        const provider = this.providerAdapter.getProvider();
        await provider.disconnect();
      }
    } catch {
      // Swallow disconnect errors — provider may be in an invalid state
    } finally {
      this.cleanup();
    }
  }

  /**
   * Get accounts from the current session.
   */
  async getAccounts(session: UniversalWalletSession): Promise<string[]> {
    if (this.providerAdapter) {
      try {
        const provider = this.providerAdapter.getProvider();
        const accounts = (await provider.request({
          method: "eth_accounts",
        })) as `0x${string}`[];
        if (accounts && accounts.length > 0) {
          return accounts;
        }
      } catch {
        // Fall back to session data
      }
    }

    return extractAccounts(session.namespaces);
  }

  /**
   * Sign a message using personal_sign or eth_signTypedData_v4.
   */
  async signMessage(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    const provider = this.requireProvider();
    if (!input || typeof input !== "object")
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.INVALID_INPUT,
      );

    const inputObj = input as Record<string, unknown>;
    const message =
      typeof inputObj.message === "string" ? inputObj.message : undefined;
    const rawAddress =
      typeof inputObj.address === "string" ? inputObj.address : undefined;
    if (!message || !rawAddress)
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.MISSING_MESSAGE,
      );

    const address = rawAddress.includes(":")
      ? rawAddress.split(":").pop()!
      : rawAddress;

    // Determine signing method based on message content
    const isStructured = message.startsWith("{");
    const tryMethods = isStructured
      ? ["eth_signTypedData_v4"]
      : ["personal_sign", "eth_sign"];

    let lastError: unknown;
    for (const tryMethod of tryMethods) {
      let params: unknown[];
      if (tryMethod === "personal_sign") {
        params = [this.hexEncode(message), address];
      } else if (tryMethod === "eth_sign") {
        params = [address, this.hexEncode(message)];
      } else {
        // eth_signTypedData_v4
        params = [address, message];
      }

      try {
        return await provider.request({
          method: tryMethod,
          params,
        });
      } catch (error) {
        lastError = error;
        const errMsg =
          error instanceof Error ? error.message.toLowerCase() : "";
        const isMethodRejection =
          errMsg.includes("not been authorized") ||
          errMsg.includes("not authorized") ||
          errMsg.includes("not approved") ||
          errMsg.includes("method not found") ||
          errMsg.includes("method_not_allowed");

        if (!isMethodRejection) {
          // Unrecoverable error
          throw new WalletError(
            "signature_rejected",
            "Coinbase signature rejected.",
            error,
          );
        }
        // Fall through to next method
      }
    }

    if (lastError instanceof WalletError) throw lastError;
    throw new WalletError(
      "signature_rejected",
      "Coinbase signature rejected.",
      lastError,
    );
  }

  /**
   * Sign a transaction without broadcasting it.
   *
   * Uses eth_signTransaction to request the connected wallet to sign the
   * given transaction parameters. The signed transaction is returned
   * but NOT submitted to the network. Callers may inspect or relay
   * the signed payload as needed.
   *
   * @param session - Active wallet session
   * @param input - Object with a `transaction` field containing standard EVM tx params
   * @returns The signed transaction (RLP-encoded hex string)
   * @throws WalletError if session is expired or input is invalid
   */
  async signTransaction(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    const provider = this.requireProvider();
    if (!input || typeof input !== "object")
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.INVALID_INPUT,
      );

    const inputObj = input as Record<string, unknown>;
    const transaction = inputObj.transaction as
      | Record<string, unknown>
      | undefined;
    if (!transaction)
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.MISSING_TX,
      );

    try {
      return await provider.request({
        method: "eth_signTransaction",
        params: [transaction],
      });
    } catch (error) {
      if (error instanceof WalletError) throw error;
      throw new WalletError(
        "signature_rejected",
        "Coinbase sign transaction rejected.",
        error,
      );
    }
  }

  /**
   * Send a transaction (eth_sendTransaction).
   */
  async sendTransaction(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    const provider = this.requireProvider();
    if (!input || typeof input !== "object")
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.INVALID_INPUT,
      );

    const inputObj = input as Record<string, unknown>;
    const transaction = inputObj.transaction as
      | Record<string, unknown>
      | undefined;
    if (!transaction)
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.MISSING_TX,
      );

    try {
      return await provider.request({
        method: "eth_sendTransaction",
        params: [transaction],
      });
    } catch (error) {
      if (error instanceof WalletError) throw error;
      throw new WalletError("tx_failed", "Coinbase transaction failed.", error);
    }
  }

  /**
   * Switch the connected chain.
   */
  async switchChain(
    session: UniversalWalletSession,
    chainId: string,
  ): Promise<void> {
    const provider = this.requireProvider();
    if (!chainId.startsWith("eip155:")) {
      throw new WalletError(
        "chain_unsupported",
        "Coinbase connector only supports EVM chains.",
      );
    }

    const numericChainId = chainId.split(":")[1];
    const hexChainId = `0x${Number(numericChainId).toString(16)}`;

    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hexChainId }],
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message.toLowerCase() : "";
      // Wallet might not have the chain — try wallet_addEthereumChain
      if (errMsg.includes("unrecognized") || errMsg.includes("4902")) {
        throw new WalletError(
          "chain_unsupported",
          `Coinbase Wallet does not support chain ${chainId}.`,
          error,
        );
      }
      if (error instanceof WalletError) throw error;
      throw new WalletError(
        "chain_unsupported",
        "Coinbase switch chain failed.",
        error,
      );
    }
  }

  /**
   * Send batched calls (wallet_sendCalls) with fallback.
   */
  async sendCalls(
    session: UniversalWalletSession,
    calls: BatchCall[],
    chainId?: string,
  ): Promise<string> {
    const provider = this.requireProvider();
    const resolvedChainId = chainId ?? this.getDefaultChainId(session);

    try {
      return (await provider.request({
        method: "wallet_sendCalls",
        params: [{ calls, chainId: resolvedChainId }],
      })) as string;
    } catch {
      // Fallback: send each call individually
      const accounts = session.namespaces.eip155?.accounts ?? [];
      const fromAccount = accounts[0]?.split(":").pop();
      if (!fromAccount) {
        throw new WalletError(
          "session_expired",
          CONNECTOR_ERROR_MESSAGES.NO_ACCOUNT_TX,
        );
      }

      const txHashes: string[] = [];
      for (const call of calls) {
        const hash = (await provider.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: fromAccount,
              to: call.to,
              value: call.value,
              data: call.data,
            },
          ],
        })) as string;
        txHashes.push(hash);
      }

      return txHashes.length === 1 ? txHashes[0] : txHashes.join(",");
    }
  }

  /**
   * Get wallet capabilities for the connected session.
   */
  async getCapabilities(
    session: UniversalWalletSession,
  ): Promise<Record<string, WalletCapabilities>> {
    const capabilities: Record<string, WalletCapabilities> = {};

    for (const ns of Object.values(session.namespaces)) {
      const nsCaps = (ns.capabilities ?? {}) as Record<string, unknown>;
      const atomicBatchSupported = Boolean(nsCaps.atomicBatch);

      for (const chain of ns.chains) {
        capabilities[chain] = {
          atomicBatch: atomicBatchSupported
            ? { supported: true, maxBatchSize: 5 }
            : { supported: false },
          paymasterService: nsCaps.paymasterService
            ? { supported: true }
            : undefined,
        };
      }
    }

    return capabilities;
  }

  /**
   * Make a raw JSON-RPC request through the Coinbase provider.
   */
  async request(request: {
    method: string;
    params: unknown[];
  }): Promise<unknown> {
    const provider = this.requireProvider();
    return provider.request({
      method: request.method,
      params: request.params,
    });
  }

  /**
   * Get the ETH balance of the first connected account.
   */
  async getBalance(chainId?: string): Promise<string> {
    const session = this.lastSession;
    if (!session)
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.SESSION_EXPIRED,
      );

    const cId = chainId ?? this.getDefaultChainId(session);
    const rpcUrl = this.config.overrideRpcUrl?.[cId] ?? DEFAULT_RPC_URLS[cId];
    if (!rpcUrl)
      throw new WalletError("chain_unsupported", "No RPC URL for chain " + cId);

    const allAccounts = extractAccounts(session.namespaces);
    const address = allAccounts[0]?.split(":").pop();
    if (!address)
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.NO_ACCOUNTS,
      );

    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBalance",
        params: [address, "latest"],
      }),
    });
    const data = await response.json();
    return data.result;
  }

  // ── Coinbase-specific methods ──

  /**
   * Get the connection mode detected during connect.
   */
  getConnectionMode(): CoinbaseConnectionMode | undefined {
    return this.connectionMode;
  }

  /**
   * Whether the connector is currently using extension mode.
   */
  isExtensionMode(): boolean {
    return this.connectionMode === "extension";
  }

  /**
   * Update the supported chain IDs on the SDK instance.
   */
  updateChainIds(chainIds: number[]): void {
    this.config.appChainIds = chainIds;
    console.warn(
      "[CoinbaseConnector] updateChainIds: Coinbase SDK does not support dynamic chain ID updates. " +
        "New chain IDs stored in config but will only apply on next connect().",
    );
  }

  /**
   * Register a handler to be called when the session expires or the wallet disconnects.
   */
  onSessionExpiry(handler: () => void): void {
    this.sessionExpiryHandler = handler;
  }

  // ── Private helpers ──

  /**
   * Get the provider or throw if not connected.
   */
  private requireProvider(): ProviderInterface {
    if (!this.providerAdapter) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.SESSION_EXPIRED,
      );
    }
    return this.providerAdapter.getProvider();
  }

  /**
   * Detect the connection mode based on the provider.
   * Extension mode: provider is Coinbase browser extension
   * Smart Wallet: provider is Coinbase Smart Wallet
   * Default: WalletLink (mobile/QR)
   */
  private detectConnectionMode(
    provider: ProviderInterface,
  ): CoinbaseConnectionMode {
    // Check if the extension is installed and matches
    if (typeof window !== "undefined") {
      const win = window as unknown as Record<string, unknown>;
      const extProvider = win.coinbaseWalletExtension as
        | ProviderInterface
        | undefined;
      if (extProvider && extProvider === provider) {
        return "extension";
      }
    }

    // Check for Smart Wallet
    if (this.config.preference === "smartWalletOnly") {
      return "smart-wallet";
    }

    return "walletlink";
  }

  /**
   * Set up event listeners on the provider to handle wallet-side changes.
   */
  private setupEventListeners(provider: ProviderInterface): void {
    if (!this.providerAdapter) {
      this.providerAdapter = new CoinbaseProviderAdapter(provider);
    }

    this.providerAdapter.on("accountsChanged", (accounts: unknown) => {
      const accs = accounts as string[];
      if (accs.length === 0) {
        // All accounts disconnected
        this.sessionExpiryHandler?.();
      } else if (this.lastSession) {
        // Update accounts in the session
        const chainId = this.getDefaultChainId(this.lastSession);
        this.lastSession.namespaces.eip155 = {
          ...this.lastSession.namespaces.eip155,
          accounts: accs.map((a) => `${chainId}:${a}`),
        };
        this.lastSession.updatedAt = new Date().toISOString();
      }
    });

    this.providerAdapter.on("chainChanged", (chainId: unknown) => {
      if (this.lastSession) {
        const hexChainId = chainId as string;
        const chainIdNum = Number.parseInt(hexChainId, 16);
        const caip2ChainId = `eip155:${chainIdNum}`;

        // Update the session namespaces with the new chain
        const existingAccounts =
          this.lastSession.namespaces.eip155?.accounts ?? [];

        this.lastSession.namespaces.eip155 = {
          ...this.lastSession.namespaces.eip155,
          chains: [caip2ChainId],
          accounts: existingAccounts.map((a) => {
            const parts = a.split(":");
            return parts.length >= 3
              ? `${caip2ChainId}:${parts[2]}`
              : `${caip2ChainId}:${parts[0]}`;
          }),
        };

        this.lastSession.updatedAt = new Date().toISOString();
      }
    });

    this.providerAdapter.on("disconnect", () => {
      this.sessionExpiryHandler?.();
      this.cleanup();
    });
  }

  /**
   * Clean up provider adapter and SDK state.
   */
  private cleanup(): void {
    if (this.providerAdapter) {
      this.providerAdapter.cleanup();
      this.providerAdapter = undefined;
    }
    this.sdk = undefined;
    this.lastSession = undefined;
    this.connectionMode = undefined;
  }

  /**
   * Get the default chain ID from the session.
   */
  private getDefaultChainId(session: UniversalWalletSession): string {
    const evmNamespace = session.namespaces["eip155"];
    if (evmNamespace && evmNamespace.chains.length > 0) {
      return evmNamespace.chains[0];
    }

    return EIP155_MAINNET;
  }

  /**
   * Hex-encode a string for Ethereum JSON-RPC methods.
   */
  private hexEncode(message: string): `0x${string}` {
    if (/^0x[0-9a-fA-F]*$/.test(message)) return message as `0x${string}`;

    const bytes = new TextEncoder().encode(message);
    let hex = "0x";
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex as `0x${string}`;
  }
}

/**
 * Create a CoinbaseConnector instance.
 */
export function createCoinbaseConnector(
  config: CoinbaseConnectorConfig,
): CoinbaseConnector {
  return new CoinbaseConnector(config);
}

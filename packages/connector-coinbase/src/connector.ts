import type { Preference, ProviderInterface } from "@coinbase/wallet-sdk";
import { CoinbaseWalletSDK } from "@coinbase/wallet-sdk";
import type {
  BatchCall,
  ConnectorSupport,
  SendCallsOptions,
  UniversalConnector,
  UniversalWalletSession,
  WalletCapabilities,
} from "@naculus/connect-core";
import {
  CONNECTOR_ERROR_MESSAGES,
  caip2ToHexChain,
  createEmptySession,
  DEFAULT_RPC_URLS,
  detectPlatform,
  extractAccounts,
  hexEncode,
  normalizeEip5792Capabilities,
  WalletError,
} from "@naculus/connect-core";
import { CoinbaseProviderAdapter } from "./provider";
import type {
  CoinbaseConnectionMode,
  CoinbaseConnectorConfig,
  CoinbaseSession,
} from "./types";

function requireEvmAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new WalletError(
      "invalid_input",
      `${field} must be a 20-byte EVM address.`,
    );
  }
  return value;
}

function normalizeHexData(value: unknown, field: string): string {
  if (value === undefined) return "0x";
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new WalletError(
      "invalid_input",
      `${field} must be even-length hexadecimal.`,
    );
  }
  return value;
}

function normalizeQuantity(value: unknown, field: string): string {
  if (typeof value === "number" || typeof value === "bigint") {
    if (
      (typeof value === "number" &&
        (!Number.isSafeInteger(value) || value < 0)) ||
      (typeof value === "bigint" && value < 0n)
    ) {
      throw new WalletError(
        "invalid_input",
        `${field} must be a non-negative safe EIP-1474 quantity.`,
      );
    }
    return `0x${BigInt(value).toString(16)}`;
  }
  if (typeof value !== "string") {
    throw new WalletError(
      "invalid_input",
      `${field} must be an EIP-1474 quantity.`,
    );
  }
  if (/^0x[0-9a-fA-F]+$/.test(value) || /^\d+$/.test(value)) {
    const quantity = BigInt(value);
    return `0x${quantity.toString(16)}`;
  }
  throw new WalletError(
    "invalid_input",
    `${field} must be an EIP-1474 quantity.`,
  );
}

function normalizeEvmTransaction(
  transaction: Record<string, unknown>,
  fallbackFrom?: string,
  expectedChainId?: string,
): Record<string, unknown> {
  if (
    (transaction.to === undefined || transaction.to === null) &&
    transaction.data === undefined
  ) {
    throw new WalletError(
      "invalid_input",
      "Transaction must include a 20-byte 'to' address or contract-creation data.",
    );
  }
  const normalized = { ...transaction };
  normalized.from =
    transaction.from === undefined
      ? fallbackFrom
        ? requireEvmAddress(fallbackFrom, "from")
        : undefined
      : requireEvmAddress(transaction.from, "from");
  if (normalized.from === undefined) delete normalized.from;
  if (transaction.to !== undefined && transaction.to !== null) {
    normalized.to = requireEvmAddress(transaction.to, "to");
  } else if (transaction.to === null) {
    delete normalized.to;
  }
  if (transaction.data !== undefined)
    normalized.data = normalizeHexData(transaction.data, "data");
  for (const field of [
    "chainId",
    "gas",
    "gasLimit",
    "gasPrice",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "nonce",
    "value",
  ]) {
    if (normalized[field] !== undefined)
      normalized[field] = normalizeQuantity(normalized[field], field);
  }
  if (expectedChainId && normalized.chainId !== undefined) {
    if (!/^eip155:[1-9][0-9]*$/.test(expectedChainId)) {
      throw new WalletError(
        "chain_unsupported",
        `Invalid session EVM chain ID: ${expectedChainId}.`,
      );
    }
    const expected = normalizeQuantity(
      expectedChainId.slice("eip155:".length),
      "chainId",
    );
    if (normalized.chainId !== expected) {
      throw new WalletError(
        "invalid_input",
        "Transaction chainId does not match the connected Coinbase chain.",
      );
    }
  }
  if (
    normalized.maxFeePerGas !== undefined &&
    normalized.maxPriorityFeePerGas !== undefined &&
    BigInt(normalized.maxPriorityFeePerGas as string) >
      BigInt(normalized.maxFeePerGas as string)
  ) {
    throw new WalletError(
      "invalid_input",
      "maxPriorityFeePerGas cannot exceed maxFeePerGas.",
    );
  }
  return normalized;
}

function requireEvmAccount(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new WalletError("invalid_input", `${field} must be an EVM account.`);
  }
  if (!value.includes(":")) return requireEvmAddress(value, field);
  const parts = value.split(":");
  if (
    parts.length !== 3 ||
    parts[0] !== "eip155" ||
    !/^[1-9][0-9]*$/.test(parts[1] ?? "")
  ) {
    throw new WalletError(
      "invalid_input",
      `${field} must use a canonical eip155 CAIP-10 account.`,
    );
  }
  return requireEvmAddress(parts[2], field);
}

/** Select the account explicitly approved for a requested EIP-155 chain. */
function accountForChain(
  accounts: string[],
  chainId: string,
): string | undefined {
  const reference = chainId.startsWith("eip155:")
    ? chainId.slice("eip155:".length)
    : undefined;
  const candidate = accounts.find((account) => {
    if (typeof account !== "string") return false;
    if (!account.includes(":")) return reference !== undefined;
    const parts = account.split(":");
    return (
      parts.length === 3 && parts[0] === "eip155" && parts[1] === reference
    );
  });
  return candidate ? requireEvmAccount(candidate, "account") : undefined;
}

function assertSessionTransactionFrom(
  transaction: Record<string, unknown>,
  accounts: string[],
): void {
  if (transaction.from === undefined) return;
  const requested = requireEvmAccount(transaction.from, "from").toLowerCase();
  const allowed = accounts.some((account) => {
    try {
      return requireEvmAccount(account, "account").toLowerCase() === requested;
    } catch {
      return false;
    }
  });
  if (!allowed) {
    throw new WalletError(
      "invalid_input",
      "Transaction 'from' must be one of the connected Coinbase accounts.",
    );
  }
}

function isUnsupportedSendCallsError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === -32601 || code === -32004 || code === 4200) return true;
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("method not found") ||
    normalized.includes("not supported") ||
    normalized.includes("unsupported")
  );
}

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
  private readonly accountsSubscribers = new Set<
    (accounts: string[]) => void
  >();
  private readonly chainSubscribers = new Set<(chainId: string) => void>();

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

    // Replacing the adapter without cleaning it up first discarded its record
    // of what was attached while leaving the handlers on the provider. Every
    // connect() then added another set that nothing could ever detach, so one
    // wallet event was reported once per connect that had happened.
    this.providerAdapter?.cleanup();
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

      if (
        !Array.isArray(accounts) ||
        accounts.length === 0 ||
        accounts.some((account) => !/^0x[0-9a-fA-F]{40}$/.test(account))
      ) {
        throw new WalletError(
          "user_rejected",
          "No accounts returned from Coinbase Wallet.",
        );
      }

      const chainIdHex = (await provider.request({
        method: "eth_chainId",
      })) as string;

      if (
        typeof chainIdHex !== "string" ||
        !/^0x[0-9a-fA-F]+$/.test(chainIdHex)
      ) {
        throw new WalletError(
          "rpc_error",
          "Coinbase Wallet returned an invalid chain ID.",
        );
      }
      const chainIdNum = Number(BigInt(chainIdHex));
      if (!Number.isSafeInteger(chainIdNum) || chainIdNum <= 0) {
        throw new WalletError(
          "rpc_error",
          "Coinbase Wallet returned an unsupported chain ID.",
        );
      }

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
      if (error instanceof WalletError) throw error;
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
      let accounts: unknown;
      try {
        const provider = this.providerAdapter.getProvider();
        accounts = await provider.request({
          method: "eth_accounts",
        });
      } catch (error) {
        // Never return stale session accounts when the live provider cannot be
        // queried: doing so could make callers sign for an account that is no
        // longer connected in the wallet.
        throw new WalletError(
          "wallet_unavailable",
          "Failed to query Coinbase Wallet accounts.",
          error,
        );
      }

      if (!Array.isArray(accounts)) {
        throw new WalletError(
          "wallet_unavailable",
          "Coinbase Wallet returned an invalid account list.",
          accounts,
        );
      }

      return accounts.map((account) => requireEvmAddress(account, "account"));
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

    assertSessionTransactionFrom(
      { from: rawAddress },
      session.namespaces.eip155?.accounts ?? [],
    );
    const address = requireEvmAccount(rawAddress, "address");

    // Determine signing method based on message content
    const isStructured = message.trimStart().startsWith("{");
    // eth_sign is deliberately absent: it signs an arbitrary 32-byte digest,
    // which can be a transaction hash, and no current wallet needs it as a
    // personal_sign fallback. A wallet that refuses personal_sign fails here.
    const tryMethods = isStructured
      ? ["eth_signTypedData_v4"]
      : ["personal_sign"];

    let lastError: unknown;
    for (const tryMethod of tryMethods) {
      let params: unknown[];
      if (tryMethod === "personal_sign") {
        params = [hexEncode(message), address];
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
    assertSessionTransactionFrom(
      transaction,
      session.namespaces.eip155?.accounts ?? [],
    );

    try {
      return await provider.request({
        method: "eth_signTransaction",
        params: [
          normalizeEvmTransaction(
            transaction,
            accountForChain(
              session.namespaces.eip155?.accounts ?? [],
              this.getDefaultChainId(session),
            ),
            this.getDefaultChainId(session),
          ),
        ],
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
    assertSessionTransactionFrom(
      transaction,
      session.namespaces.eip155?.accounts ?? [],
    );

    try {
      return await provider.request({
        method: "eth_sendTransaction",
        params: [
          normalizeEvmTransaction(
            transaction,
            accountForChain(
              session.namespaces.eip155?.accounts ?? [],
              this.getDefaultChainId(session),
            ),
            this.getDefaultChainId(session),
          ),
        ],
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
    if (!/^eip155:[1-9][0-9]*$/.test(chainId)) {
      throw new WalletError(
        "chain_unsupported",
        "Coinbase connector only supports EVM chains.",
      );
    }

    const numericChainId = chainId.split(":")[1];
    let hexChainId: string;
    try {
      const numeric = BigInt(numericChainId);
      if (numeric <= 0n) throw new Error("chain ID must be positive");
      hexChainId = `0x${numeric.toString(16)}`;
    } catch {
      throw new WalletError(
        "chain_unsupported",
        `Invalid EVM chain ID: ${chainId}.`,
      );
    }

    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hexChainId }],
      });
      const normalizedChainId = `eip155:${BigInt(numericChainId).toString(10)}`;
      const namespace = session.namespaces.eip155;
      if (namespace) {
        namespace.chains = [normalizedChainId];
        namespace.accounts = namespace.accounts.map((account) => {
          const address = requireEvmAccount(account, "account");
          return `${normalizedChainId}:${address}`;
        });
      }
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
    options?: SendCallsOptions,
  ): Promise<string> {
    const provider = this.requireProvider();
    if (!Array.isArray(calls) || calls.length === 0) {
      throw new WalletError("invalid_input", "At least one call is required.");
    }
    const resolvedChainId = chainId ?? this.getDefaultChainId(session);
    if (!/^eip155:[1-9][0-9]*$/.test(resolvedChainId)) {
      throw new WalletError(
        "chain_unsupported",
        "Coinbase wallet_sendCalls only supports EVM chains.",
      );
    }
    if (!session.namespaces.eip155?.chains.includes(resolvedChainId)) {
      throw new WalletError(
        "chain_unsupported",
        `Chain ${resolvedChainId} is not approved for this Coinbase session.`,
      );
    }
    const chainHex = `0x${BigInt(resolvedChainId.slice("eip155:".length)).toString(16)}`;
    const accounts = session.namespaces.eip155?.accounts ?? [];
    const fromAccount = accountForChain(accounts, resolvedChainId);
    if (!fromAccount) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.NO_ACCOUNT_TX,
      );
    }

    try {
      const result = await provider.request({
        method: "wallet_sendCalls",
        params: [
          {
            version: "2.0.0",
            from: requireEvmAddress(fromAccount, "from"),
            chainId: chainHex,
            atomicRequired: options?.atomicRequired === true,
            ...(options?.paymasterService
              ? {
                  capabilities: {
                    paymasterService: {
                      url: options.paymasterService.url,
                      context: options.paymasterService.context ?? {},
                    },
                  },
                }
              : {}),
            calls: calls.map((call) => {
              const tx = normalizeEvmTransaction(
                call as unknown as Record<string, unknown>,
              );
              return {
                to: tx.to,
                value: tx.value,
                data: tx.data,
              };
            }),
          },
        ],
      });
      if (typeof result === "string") return result;
      if (
        result &&
        typeof result === "object" &&
        typeof (result as { id?: unknown }).id === "string"
      ) {
        return (result as { id: string }).id;
      }
      throw new WalletError(
        "rpc_error",
        "wallet_sendCalls returned no bundle identifier.",
      );
    } catch (error) {
      if (!isUnsupportedSendCallsError(error)) throw error;
      // Sending the calls one at a time is exactly the partial execution the
      // caller ruled out, and it would be indistinguishable from success.
      if (options?.atomicRequired || options?.paymasterService) throw error;
      // Fallback: send each call individually
      const txHashes: string[] = [];
      for (const call of calls) {
        const hash = (await provider.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: requireEvmAddress(fromAccount, "from"),
              ...normalizeEvmTransaction(
                call as unknown as Record<string, unknown>,
              ),
            },
          ],
        })) as string;
        txHashes.push(hash);
      }

      return txHashes.length === 1 ? txHashes[0] : txHashes.join(",");
    }
  }

  /**
   * EIP-5792 `wallet_showCallsStatus`.
   *
   * Display request only; a refusal is cosmetic and leaves the bundle alone.
   */
  async showCallsStatus(
    _session: UniversalWalletSession,
    bundleHash: string,
  ): Promise<void> {
    const provider = this.requireProvider();
    try {
      await provider.request({
        method: "wallet_showCallsStatus",
        params: [bundleHash],
      });
    } catch (error) {
      if (isUnsupportedSendCallsError(error)) {
        throw new WalletError(
          "method_unsupported",
          "This wallet cannot display call status. The bundle is unaffected.",
          error,
        );
      }
      throw error;
    }
  }

  /**
   * EIP-5792 `wallet_getCapabilities` for the connected session.
   *
   * Asks the provider. This previously only read a non-standard `capabilities`
   * key off the session namespace and reported `supported: false` for every
   * chain when it was absent — which is every session, since nothing populates
   * that key for Coinbase. Coinbase Smart Wallet is one of the reference
   * EIP-5792 implementations, so the invented "no" was wrong for exactly the
   * wallet this connector exists to serve.
   *
   * A failed query propagates rather than becoming a negative answer, so
   * `getAccountCapabilities` can report `discovered: false`.
   */
  async getCapabilities(
    session: UniversalWalletSession,
  ): Promise<Record<string, WalletCapabilities>> {
    const provider = this.requireProvider();
    const chains = session.namespaces.eip155?.chains ?? [];
    if (chains.length === 0) {
      throw new WalletError(
        "chain_unsupported",
        "wallet_getCapabilities applies to EVM chains; this session has none.",
      );
    }
    const accounts = session.namespaces.eip155?.accounts ?? [];
    const account = accountForChain(accounts, chains[0]);
    if (!account) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.NO_ACCOUNT_TX,
      );
    }

    const hexChains: string[] = [];
    for (const chain of chains) {
      const hex = caip2ToHexChain(chain);
      if (hex) hexChains.push(hex);
    }

    const result = await provider.request({
      method: "wallet_getCapabilities",
      // The address and the chains being asked about. Omitting the second
      // argument is not portable across wallets.
      params: [requireEvmAddress(account, "account"), hexChains],
    });

    return normalizeEip5792Capabilities(result);
  }

  /**
   * UniversalConnector.onAccountsChanged.
   *
   * This connector already re-keyed the session on both provider events; it
   * had no way to say so, so nothing downstream ever learned about an
   * in-wallet switch.
   */
  onAccountsChanged(
    _session: UniversalWalletSession,
    handler: (accounts: string[]) => void,
  ): () => void {
    this.accountsSubscribers.add(handler);
    return () => {
      this.accountsSubscribers.delete(handler);
    };
  }

  /** UniversalConnector.onChainChanged. */
  onChainChanged(
    _session: UniversalWalletSession,
    handler: (chainId: string) => void,
  ): () => void {
    this.chainSubscribers.add(handler);
    return () => {
      this.chainSubscribers.delete(handler);
    };
  }

  private notifyAccountsChanged(accounts: string[]): void {
    for (const subscriber of [...this.accountsSubscribers]) {
      try {
        subscriber(accounts);
      } catch {
        // One bad subscriber must not stop the others from being told.
      }
    }
  }

  private notifyChainChanged(chainId: string): void {
    for (const subscriber of [...this.chainSubscribers]) {
      try {
        subscriber(chainId);
      } catch {
        // One bad subscriber must not stop the others from being told.
      }
    }
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
    if (!/^eip155:[1-9][0-9]*$/.test(cId)) {
      throw new WalletError(
        "chain_unsupported",
        `Invalid EVM chain ID: ${cId}`,
      );
    }
    const rpcUrl = this.config.overrideRpcUrl?.[cId] ?? DEFAULT_RPC_URLS[cId];
    if (!rpcUrl)
      throw new WalletError("chain_unsupported", "No RPC URL for chain " + cId);

    const address = accountForChain(
      session.namespaces.eip155?.accounts ??
        extractAccounts(session.namespaces),
      cId,
    );
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
    if (!response.ok) {
      throw new WalletError(
        "rpc_error",
        `RPC returned HTTP ${response.status} while reading the balance.`,
      );
    }
    const data = await response.json();
    if (typeof data.result !== "string") {
      throw new WalletError("rpc_error", "RPC returned no balance result.");
    }
    if (!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(data.result)) {
      throw new WalletError(
        "rpc_error",
        "RPC returned a non-canonical eth_getBalance quantity.",
      );
    }
    return normalizeQuantity(data.result, "balance");
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

    // This runs on every connect(). The adapter dedupes by handler identity,
    // but the handlers below are fresh closures each time, so nothing was ever
    // deduped: a second connect left two live handlers per event and reported
    // one wallet change twice. Detach first.
    this.providerAdapter.removeAllListeners();

    this.providerAdapter.on("accountsChanged", (accounts: unknown) => {
      if (!Array.isArray(accounts)) {
        this.sessionExpiryHandler?.();
        return;
      }
      if (accounts.length === 0) {
        // All accounts disconnected
        this.sessionExpiryHandler?.();
        // An empty list is the disconnect signal in the shared contract.
        this.notifyAccountsChanged([]);
      } else if (this.lastSession) {
        try {
          const accs = accounts.map((account) =>
            requireEvmAddress(account, "account"),
          );
          // Update accounts in the session only after every provider value is
          // validated, so one malformed event cannot partially corrupt state.
          const chainId = this.getDefaultChainId(this.lastSession);
          this.lastSession.namespaces.eip155 = {
            ...this.lastSession.namespaces.eip155,
            accounts: accs.map((a) => `${chainId}:${a}`),
          };
          this.lastSession.updatedAt = new Date().toISOString();
          this.notifyAccountsChanged(
            this.lastSession.namespaces.eip155?.accounts ?? [],
          );
        } catch {
          this.sessionExpiryHandler?.();
        }
      }
    });

    this.providerAdapter.on("chainChanged", (chainId: unknown) => {
      if (this.lastSession) {
        const hexChainId = chainId as string;
        if (!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(hexChainId)) return;
        const chainIdValue = BigInt(hexChainId);
        if (
          chainIdValue <= 0n ||
          chainIdValue > BigInt(Number.MAX_SAFE_INTEGER)
        )
          return;
        const caip2ChainId = `eip155:${chainIdValue.toString(10)}`;

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
        this.notifyChainChanged(caip2ChainId);
        // A chain change re-keys every CAIP-10 account, so accounts
        // subscribers need telling even though the addresses did not change.
        this.notifyAccountsChanged(
          this.lastSession.namespaces.eip155?.accounts ?? [],
        );
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
    const evmNamespace = session.namespaces.eip155;
    if (evmNamespace && evmNamespace.chains.length > 0) {
      return evmNamespace.chains[0];
    }

    throw new WalletError(
      "chain_unsupported",
      "Session does not contain a supported EIP-155 chain.",
    );
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

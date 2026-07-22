/**
 * SafeConnector — UniversalConnector implementation for Safe (Gnosis Safe)
 *
 * This connector wraps @safe-global/safe-apps-sdk into the @naculus/connect-core
 * UniversalConnector interface. It is designed exclusively for the Safe App
 * iframe environment — the page MUST be running inside a Safe interface.
 *
 * Key design differences from other connectors:
 * - Transactions are **submitted** to Safe (multi-sig queue), not sent on-chain
 * - Returns `safeTxHash` instead of a regular transaction hash
 * - Native support for batch transactions (multiple calls in one signing flow)
 * - No direct chain switching — Safe determines the chain
 * - No reconnect — a new SDK instance is created on page load
 */

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
  detectPlatform,
  extractAccounts,
  WalletError,
} from "@naculus/connect-core";
import type { SafeInfoExtended } from "@safe-global/safe-apps-sdk";
import SafeAppsSDK from "@safe-global/safe-apps-sdk";
import { isInIframe } from "./environment";
import type {
  SafeConnectorConfig,
  SafeTransactionRequest,
  SafeTransactionResponse,
} from "./types";

/** Safe Connector is always desktop-only — it runs inside a Safe App iframe */
const SUPPORT: ConnectorSupport = {
  desktop: true,
  mobile: false,
  deepLink: false,
  qr: false,
  trustedReconnect: false,
};

/**
 * SafeConnector implementation.
 *
 * @example
 * ```typescript
 * import { SafeConnector } from "@naculus/connector-safe";
 *
 * const connector = new SafeConnector();
 * if (connector.isAvailable) {
 *   const session = await connector.connect();
 * }
 * ```
 */
export class SafeConnector implements UniversalConnector {
  readonly id = "safe";
  readonly name = "Safe (Gnosis Safe)";
  readonly kind = "safe" as const;
  readonly namespaces = ["eip155"];
  readonly supports = SUPPORT;

  private sdk: SafeAppsSDK | null = null;
  private safeInfoInternal: SafeInfoExtended | null = null;
  private available: boolean = false;
  private lastSession: UniversalWalletSession | null = null;

  constructor(
    private readonly config: SafeConnectorConfig = {},
    /** @internal — allow test injection of availability override */
    isAvailableOverride?: boolean,
  ) {
    this.available = isAvailableOverride ?? this.detectAvailability();
    if (this.available) {
      this.initializeSdk();
    }
  }

  // ── Public Properties ────────────────────────────────────────

  /**
   * Whether the Safe Connector is available.
   * Only `true` when the page is running inside a Safe App iframe.
   */
  get isAvailable(): boolean {
    return this.available;
  }

  /** The initialized Safe Apps SDK instance (null if unavailable or not initialized) */
  get sdkInstance(): SafeAppsSDK | null {
    return this.sdk;
  }

  // ── UniversalConnector Implementation ─────────────────────────

  async connect(): Promise<UniversalWalletSession> {
    if (!this.available || !this.sdk) {
      throw new WalletError(
        "wallet_unavailable",
        "Safe App environment not detected.",
      );
    }

    try {
      const safeInfo = await this.sdk.safe.getInfo();
      this.safeInfoInternal = safeInfo;

      const chainId = `eip155:${safeInfo.chainId}`;
      const safeAddress = safeInfo.safeAddress as `0x${string}`;

      const session = createEmptySession({
        id: `safe-${safeAddress}-${Date.now()}`,
        walletId: safeAddress,
        walletType: "safe",
        namespaces: {
          eip155: {
            chains: [chainId],
            accounts: [`${chainId}:${safeAddress}`],
            methods: [
              "eth_sendTransaction",
              "eth_sign",
              "personal_sign",
              "eth_signTypedData",
              "eth_signTypedData_v4",
            ],
            events: ["chainChanged", "accountsChanged"],
            capabilities: {
              atomicBatch: { supported: true, maxBatchSize: 100 },
            },
          },
        },
        platform: detectPlatform(),
      });

      this.lastSession = session;
      return session;
    } catch (error) {
      throw new WalletError(
        "wallet_unavailable",
        "Failed to get Safe info. Is this running inside a Safe App?",
        error,
      );
    }
  }

  async reconnect(
    _session: UniversalWalletSession,
  ): Promise<UniversalWalletSession> {
    if (!this.available || !this.sdk) {
      throw new WalletError(
        "session_expired",
        "Safe App environment not detected. Please reload the Safe App.",
      );
    }

    // Safe cannot really reconnect without reloading the iframe.
    // Instead, we re-query the Safe info and return a fresh session.
    return this.connect();
  }

  async disconnect(): Promise<void> {
    // Safe connection is scoped to the iframe lifecycle.
    // There is no explicit "disconnect" in Safe Apps — the connection
    // ends when the iframe is unloaded.
    this.safeInfoInternal = null;
    this.lastSession = null;
    // Note: the SDK becomes stale; the instance will be recreated on next connect.
  }

  async getAccounts(session: UniversalWalletSession): Promise<string[]> {
    if (this.safeInfoInternal) {
      const chainId = `eip155:${this.safeInfoInternal.chainId}`;
      return [`${chainId}:${this.safeInfoInternal.safeAddress}`];
    }
    return extractAccounts(session.namespaces);
  }

  async signMessage(
    _session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    if (!this.sdk) {
      throw new WalletError("wallet_unavailable", "Safe SDK not initialized.");
    }

    const inputObj = input as Record<string, unknown>;
    const message =
      typeof inputObj.message === "string" ? inputObj.message : undefined;
    if (!message) {
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.MISSING_MESSAGE,
      );
    }

    try {
      // In Safe SDK v9, signMessage is on this.sdk.txs.signMessage
      const signature = await this.sdk.txs.signMessage(message);
      return signature;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message.toLowerCase() : "";
      if (errMsg.includes("reject") || errMsg.includes("denied")) {
        throw new WalletError(
          "signature_rejected",
          "Message signing rejected by user.",
          error,
        );
      }
      throw new WalletError(
        "signature_rejected",
        "Safe signMessage failed.",
        error,
      );
    }
  }

  async signTransaction(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    // The Safe SDK doesn't expose a standalone signTransaction.
    // Transactions are submitted to the Safe queue via send/approve flow.
    // We delegate to sendTransaction for the Safe SDK's flow.
    return this.sendTransaction(session, input);
  }

  async sendTransaction(
    _session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    if (!this.sdk) {
      throw new WalletError("wallet_unavailable", "Safe SDK not initialized.");
    }

    const inputObj = input as Record<string, unknown>;
    const tx = inputObj.transaction as SafeTransactionRequest | undefined;
    if (!tx) {
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.MISSING_TX,
      );
    }

    try {
      // BaseTransaction (from Safe SDK) only accepts to/value/data.
      // Extra Safe-specific params (operation, gas fields) go through
      // SendTransactionRequestParams.
      const response = await this.sdk.txs.send({
        txs: [
          {
            to: tx.to,
            value: tx.value,
            data: tx.data,
          },
        ],
        params: {
          safeTxGas: tx.safeTxGas,
        },
      });

      const safeTxResponse: SafeTransactionResponse = {
        safeTxHash: response.safeTxHash as `0x${string}`,
      };
      return safeTxResponse;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message.toLowerCase() : "";
      if (errMsg.includes("reject") || errMsg.includes("denied")) {
        throw new WalletError(
          "user_rejected",
          "Transaction rejected by Safe signer.",
          error,
        );
      }
      throw new WalletError(
        "tx_failed",
        "Safe transaction submission failed.",
        error,
      );
    }
  }

  async switchChain(
    _session: UniversalWalletSession,
    _chainId: string,
  ): Promise<void> {
    // Safe determines the chain — clients cannot switch chains programmatically.
    throw new WalletError(
      "method_unsupported",
      "Safe Connector cannot switch chains. The Safe interface determines the active chain.",
    );
  }

  async sendCalls(
    _session: UniversalWalletSession,
    calls: BatchCall[],
    _chainId?: string,
  ): Promise<string> {
    if (!this.sdk) {
      throw new WalletError("wallet_unavailable", "Safe SDK not initialized.");
    }

    try {
      const safeTxs = calls.map((call) => ({
        to: call.to,
        value: call.value ?? "0",
        data: call.data ?? "0x",
      }));

      const response = await this.sdk.txs.send({ txs: safeTxs });
      return response.safeTxHash;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message.toLowerCase() : "";
      if (errMsg.includes("reject") || errMsg.includes("denied")) {
        throw new WalletError(
          "user_rejected",
          "Batch transaction rejected by Safe signer.",
          error,
        );
      }
      throw new WalletError(
        "tx_failed",
        "Safe batch transaction submission failed.",
        error,
      );
    }
  }

  async getCapabilities(
    _session: UniversalWalletSession,
  ): Promise<Record<string, WalletCapabilities>> {
    // Safe supports atomic batch natively.
    // The capabilities are static since Safe always supports this.
    const chainId = this.safeInfoInternal
      ? `eip155:${this.safeInfoInternal.chainId}`
      : "eip155:1";

    return {
      [chainId]: {
        atomicBatch: { supported: true, maxBatchSize: 100 },
      },
    };
  }

  // ── Safe-Specific Methods ─────────────────────────────────────

  /** Get Safe environment information */
  async getSafeInfo(): Promise<{
    isSafeApp: boolean;
    safeAddress?: `0x${string}`;
    chainId?: number;
    owners?: `0x${string}`[];
    threshold?: number;
    version?: string;
    implementation?: `0x${string}`;
  }> {
    if (!this.available) {
      return { isSafeApp: false };
    }

    if (this.safeInfoInternal) {
      return {
        isSafeApp: true,
        safeAddress: this.safeInfoInternal.safeAddress as `0x${string}`,
        chainId: this.safeInfoInternal.chainId,
        owners: this.safeInfoInternal.owners as `0x${string}`[],
        threshold: this.safeInfoInternal.threshold,
        version: this.safeInfoInternal.version ?? undefined,
        implementation: (this.safeInfoInternal.implementation ?? undefined) as
          | `0x${string}`
          | undefined,
      };
    }

    // Fetch if not cached
    if (this.sdk) {
      try {
        const info = await this.sdk.safe.getInfo();
        this.safeInfoInternal = info;
        return {
          isSafeApp: true,
          safeAddress: info.safeAddress as `0x${string}`,
          chainId: info.chainId,
          owners: info.owners as `0x${string}`[],
          threshold: info.threshold,
          version: info.version ?? undefined,
          implementation: (info.implementation ?? undefined) as
            | `0x${string}`
            | undefined,
        };
      } catch {
        return { isSafeApp: false };
      }
    }

    return { isSafeApp: false };
  }

  /**
   * Submit a batch of transactions for Safe multi-sig signing.
   *
   * @param _session - The current wallet session
   * @param txs - Array of Safe transaction requests
   * @returns The safeTxHash for the batch
   */
  async sendTransactions(
    _session: UniversalWalletSession,
    txs: SafeTransactionRequest[],
  ): Promise<SafeTransactionResponse> {
    if (!this.sdk) {
      throw new WalletError("wallet_unavailable", "Safe SDK not initialized.");
    }

    if (txs.length === 0) {
      throw new WalletError(
        "invalid_input",
        "At least one transaction is required.",
      );
    }

    try {
      const safeTxs = txs.map((tx) => ({
        to: tx.to,
        value: tx.value,
        data: tx.data,
      }));

      const response = await this.sdk.txs.send({
        txs: safeTxs,
        params: {
          safeTxGas: txs[0].safeTxGas,
        },
      });
      return { safeTxHash: response.safeTxHash as `0x${string}` };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message.toLowerCase() : "";
      if (errMsg.includes("reject") || errMsg.includes("denied")) {
        throw new WalletError(
          "user_rejected",
          "Batch transactions rejected by Safe signer.",
          error,
        );
      }
      throw new WalletError(
        "tx_failed",
        "Safe batch transaction submission failed.",
        error,
      );
    }
  }

  /**
   * Sign typed data (EIP-712) via the Safe SDK.
   *
   * @param _session - The current wallet session
   * @param typedData - The typed data object (EIP-712 format)
   * @returns The signature string
   */
  async signTypedData(
    _session: UniversalWalletSession,
    typedData: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.sdk) {
      throw new WalletError("wallet_unavailable", "Safe SDK not initialized.");
    }

    try {
      // In Safe SDK v9, signTypedMessage is on this.sdk.txs.signTypedMessage.
      // The SDK's EIP712TypedData type has: domain, types, message, primaryType?
      const signature = await this.sdk.txs.signTypedMessage(typedData as any);
      return signature;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message.toLowerCase() : "";
      if (errMsg.includes("reject") || errMsg.includes("denied")) {
        throw new WalletError(
          "signature_rejected",
          "Typed data signing rejected by user.",
          error,
        );
      }
      throw new WalletError(
        "signature_rejected",
        "Safe signTypedMessage failed.",
        error,
      );
    }
  }

  // ── Private Helpers ───────────────────────────────────────────

  /**
   * Detect whether we can initialize the Safe SDK.
   * The connector is available iff:
   *   1. We're in a browser environment
   *   2. We're in an iframe (window !== window.top)
   */
  private detectAvailability(): boolean {
    return isInIframe();
  }

  /**
   * Initialize the Safe Apps SDK.
   * Safe to call even in non-Safe environments — the SDK will
   * simply fail to communicate with the parent frame.
   */
  private initializeSdk(): void {
    try {
      this.sdk = new SafeAppsSDK(this.config.sdkOptions);
    } catch {
      this.available = false;
    }
  }
}

/** Factory function for creating a SafeConnector */
export function createSafeConnector(
  config?: SafeConnectorConfig,
): SafeConnector {
  return new SafeConnector(config);
}

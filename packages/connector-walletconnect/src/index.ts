import type {
  BatchCall,
  Namespace,
  SessionNamespace,
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
  WC_DISCONNECT_USER,
} from "@naculus/connect-core";
import { base58 } from "@scure/base";
import SignClient from "@walletconnect/sign-client";
import type { ProposalTypes } from "@walletconnect/types";
import { type CAIP25NamespaceProposal, validateCAIP25Proposal } from "./caip25";
import {
  buildRequiredNamespaces,
  extractAddress,
  isValidCAIP10,
  mapNamespaces,
  parseCAIP10,
  toHexValue,
  type WalletConnectConfig,
} from "./namespaces";

export type {
  WalletConnectConfig,
  WalletConnectConnectInput,
  WalletConnectMetadata,
} from "./namespaces";
export {
  buildRequiredNamespaces,
  extractAddress,
  isValidCAIP10,
  mapNamespaces,
  parseCAIP10,
  toHexValue,
} from "./namespaces";

/**
 * WalletConnect v2 Connector for connect SDK
 *
 * Supports EVM chains and Solana through WalletConnect's multi-chain namespace.
 * Provides QR code pairing for desktop and deep link support for mobile.
 *
 * @example
 * ```typescript
 * const connector = new WalletConnectConnector({
 *   projectId: process.env.VITE_WALLETCONNECT_PROJECT_ID,
 *   metadata: {
 *     name: "My DApp",
 *     description: "Connect to My DApp",
 *     url: window.location.origin,
 *     icons: [window.location.origin + "/icon.png"]
 *   }
 * });
 * ```
 */
export class WalletConnectConnector implements UniversalConnector {
  /** Unique connector identifier */
  readonly id = "walletconnect";

  /** Display name for UI */
  readonly name = "WalletConnect";

  /** Connector type identifier */
  readonly kind: "walletconnect" = "walletconnect";

  /** Supported chain namespaces */
  readonly namespaces = ["eip155", "solana"];

  /** Feature support flags */
  readonly supports = {
    desktop: true,
    mobile: true,
    deepLink: true,
    qr: true,
    trustedReconnect: true,
  } as const;

  /** Connector configuration */
  readonly config: WalletConnectConfig;

  private client: SignClient | undefined;
  private lastSession?: UniversalWalletSession;
  private lastUri?: string;
  private pendingApproval?: () => Promise<UniversalWalletSession>;
  private sessionExpiryHandler?: () => void;

  constructor(config: WalletConnectConfig) {
    this.config = config;
    this.client = config.client;
  }

  private async getClient(): Promise<SignClient> {
    if (this.client) {
      return this.client;
    }

    this.client = await SignClient.init({
      projectId: this.config.projectId,
      relayUrl: this.config.relayUrl,
      metadata: this.config.metadata,
    });

    this.client.on("session_delete", (event: { topic: string }) => {
      if (event.topic === this.lastSession?.topic) {
        this.sessionExpiryHandler?.();
      }
    });
    this.client.on("session_expire", (event: { topic: string }) => {
      if (event.topic === this.lastSession?.topic) {
        this.sessionExpiryHandler?.();
      }
    });

    return this.client;
  }

  async connect(input?: unknown): Promise<UniversalWalletSession> {
    const client = await this.getClient();
    const connectInput =
      input && typeof input === "object"
        ? (input as Record<string, unknown>)
        : undefined;

    const requiredNamespacesRaw = connectInput?.requiredNamespaces as
      | ProposalTypes.RequiredNamespaces
      | undefined;
    const optionalNamespacesRaw = connectInput?.optionalNamespaces as
      | ProposalTypes.OptionalNamespaces
      | undefined;

    const requiredNamespaces =
      requiredNamespacesRaw ?? buildRequiredNamespaces();

    const validation = validateCAIP25Proposal({
      requiredNamespaces: requiredNamespaces as Record<
        string,
        CAIP25NamespaceProposal
      >,
      optionalNamespaces: optionalNamespacesRaw as
        | Record<string, CAIP25NamespaceProposal>
        | undefined,
    });

    if (!validation.valid) {
      throw new WalletError(
        "invalid_proposal",
        `CAIP-25 validation failed: ${validation.errors.join(", ")}`,
      );
    }

    try {
      const connectParams: Record<string, unknown> = { requiredNamespaces };
      if (optionalNamespacesRaw) {
        connectParams.optionalNamespaces = optionalNamespacesRaw;
      }
      const { uri, approval } = await client.connect(connectParams as any);
      if (uri) {
        this.lastUri = uri;
      }

      const session = await approval();
      const namespaces = mapNamespaces(session.namespaces);

      const walletSession = createEmptySession({
        id: crypto.randomUUID(),
        topic: session.topic,
        walletId: session.peer.metadata?.name ?? "walletconnect",
        walletType: "walletconnect",
        namespaces,
        platform: detectPlatform(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      this.lastSession = walletSession;
      return walletSession;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "WalletConnect connect failed.";
      if (message.toLowerCase().includes("rejected")) {
        throw new WalletError("user_rejected", message, error);
      }

      throw new WalletError("wallet_unavailable", message, error);
    }
  }

  async reconnect(
    session: UniversalWalletSession,
  ): Promise<UniversalWalletSession> {
    const client = await this.getClient();

    try {
      const existing = client.session.get(session.topic ?? "");
      if (!existing) {
        throw new WalletError(
          "session_expired",
          "WalletConnect session not found.",
        );
      }

      const namespaces = mapNamespaces(existing.namespaces);
      const walletSession = createEmptySession({
        id: session.id,
        topic: existing.topic,
        walletId: existing.peer.metadata?.name ?? "walletconnect",
        walletType: "walletconnect",
        namespaces,
        platform: detectPlatform(),
        createdAt: session.createdAt,
        updatedAt: new Date().toISOString(),
      });

      this.lastSession = walletSession;
      return walletSession;
    } catch (error) {
      if (error instanceof WalletError) {
        throw error;
      }

      throw new WalletError(
        "session_expired",
        "WalletConnect session not found.",
        error,
      );
    }
  }

  async disconnect(session: UniversalWalletSession): Promise<void> {
    if (!session.topic) {
      return;
    }

    const client = await this.getClient();
    await client.disconnect({
      topic: session.topic,
      reason: {
        code: WC_DISCONNECT_USER,
        message: "User disconnected",
      },
    });
  }

  async getAccounts(session: UniversalWalletSession): Promise<string[]> {
    if (!session.topic) {
      return extractAccounts(session.namespaces);
    }

    const client = await this.getClient();
    const existing = client.session.get(session.topic);
    if (!existing) {
      throw new WalletError(
        "session_expired",
        "WalletConnect session expired.",
      );
    }

    return extractAccounts(mapNamespaces(existing.namespaces));
  }

  async signMessage(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
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
    const chainId =
      typeof inputObj.chainId === "string" ? inputObj.chainId : undefined;
    if (!message || !rawAddress)
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.MISSING_MESSAGE,
      );

    // Remove CAIP-10 prefix, keeping the raw chain address
    const address = rawAddress.includes(":")
      ? rawAddress.split(":").pop()!
      : rawAddress;

    // Solana chain → use solana_signMessage with base58 encoding (CAIP-25)
    // Reference: Reown AppKit's SolanaWalletConnectProvider sends
    // { message: base58.encode(message), pubkey: address }
    if (this.isSolanaChain(chainId)) {
      const messageBytes = new TextEncoder().encode(message);
      const base58Msg = base58.encode(messageBytes);
      return this.makeRequest(
        session,
        "solana_signMessage",
        [{ message: base58Msg, pubkey: address }],
        chainId,
      );
    }

    // EVM signing method fallback chain:
    //   JSON messages → eth_signTypedData_v4 (no fallback)
    //   Plain messages → personal_sign → eth_sign (fallback on method rejection)
    const tryMethods = message.startsWith("{")
      ? ["eth_signTypedData_v4"]
      : ["personal_sign", "eth_sign"];

    let lastError: unknown;
    for (const tryMethod of tryMethods) {
      let tryParams: unknown[];
      if (tryMethod === "personal_sign") {
        tryParams = [address, this.hexEncode(message)];
      } else if (tryMethod === "eth_sign") {
        // eth_sign takes [address, messageToSign]
        // Use the raw hex-encoded message; wallets will show a hash
        tryParams = [address, this.hexEncode(message)];
      } else {
        // eth_signTypedData_v4
        tryParams = [message, address];
      }

      try {
        return await this.makeRequest(session, tryMethod, tryParams, chainId);
      } catch (error) {
        lastError = error;
        // Only fall through on method-not-authorized errors
        const errMsg =
          error instanceof Error ? error.message.toLowerCase() : "";
        const isMethodRejection =
          // Exact WalletConnect wording: "has not been authorized by the user"
          errMsg.includes("not been authorized") ||
          errMsg.includes("not authorized") ||
          errMsg.includes("not approved") ||
          errMsg.includes("method not found") ||
          errMsg.includes("method_not_allowed");

        if (!isMethodRejection || tryMethods.length === 1) {
          // Unrecoverable error or no more fallbacks
          if (error instanceof WalletError) {
            throw error;
          }
          throw new WalletError(
            "signature_rejected",
            "WalletConnect signature rejected.",
            error,
          );
        }
        // Otherwise, continue to next fallback method
      }
    }

    // If all methods failed, throw the last error
    if (lastError instanceof WalletError) {
      throw lastError;
    }
    throw new WalletError(
      "signature_rejected",
      "WalletConnect signature rejected.",
      lastError,
    );
  }

  async signTransaction(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    if (!input || typeof input !== "object")
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.INVALID_INPUT,
      );
    const inputObj = input as Record<string, unknown>;
    const transaction = inputObj.transaction as
      | Record<string, unknown>
      | undefined;
    const chainId =
      typeof inputObj.chainId === "string" ? inputObj.chainId : undefined;
    if (!transaction)
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.MISSING_TX,
      );

    const isSolana = this.isSolanaChain(chainId);
    const method = isSolana ? "solana_signTransaction" : "eth_signTransaction";

    try {
      return await this.makeRequest(session, method, [transaction], chainId);
    } catch (error) {
      if (error instanceof WalletError) {
        throw error;
      }
      throw new WalletError(
        "signature_rejected",
        "WalletConnect sign transaction rejected.",
        error,
      );
    }
  }

  async sendRawTransaction(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    if (!input || typeof input !== "object")
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.INVALID_INPUT,
      );
    const inputObj = input as Record<string, unknown>;
    const signedTx =
      typeof inputObj.signedTransaction === "string"
        ? inputObj.signedTransaction
        : undefined;
    const chainId =
      typeof inputObj.chainId === "string" ? inputObj.chainId : undefined;
    if (!signedTx)
      throw new WalletError(
        "method_not_allowed",
        "Missing signedTransaction parameter.",
      );

    if (this.isSolanaChain(chainId)) {
      throw new WalletError(
        "method_not_allowed",
        "sendRawTransaction not supported for Solana via WalletConnect.",
      );
    }

    try {
      return await this.makeRequest<string>(
        session,
        "eth_sendRawTransaction",
        [signedTx],
        chainId,
      );
    } catch (error) {
      if (error instanceof WalletError) {
        throw error;
      }
      throw new WalletError(
        "tx_failed",
        "WalletConnect sendRawTransaction failed.",
        error,
      );
    }
  }

  async sendTransaction(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    if (!input || typeof input !== "object")
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.INVALID_INPUT,
      );
    const inputObj = input as Record<string, unknown>;
    const transaction = inputObj.transaction as
      | Record<string, unknown>
      | undefined;
    const chainId =
      typeof inputObj.chainId === "string" ? inputObj.chainId : undefined;
    if (!transaction)
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.MISSING_TX,
      );

    const isSolana = this.isSolanaChain(chainId);
    const method = isSolana ? "solana_sendTransaction" : "eth_sendTransaction";

    const tx = isSolana
      ? transaction
      : {
          ...transaction,
          value:
            typeof transaction.value === "string"
              ? toHexValue(transaction.value)
              : transaction.value,
        };

    try {
      return await this.makeRequest(session, method, [tx], chainId);
    } catch (error) {
      if (error instanceof WalletError) {
        throw error;
      }
      throw new WalletError(
        "tx_failed",
        "WalletConnect transaction failed.",
        error,
      );
    }
  }

  async switchChain(
    session: UniversalWalletSession,
    chainId: string,
  ): Promise<void> {
    if (!chainId.startsWith("eip155:")) {
      throw new WalletError(
        "chain_unsupported",
        "WalletConnect switchChain only supports EVM chains.",
      );
    }

    try {
      await this.makeRequest(
        session,
        "wallet_switchEthereumChain",
        [{ chainId: `0x${Number(chainId.split(":")[1]).toString(16)}` }],
        chainId,
      );
    } catch (error) {
      if (error instanceof WalletError) {
        throw error;
      }
      throw new WalletError(
        "chain_unsupported",
        "WalletConnect switch chain failed.",
        error,
      );
    }
  }

  async sendCalls(
    session: UniversalWalletSession,
    calls: BatchCall[],
    chainId?: string,
  ): Promise<string> {
    const resolvedChainId = chainId ?? this.getDefaultChainId(session);

    try {
      return await this.makeRequest<string>(
        session,
        "wallet_sendCalls",
        [{ calls, chainId: resolvedChainId }],
        resolvedChainId,
      );
    } catch {
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
        const hash = await this.makeRequest<string>(
          session,
          "eth_sendTransaction",
          [
            {
              from: fromAccount,
              to: call.to,
              value: call.value,
              data: call.data,
            },
          ],
          resolvedChainId,
        );
        txHashes.push(hash);
      }
      return txHashes.length === 1 ? txHashes[0] : txHashes.join(",");
    }
  }

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

  async getCallsStatus(
    session: UniversalWalletSession,
    bundleHash: string,
  ): Promise<import("@naculus/connect-core").CallsStatus> {
    try {
      return await this.makeRequest<
        import("@naculus/connect-core").CallsStatus
      >(session, "wallet_getCallsStatus", [bundleHash]);
    } catch {
      return { status: "PENDING" };
    }
  }

  async request(request: {
    method: string;
    params: unknown[];
  }): Promise<unknown> {
    const session = this.lastSession;
    if (!session)
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.SESSION_EXPIRED,
      );
    return this.makeRequest(
      session,
      request.method,
      request.params,
      this.getDefaultChainId(session),
    );
  }

  async getBalance(chainId?: string): Promise<string> {
    const session = this.lastSession;
    if (!session)
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.SESSION_EXPIRED,
      );
    const cId = chainId ?? this.getDefaultChainId(session);
    const rpcUrl = DEFAULT_RPC_URLS[cId];
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

  async deepLink(target: string): Promise<void> {
    if (typeof window === "undefined") {
      return;
    }

    const uri = this.lastUri;
    if (!uri) {
      throw new WalletError(
        "deeplink_timeout",
        "WalletConnect URI unavailable.",
      );
    }

    const url = `${target}${target.includes("?") ? "&" : "?"}uri=${encodeURIComponent(uri)}`;
    window.location.assign(url);
  }

  private getDefaultChainId(session: UniversalWalletSession): string {
    const evmNamespace = session.namespaces["eip155"];
    if (evmNamespace && evmNamespace.chains.length > 0) {
      return evmNamespace.chains[0];
    }

    const solanaNamespace = session.namespaces["solana"];
    if (solanaNamespace && solanaNamespace.chains.length > 0) {
      return solanaNamespace.chains[0];
    }

    return EIP155_MAINNET;
  }

  /**
   * Ensures session has a topic for WalletConnect operations
   * @throws WalletError if session topic is missing
   */
  private requireSessionTopic(session: UniversalWalletSession): string {
    if (!session.topic) {
      throw new WalletError(
        "session_expired",
        "WalletConnect session missing topic.",
      );
    }
    return session.topic;
  }

  /**
   * Determines if a chain ID is a Solana chain
   */
  private isSolanaChain(chainId: string | undefined): boolean {
    return chainId?.startsWith("solana:") ?? false;
  }

  /**
   * Hex-encodes a message for Ethereum JSON-RPC personal_sign
   * Converts a UTF-8 string to a 0x-prefixed hex string
   */
  private hexEncode(message: string): string {
    // Already hex-encoded
    if (/^0x[0-9a-fA-F]*$/.test(message)) return message;

    const bytes = new TextEncoder().encode(message);
    let hex = "0x";
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex;
  }

  /**
   * Signs typed data using eth_signTypedData_v4
   * Convenience method that wraps signMessage with explicit typed data handling.
   *
   * @param session - Active wallet session
   * @param input - Object with `typedData` (stringified EIP-712 typed data) and `address`
   * @returns Signature hex string
   */
  async signTypedData(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    if (!input || typeof input !== "object")
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.INVALID_INPUT,
      );
    const inputObj = input as Record<string, unknown>;
    const typedData =
      typeof inputObj.typedData === "string" ? inputObj.typedData : undefined;
    const rawAddress =
      typeof inputObj.address === "string" ? inputObj.address : undefined;
    const chainId =
      typeof inputObj.chainId === "string" ? inputObj.chainId : undefined;

    if (!typedData || !rawAddress)
      throw new WalletError(
        "method_not_allowed",
        CONNECTOR_ERROR_MESSAGES.INVALID_INPUT,
      );

    const address = rawAddress.includes(":")
      ? rawAddress.split(":").pop()!
      : rawAddress;

    if (this.isSolanaChain(chainId)) {
      throw new WalletError(
        "method_not_allowed",
        "signTypedData not supported for Solana.",
      );
    }

    try {
      return await this.makeRequest(
        session,
        "eth_signTypedData_v4",
        [address, typedData],
        chainId,
      );
    } catch (error) {
      if (error instanceof WalletError) {
        throw error;
      }
      throw new WalletError(
        "signature_rejected",
        "WalletConnect signTypedData_v4 rejected.",
        error,
      );
    }
  }

  /**
   * Makes a request to WalletConnect with standardized error handling
   */
  private async makeRequest<T>(
    session: UniversalWalletSession,
    method: string,
    params: unknown[],
    chainId?: string,
  ): Promise<T> {
    const client = await this.getClient();
    const topic = this.requireSessionTopic(session);
    const resolvedChainId = chainId ?? this.getDefaultChainId(session);

    try {
      return (await client.request({
        topic,
        chainId: resolvedChainId,
        request: { method, params },
      })) as T;
    } catch (error) {
      // Preserve original error message so callers (e.g. signMessage fallback)
      // can detect specific rejection patterns like "not authorized".
      // WalletConnect wraps errors from mobile wallets (MetaMask Mobile, Rainbow, etc.)
      // as generic JSON-RPC errors — we need the original message to distinguish
      // between "method not authorized" and actual signing failures.
      const originalMessage =
        error instanceof Error ? error.message : String(error);
      throw new WalletError("signature_rejected", originalMessage, {
        method,
        originalError: error,
      });
    }
  }

  onSessionExpiry(handler: () => void): void {
    this.sessionExpiryHandler = handler;
  }

  /** URI for QR code display */
  get uri(): string | undefined {
    return this.lastUri;
  }

  /**
   * Start WalletConnect pairing, returns URI for QR code
   * Call this to get the pairing URI, then display the QR code
   */
  async startPairing(): Promise<string> {
    const client = await this.getClient();
    const requiredNamespaces = buildRequiredNamespaces();
    const result = await client.connect({ requiredNamespaces });
    if (!result.uri) throw new WalletError("wallet_unavailable", "No URI");
    this.lastUri = result.uri;
    this.pendingApproval =
      result.approval as unknown as () => Promise<UniversalWalletSession>;
    return result.uri;
  }

  /**
   * Complete pairing after user scans QR code
   * Should be called after displaying the QR and user has scanned it
   */
  async completePairing(): Promise<UniversalWalletSession> {
    if (!this.pendingApproval)
      throw new WalletError("wallet_unavailable", "No pending approval");

    const pendingResult = await this.pendingApproval();
    const pendingSession = pendingResult as unknown as Record<string, unknown>;
    const pendingNamespaces = pendingSession.namespaces as Record<
      string,
      {
        chains?: string[];
        accounts: string[];
        methods: string[];
        events: string[];
        capabilities?: Record<string, unknown>;
      }
    >;
    const pendingTopic = pendingSession.topic as string | undefined;
    const pendingPeerName = (
      pendingSession.peer as Record<string, unknown> | undefined
    )?.metadata as Record<string, unknown> | undefined;
    const peerName =
      typeof pendingPeerName?.name === "string"
        ? pendingPeerName.name
        : "walletconnect";
    this.pendingApproval = undefined;

    const namespaces = mapNamespaces(pendingNamespaces);
    const ws = createEmptySession({
      id: crypto.randomUUID(),
      topic: pendingTopic,
      walletId: peerName,
      walletType: "walletconnect",
      namespaces,
      platform: detectPlatform(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    this.lastSession = ws;
    return ws;
  }
}

export function createWalletConnectConnector(
  config: WalletConnectConfig,
): WalletConnectConnector {
  return new WalletConnectConnector(config);
}

/**
 * XRPL/Xaman Connector
 *
 * Implements XRP Ledger wallet connection using Xaman (formerly Xumm)
 * deep links and WebSocket for transaction signing.
 * Implements UniversalConnector interface for integration with connect SDK.
 */

import type {
  ConnectorSupport,
  UniversalConnector,
  UniversalWalletSession,
} from "@naculus/connect-core";
import {
  createEmptySession,
  detectPlatform,
  WalletError,
} from "@naculus/connect-core";
import {
  isValidClassicAddress,
  isValidXAddress,
  xAddressToClassicAddress,
} from "ripple-address-codec";

export interface XRPLWalletInfo {
  address: string;
  publicKey: string;
  family?: string;
}

export interface XRPLTransaction {
  Account: string;
  TransactionType: string;
  Fee?: string;
  Sequence?: number;
  LastLedgerSequence?: number;
  [key: string]: unknown;
}

const XRPL_CHAIN_IDS = {
  mainnet: "xrpl:0",
  testnet: "xrpl:1",
  devnet: "xrpl:2",
} as const;

type XRPLNetwork = keyof typeof XRPL_CHAIN_IDS;

function chainIdForNetwork(network: XRPLNetwork): string {
  return XRPL_CHAIN_IDS[network];
}

function networkForChainId(chainId: string): XRPLNetwork {
  if (!/^xrpl:(?:0|1|2)$/.test(chainId)) {
    throw new WalletError(
      "method_not_allowed",
      `Unsupported XRPL CAIP-2 chain: ${chainId}.`,
    );
  }
  return chainId === "xrpl:0"
    ? "mainnet"
    : chainId === "xrpl:1"
      ? "testnet"
      : "devnet";
}

function isValidAccountAddress(address: string): boolean {
  return isValidClassicAddress(address) || isValidXAddress(address);
}

function xAddressMatchesNetwork(
  address: string,
  network: XRPLNetwork,
): boolean {
  return (
    !isValidXAddress(address) ||
    xAddressToClassicAddress(address).test === (network !== "mainnet")
  );
}

function normalizeTransactionAddress(
  address: string,
  field: string,
): {
  classicAddress: string;
  destinationTag?: number;
  isTestNetwork?: boolean;
} {
  const parts = address.split("-");
  if (parts.length > 2) {
    throw new WalletError("method_not_allowed", `Invalid ${field} address.`);
  }
  const [classic, tag] = parts;
  if (tag !== undefined && !/^\d+$/.test(tag)) {
    throw new WalletError(
      "method_not_allowed",
      `Invalid ${field} destination tag.`,
    );
  }
  if (isValidClassicAddress(classic)) {
    if (tag !== undefined) {
      const parsedTag = Number(tag);
      if (
        !Number.isSafeInteger(parsedTag) ||
        parsedTag < 0 ||
        parsedTag > 0xffffffff
      ) {
        throw new WalletError(
          "method_not_allowed",
          `Invalid ${field} destination tag.`,
        );
      }
      return { classicAddress: classic, destinationTag: parsedTag };
    }
    return { classicAddress: classic };
  }
  if (isValidXAddress(address)) {
    const decoded = xAddressToClassicAddress(address);
    return {
      classicAddress: decoded.classicAddress,
      ...(decoded.tag !== false ? { destinationTag: decoded.tag } : {}),
      isTestNetwork: decoded.test,
    };
  }
  throw new WalletError("method_not_allowed", `Invalid XRPL ${field} address.`);
}

/** Build a canonical CAIP-10 account for the active XRPL network. */
function xrplAccountId(network: XRPLNetwork, address: string): string {
  const classicAddress = normalizeTransactionAddress(
    address,
    "Account",
  ).classicAddress;
  return `${chainIdForNetwork(network)}:${classicAddress}`;
}

function assertDrops(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > 100_000_000_000_000_000n
  ) {
    throw new WalletError(
      "method_not_allowed",
      `Invalid XRPL ${field} drops amount.`,
    );
  }
}

function assertIssuedCurrencyAmount(value: unknown, field: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WalletError(
      "method_not_allowed",
      `Invalid XRPL ${field} amount.`,
    );
  }
  const amount = value as Record<string, unknown>;
  if (
    typeof amount.currency !== "string" ||
    !/^(?:[A-Z0-9]{3}|[A-F0-9]{40})$/.test(amount.currency) ||
    typeof amount.issuer !== "string" ||
    !isValidClassicAddress(amount.issuer) ||
    typeof amount.value !== "string" ||
    !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(amount.value)
  ) {
    throw new WalletError(
      "method_not_allowed",
      `Invalid XRPL ${field} amount.`,
    );
  }
}

function assertXrplAmount(value: unknown, field: string): void {
  if (typeof value === "string") {
    assertDrops(value, field);
  } else {
    assertIssuedCurrencyAmount(value, field);
  }
}

function validateTransaction(
  value: unknown,
  connectedAddress: string,
  isTestNetwork: boolean,
): XRPLTransaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WalletError("method_not_allowed", "Invalid XRPL transaction.");
  }
  const transaction = value as Record<string, unknown>;
  if (
    typeof transaction.TransactionType !== "string" ||
    !/^[A-Za-z][A-Za-z0-9]*$/.test(transaction.TransactionType)
  ) {
    throw new WalletError(
      "method_not_allowed",
      "Invalid XRPL transaction type.",
    );
  }
  if (
    typeof transaction.Account !== "string" ||
    !isValidClassicAddress(transaction.Account)
  ) {
    throw new WalletError(
      "method_not_allowed",
      "XRPL transaction Account must be a valid classic address.",
    );
  }
  if (transaction.Account !== connectedAddress) {
    throw new WalletError(
      "method_not_allowed",
      "XRPL transaction Account does not match the connected wallet.",
    );
  }
  if (transaction.Destination !== undefined) {
    if (typeof transaction.Destination !== "string") {
      throw new WalletError(
        "method_not_allowed",
        "Invalid XRPL transaction Destination.",
      );
    }
    const destination = normalizeTransactionAddress(
      transaction.Destination,
      "Destination",
    );
    if (
      destination.isTestNetwork !== undefined &&
      destination.isTestNetwork !== isTestNetwork
    ) {
      throw new WalletError(
        "method_not_allowed",
        "XRPL destination X-address network does not match the active network.",
      );
    }
    transaction.Destination = destination.classicAddress;
    if (destination.destinationTag !== undefined) {
      if (
        transaction.DestinationTag !== undefined &&
        transaction.DestinationTag !== destination.destinationTag
      ) {
        throw new WalletError(
          "method_not_allowed",
          "XRPL DestinationTag conflicts with the X-address tag.",
        );
      }
      if (transaction.DestinationTag === undefined) {
        transaction.DestinationTag = destination.destinationTag;
      }
    }
  }
  if (transaction.Fee !== undefined) assertDrops(transaction.Fee, "Fee");
  if (transaction.DeliverMax !== undefined) {
    assertXrplAmount(transaction.DeliverMax, "DeliverMax");
  }
  for (const field of ["Sequence", "LastLedgerSequence", "DestinationTag"]) {
    if (
      transaction[field] !== undefined &&
      (!Number.isSafeInteger(transaction[field]) ||
        (transaction[field] as number) < 0)
    ) {
      throw new WalletError(
        "method_not_allowed",
        `Invalid XRPL transaction ${field}.`,
      );
    }
  }
  if (transaction.Amount !== undefined) {
    assertXrplAmount(transaction.Amount, "Amount");
  }
  if (transaction.LimitAmount !== undefined) {
    const limit = transaction.LimitAmount;
    if (!limit || typeof limit !== "object" || Array.isArray(limit)) {
      throw new WalletError("method_not_allowed", "Invalid XRPL LimitAmount.");
    }
    const limitObj = limit as Record<string, unknown>;
    if (
      typeof limitObj.currency !== "string" ||
      !/^(?:[A-Z0-9]{3}|[A-F0-9]{40})$/.test(limitObj.currency) ||
      typeof limitObj.issuer !== "string" ||
      !isValidClassicAddress(limitObj.issuer) ||
      typeof limitObj.value !== "string" ||
      !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(limitObj.value)
    ) {
      throw new WalletError("method_not_allowed", "Invalid XRPL LimitAmount.");
    }
  }
  return transaction as XRPLTransaction;
}

interface XRPLSession {
  wallet: XRPLWalletInfo | null;
  accounts: string[];
}

const SUPPORT: ConnectorSupport = {
  desktop: true,
  mobile: true,
  deepLink: true,
  qr: false,
  trustedReconnect: false,
};

class XRPLConnectorImpl implements UniversalConnector {
  readonly id = "xrpl";
  readonly name = "XRP Ledger (Xaman)";
  readonly kind = "xrpl" as const;
  readonly namespaces = ["xrpl"];
  readonly supports = SUPPORT;

  private network: XRPLNetwork;
  private activeSession: XRPLSession = { wallet: null, accounts: [] };
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private pendingResolve: ((value: unknown) => void) | null = null;
  private pendingReject: ((reason: Error) => void) | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(network: "mainnet" | "testnet" | "devnet" = "mainnet") {
    this.network = network;
  }

  private _getNetworkEndpoint(): string {
    switch (this.network) {
      case "mainnet":
        return "wss://xrplcluster.com";
      case "testnet":
        return "wss://s.altnet.rippletest.net";
      case "devnet":
        return "wss://s.devnet.rippletest.net";
      default:
        return "wss://xrplcluster.com";
    }
  }

  private cleanup(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (this.messageHandler) {
      window.removeEventListener("message", this.messageHandler);
      this.messageHandler = null;
    }
    this.pendingResolve = null;
    this.pendingReject = null;
  }

  private setupMessageHandler(
    timeoutMs: number,
    onMessage: (data: unknown) => void,
  ): Promise<void> {
    if (typeof window === "undefined") {
      return Promise.reject(
        new WalletError(
          "method_not_allowed",
          "Browser environment required for XRPL connection.",
        ),
      );
    }

    return new Promise((resolve, reject) => {
      this.cleanup();

      this.pendingResolve = (data: unknown) => {
        this.cleanup();
        onMessage(data);
        resolve();
      };
      this.pendingReject = (error: Error) => {
        this.cleanup();
        reject(error);
      };

      this.timeoutId = setTimeout(() => {
        this.cleanup();
        reject(
          new WalletError(
            "deeplink_timeout",
            "Connection timed out. Please try again.",
          ),
        );
      }, timeoutMs);

      this.messageHandler = (event: MessageEvent) => {
        // Accept messages from same origin (Xaman redirect flow) or
        // from Xaman/Xumm trusted domains (popup flow)
        const trustedOrigins = [
          window.location.origin,
          "https://xumm.app",
          "https://xaman.app",
        ];
        if (!trustedOrigins.includes(event.origin)) return;
        const data = event.data;
        if (
          data &&
          typeof data === "object" &&
          data.type === "XAMAN_CONNECTED"
        ) {
          this.pendingResolve?.(data);
        }
      };

      window.addEventListener("message", this.messageHandler);
    });
  }

  private openDeeplink(deeplink: string): void {
    if (typeof document === "undefined") return;

    const link = document.createElement("a");
    link.href = deeplink;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  async reconnect(
    session: UniversalWalletSession,
  ): Promise<UniversalWalletSession> {
    this.activeSession = { wallet: null, accounts: [] };
    this.cleanup();
    throw new WalletError(
      "session_expired",
      "XRPL (Xaman) sessions cannot be restored automatically. Please reconnect via connect().",
    );
  }

  async connect(input?: unknown): Promise<UniversalWalletSession> {
    if (typeof window === "undefined") {
      throw new WalletError(
        "method_not_allowed",
        "Browser environment required for XRPL connection.",
      );
    }

    const inputObj =
      input && typeof input === "object"
        ? (input as Record<string, unknown>)
        : undefined;
    const inputChain =
      typeof inputObj?.chainId === "string" ? inputObj.chainId : undefined;
    const chainId = inputChain ?? chainIdForNetwork(this.network);
    this.network = networkForChainId(chainId);

    try {
      const responsePromise = this.setupMessageHandler(120000, (data) => {
        const response =
          data && typeof data === "object"
            ? (data as Record<string, unknown>)
            : undefined;
        const responseType =
          typeof response?.type === "string" ? response.type : undefined;
        const responseWallet = response?.wallet as XRPLWalletInfo | undefined;
        if (
          responseType === "XAMAN_CONNECTED" &&
          responseWallet &&
          typeof responseWallet.address === "string" &&
          isValidAccountAddress(responseWallet.address) &&
          xAddressMatchesNetwork(responseWallet.address, this.network)
        ) {
          this.activeSession = {
            wallet: responseWallet,
            accounts: [xrplAccountId(this.network, responseWallet.address)],
          };
        }
      });

      const deeplink = `xaman://${window.location.origin}?xrt=webconnector`;
      this.openDeeplink(deeplink);

      await responsePromise;

      const wallet = this.activeSession.wallet;
      if (!wallet) {
        throw new WalletError(
          "wallet_unavailable",
          "No wallet connected. Please try again.",
        );
      }

      const session = createEmptySession({
        id: `xrpl-${wallet.address}-${Date.now()}`,
        walletId: wallet.address,
        walletType: "xrpl",
        namespaces: {
          xrpl: {
            chains: [chainId],
            accounts: [xrplAccountId(this.network, wallet.address)],
            // Xaman currently exposes transaction signing, not a cryptographic
            // arbitrary-message API. Do not advertise a fake `xrpl_sign`
            // method; SIWx must use a real message-signing standard.
            methods: ["xrpl_submit"],
            events: ["xrpl_account_changed"],
          },
        },
        platform: detectPlatform(),
      });

      return session;
    } catch (error) {
      this.activeSession = { wallet: null, accounts: [] };
      throw error instanceof WalletError
        ? error
        : new WalletError(
            "tx_failed",
            "Connection failed. Please try again.",
            error,
          );
    }
  }

  // No onAccountsChanged / onChainChanged.
  //
  // Those are optional on UniversalConnector, and their absence here is a
  // statement about XRPL wallets, not an unfinished item. This connector talks
  // to Xaman over a deep link plus a one-shot `postMessage` handshake: the
  // listener resolves a single XAMAN_CONNECTED reply and is then torn down in
  // cleanup(). There is no persistent channel a wallet could push an account
  // switch over, so a subscription here could never fire — and one that never
  // fires is worse than none, because a consumer would take it as a guarantee
  // that it will be told. Callers reconnect to observe a change instead.
  async disconnect(session: UniversalWalletSession): Promise<void> {
    this.activeSession = { wallet: null, accounts: [] };
    this.cleanup();
  }

  async getAccounts(session: UniversalWalletSession): Promise<string[]> {
    return session.namespaces.xrpl?.accounts ?? [];
  }

  async signMessage(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    throw new WalletError(
      "method_unsupported",
      "Xaman does not expose cryptographic arbitrary-message signing. Use signTransaction with an explicit XRPL transaction.",
    );
  }

  async signTransaction(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    if (!this.activeSession.wallet) {
      throw new WalletError(
        "session_expired",
        "Session expired. Please reconnect your wallet.",
      );
    }

    if (!input || typeof input !== "object" || !("transaction" in input))
      throw new WalletError(
        "method_not_allowed",
        "Missing transaction parameter.",
      );
    const walletAddress = this.activeSession.wallet.address;
    const normalizedWallet = normalizeTransactionAddress(
      walletAddress,
      "Account",
    );
    if (
      normalizedWallet.isTestNetwork !== undefined &&
      normalizedWallet.isTestNetwork !== (this.network !== "mainnet")
    ) {
      throw new WalletError(
        "method_not_allowed",
        "Connected XRPL X-address network does not match the active network.",
      );
    }
    const connectedAddress = normalizedWallet.classicAddress;
    const transaction = validateTransaction(
      (input as Record<string, unknown>).transaction,
      connectedAddress,
      this.network !== "mainnet",
    );
    const txjson = JSON.stringify(transaction);

    return new Promise((resolve, reject) => {
      this.cleanup();

      this.pendingReject = reject;

      this.timeoutId = setTimeout(() => {
        this.cleanup();
        reject(
          new WalletError(
            "deeplink_timeout",
            "Transaction signing timed out. Please try again.",
          ),
        );
      }, 300000);

      // ponytail: overwrites the handler set by setupMessageHandler() in connect().
      // connect() and signTransaction() are never called concurrently — connect first,
      // then sign later — so no race. If that ever changes, merge handlers or use an
      // event-bus pattern.
      this.messageHandler = (event: MessageEvent) => {
        const trustedOrigins = new Set([
          window.location.origin,
          "https://xumm.app",
          "https://xaman.app",
        ]);
        if (!trustedOrigins.has(event.origin)) return;
        const data = event.data as { type?: string; txid?: string };
        if (data?.type === "XAMAN_SIGNED" && data?.txid) {
          this.cleanup();
          resolve(data.txid);
        } else if (data?.type === "XAMAN_REJECTED") {
          this.cleanup();
          reject(
            new WalletError("user_rejected", "Transaction rejected by user."),
          );
        }
      };

      window.addEventListener("message", this.messageHandler);

      const deeplink = `xaman://tx?xrt=${encodeURIComponent(txjson)}`;
      this.openDeeplink(deeplink);
    });
  }

  async sendTransaction(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown> {
    return this.signTransaction(session, input);
  }

  async switchChain(
    session: UniversalWalletSession,
    chainId: string,
  ): Promise<void> {
    this.network = networkForChainId(chainId);

    const chains = session.namespaces.xrpl?.chains ?? [];
    if (!chains.includes(chainId)) {
      session.namespaces.xrpl!.chains = [
        ...chains.filter((c) => /^xrpl:(?:0|1|2)$/.test(c)),
        chainId,
      ];
    }
    if (this.activeSession.wallet && session.namespaces.xrpl) {
      session.namespaces.xrpl.accounts = [
        xrplAccountId(this.network, this.activeSession.wallet.address),
      ];
    }
  }

  getConnectedWallet(): XRPLWalletInfo | null {
    return this.activeSession.wallet;
  }

  isConnected(): boolean {
    return this.activeSession.wallet !== null;
  }

  setNetwork(network: "mainnet" | "testnet" | "devnet"): void {
    this.network = network;
  }

  getNetworkEndpoint(): string {
    return this._getNetworkEndpoint();
  }

  createPaymentTx(
    destination: string,
    amount: string,
    destinationTag?: number,
  ): XRPLTransaction {
    if (!this.activeSession.wallet) {
      throw new WalletError(
        "session_expired",
        "Session expired. Please reconnect your wallet.",
      );
    }

    const normalizedAccount = normalizeTransactionAddress(
      this.activeSession.wallet.address,
      "Account",
    );
    if (
      normalizedAccount.isTestNetwork !== undefined &&
      normalizedAccount.isTestNetwork !== (this.network !== "mainnet")
    ) {
      throw new WalletError(
        "method_not_allowed",
        "Connected XRPL X-address network does not match the active network.",
      );
    }
    const account = normalizedAccount.classicAddress;
    const normalizedDestination = normalizeTransactionAddress(
      destination,
      "Destination",
    );
    if (
      normalizedDestination.isTestNetwork !== undefined &&
      normalizedDestination.isTestNetwork !== (this.network !== "mainnet")
    ) {
      throw new WalletError(
        "method_not_allowed",
        "XRPL destination X-address network does not match the active network.",
      );
    }
    assertDrops(amount, "Amount");
    const tx: Partial<XRPLTransaction> = {
      TransactionType: "Payment",
      Account: account,
      Destination: normalizedDestination.classicAddress,
      Amount: amount,
    };

    const resolvedTag = destinationTag ?? normalizedDestination.destinationTag;
    if (
      destinationTag !== undefined &&
      normalizedDestination.destinationTag !== undefined &&
      destinationTag !== normalizedDestination.destinationTag
    ) {
      throw new WalletError(
        "method_not_allowed",
        "DestinationTag conflicts with the X-address tag.",
      );
    }
    if (resolvedTag !== undefined) {
      if (
        !Number.isSafeInteger(resolvedTag) ||
        resolvedTag < 0 ||
        resolvedTag > 0xffffffff
      ) {
        throw new WalletError("method_not_allowed", "Invalid DestinationTag.");
      }
      tx.DestinationTag = resolvedTag;
    }

    return tx as XRPLTransaction;
  }

  createTrustlineTx(
    currency: string,
    issuer: string,
    limit: string,
  ): XRPLTransaction {
    if (!this.activeSession.wallet) {
      throw new WalletError(
        "session_expired",
        "Session expired. Please reconnect your wallet.",
      );
    }

    if (
      !xAddressMatchesNetwork(this.activeSession.wallet.address, this.network)
    ) {
      throw new WalletError(
        "method_not_allowed",
        "Connected XRPL X-address network does not match the active network.",
      );
    }
    const account = normalizeTransactionAddress(
      this.activeSession.wallet.address,
      "Account",
    ).classicAddress;
    if (
      !/^(?:[A-Z0-9]{3}|[A-F0-9]{40})$/.test(currency) ||
      !isValidClassicAddress(issuer) ||
      !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(limit)
    ) {
      throw new WalletError(
        "method_not_allowed",
        "Invalid XRPL trustline fields.",
      );
    }
    const tx: Partial<XRPLTransaction> = {
      TransactionType: "TrustSet",
      Account: account,
      LimitAmount: {
        currency,
        issuer,
        value: limit,
      },
    };

    return tx as XRPLTransaction;
  }
}

export const xrplConnector = new XRPLConnectorImpl();

export type { XRPLConnectorImpl as XRPLConnectorClass, XRPLConnectorImpl };
export { XRPLConnectorImpl as XRPLConnector };

export function createXRPLConnector(
  network: "mainnet" | "testnet" | "devnet" = "mainnet",
): XRPLConnectorImpl {
  return new XRPLConnectorImpl(network);
}

export function formatXRPAmount(amount: string | number): string {
  const drops = typeof amount === "number" ? String(amount) : amount;
  assertDrops(drops, "amount");
  const whole = drops.slice(0, -6) || "0";
  const fraction = drops.slice(-6).padStart(6, "0");
  return `${whole}.${fraction}`;
}

export function parseXRPAmount(amount: string): string {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(amount)) {
    throw new WalletError("method_not_allowed", "Invalid XRP amount.");
  }
  const [whole, fraction = ""] = amount.split(".");
  const drops = `${whole}${fraction.padEnd(6, "0")}`.replace(/^0+(?=\d)/, "");
  assertDrops(drops, "amount");
  return drops;
}

export function isValidXRPAddress(address: string): boolean {
  return isValidXAddress(address);
}

export function isValidXRPClassicAddress(address: string): boolean {
  const parts = address.split("-");
  if (parts.length > 2) return false;
  const [classic, tag] = parts;
  if (!isValidClassicAddress(classic)) return false;
  if (tag === undefined) return true;
  const parsedTag = Number(tag);
  return (
    /^\d{1,10}$/.test(tag) &&
    Number.isSafeInteger(parsedTag) &&
    parsedTag <= 0xffffffff
  );
}

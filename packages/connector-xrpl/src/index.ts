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

  private network: "mainnet" | "testnet" | "devnet";
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
    const chainId = inputChain ?? "xrpl:1";

    try {
      const responsePromise = this.setupMessageHandler(120000, (data) => {
        const response =
          data && typeof data === "object"
            ? (data as Record<string, unknown>)
            : undefined;
        const responseType =
          typeof response?.type === "string" ? response.type : undefined;
        const responseWallet = response?.wallet as XRPLWalletInfo | undefined;
        if (responseType === "XAMAN_CONNECTED" && responseWallet) {
          this.activeSession = {
            wallet: responseWallet,
            accounts: [`xrpl:${responseWallet.address}`],
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
            accounts: [`xrpl:${wallet.address}`],
            methods: ["xrpl_sign", "xrpl_submit"],
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
    if (!this.activeSession.wallet) {
      throw new WalletError(
        "session_expired",
        "Session expired. Please reconnect your wallet.",
      );
    }

    if (
      !input ||
      typeof input !== "object" ||
      !("message" in input) ||
      typeof (input as Record<string, unknown>).message !== "string"
    ) {
      throw new WalletError("method_not_allowed", "Missing message parameter.");
    }
    const message = (input as Record<string, unknown>).message as string;
    const msgHex = Array.from(new TextEncoder().encode(message))
      .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
      .join("");

    const XRPL_AMOUNT = "1";   // ponytail: minimum XRP drop
    const XRPL_FEE = "12";     // ponytail: minimum XRP drop fee

    const tx: XRPLTransaction = {
      TransactionType: "Payment",
      Account: this.activeSession.wallet.address,
      Destination: this.activeSession.wallet.address,
      Amount: XRPL_AMOUNT,
      Fee: XRPL_FEE,
      // XLS-0063 (XRPL SignIn) is stalled. This is a workaround using a
      // self-directed Payment transaction with the message hex-encoded
      // in the Memo field. The Amount/Fee values are the minimum viable
      // XRP drops for transaction validity — no actual value is transferred.
      Memos: [
        {
          Memo: {
            MemoType: "646f6d61696e2d776562332d636f6e6e6563742d7369676e696e",
            MemoData: msgHex,
          },
        },
      ],
    };

    const signTxInput =
      input && typeof input === "object"
        ? (input as Record<string, unknown>)
        : {};
    return this.signTransaction(session, { ...signTxInput, transaction: tx });
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
    const transaction = (input as Record<string, unknown>)
      .transaction as XRPLTransaction;
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
    const chainNum = parseInt(chainId.split(":")[1] || "1", 10);

    if (chainNum === 0) {
      this.network = "mainnet";
    } else if (chainNum === 1) {
      this.network = "testnet";
    } else {
      this.network = "devnet";
    }

    const chains = session.namespaces.xrpl?.chains ?? [];
    if (!chains.includes(chainId)) {
      session.namespaces.xrpl!.chains = [
        ...chains.filter((c) => c.startsWith("xrpl:")),
        chainId,
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

    const tx: Partial<XRPLTransaction> = {
      TransactionType: "Payment",
      Account: this.activeSession.wallet.address,
      Destination: destination,
      Amount: amount,
    };

    if (destinationTag !== undefined) {
      tx.DestinationTag = destinationTag;
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

    const tx: Partial<XRPLTransaction> = {
      TransactionType: "TrustSet",
      Account: this.activeSession.wallet.address,
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
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  return (num / 1000000).toFixed(6);
}

export function parseXRPAmount(amount: string): string {
  const num = parseFloat(amount);
  return Math.round(num * 1000000).toString();
}

export function isValidXRPAddress(address: string): boolean {
  return /^X[0-9a-zA-Z]{40,50}$/.test(address);
}

export function isValidXRPClassicAddress(address: string): boolean {
  if (!address.startsWith("r") || address.length < 25 || address.length > 34) {
    return false;
  }
  return /^[r][0-9a-zA-Z]+$/.test(address);
}

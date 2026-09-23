import type {
  DelegationAuthorizationRequest,
  SignedDelegationAuthorization,
} from "./delegation";
import type {
  Namespace,
  SessionNamespace,
  UniversalWalletSession,
} from "./session";

export type { Namespace, SessionNamespace, UniversalWalletSession };

export interface ConnectorSupport {
  desktop: boolean;
  mobile: boolean;
  deepLink: boolean;
  qr: boolean;
  trustedReconnect: boolean;
}

export interface BatchCall {
  /** Destination contract; omit for a contract-creation call with data. */
  to?: `0x${string}`;
  value?: string;
  data?: `0x${string}`;
}

export interface SendCallsOptions {
  /**
   * Require all-or-nothing execution.
   *
   * Maps to EIP-5792 `atomicRequired`. When true the wallet must execute every
   * call atomically or reject the request outright, and a connector must not
   * substitute individual transactions if `wallet_sendCalls` turns out to be
   * unavailable — that substitution is precisely the non-atomic execution the
   * caller ruled out. Leaving an approve on chain with no swap behind it is
   * the failure this flag exists to prevent.
   *
   * Defaults to false, which lets the wallet decide, matching EIP-5792.
   */
  atomicRequired?: boolean;
  /** ERC-7677 service the wallet must use for this request. */
  paymasterService?: {
    url: string;
    context?: Record<string, unknown>;
  };
}

export interface WalletCapabilities {
  atomicBatch: { supported: boolean; maxBatchSize?: number };
  paymasterService?: { supported: boolean };
  [key: string]: unknown;
}

/** EIP-5792 status codes: 1xx pending, 2xx confirmed, 4xx/5xx failures. */
export type CallsStatusCode = 100 | 200 | 400 | 500 | 600 | number;

/** EIP-5792: wallet_getCallsStatus response. */
export interface CallsStatus {
  version: string;
  id: `0x${string}`;
  chainId: `0x${string}`;
  status: CallsStatusCode;
  atomic: boolean;
  receipts?: Array<{
    logs: Array<{
      address: `0x${string}`;
      data: `0x${string}`;
      topics: `0x${string}`[];
    }>;
    status: `0x${string}`;
    blockHash: `0x${string}`;
    blockNumber: `0x${string}`;
    gasUsed: `0x${string}`;
    transactionHash: `0x${string}`;
  }>;
  capabilities?: Record<string, unknown>;
}

/** One namespace of a scope request: what the app wants, without accounts. */
export type SessionScopeNamespaceRequest = Pick<
  SessionNamespace,
  "chains" | "methods" | "events"
>;

/**
 * Connector-neutral CAIP-25 scope request, carried in `connect(input)` as
 * `{ scope }`. `required` must be granted in full or the connection fails;
 * `optional` may be granted in part. Connectors translate it into their own
 * proposal format (WalletConnect namespaces) or check the wallet's current
 * state against it (an injected wallet on a chain outside `required` is
 * refused rather than returned on the wrong chain).
 */
export interface SessionScopeRequest {
  required?: Record<Namespace, SessionScopeNamespaceRequest>;
  optional?: Record<Namespace, SessionScopeNamespaceRequest>;
}

/** Read a scope request out of an opaque connect() input, if one is there. */
export function scopeRequestFrom(
  input: unknown,
): SessionScopeRequest | undefined {
  if (!input || typeof input !== "object") return undefined;
  const scope = (input as { scope?: unknown }).scope;
  return scope && typeof scope === "object"
    ? (scope as SessionScopeRequest)
    : undefined;
}

/** A wallet-initiated change to a live session (CAIP-25 lifecycle). */
export type SessionChange =
  | {
      type: "scope";
      /** The wallet's current view of every namespace it still grants. */
      namespaces: Record<Namespace, SessionNamespace>;
    }
  | {
      type: "expiry";
      /** ISO 8601, or null when the wallet removed the expiry. */
      expiresAt: string | null;
    }
  | {
      type: "revoked";
      reason: "wallet" | "expired";
    };

export interface UniversalConnector {
  id: string;
  name: string;
  kind: string;
  namespaces: string[];
  supports: ConnectorSupport;
  connect(input?: unknown): Promise<UniversalWalletSession>;
  reconnect?(session: UniversalWalletSession): Promise<UniversalWalletSession>;
  disconnect(session: UniversalWalletSession): Promise<void>;
  getAccounts(session: UniversalWalletSession): Promise<string[]>;
  /**
   * Observe account changes the user makes inside the wallet.
   *
   * A wallet can switch accounts without the dApp asking, and every namespace
   * has some form of it — EIP-1193 `accountsChanged`, Solana's
   * `accountChanged`, a WalletConnect `session_update`. Consumers should not
   * have to know which: this is the one place to subscribe, and the reason it
   * lives on the connector rather than in a framework layer is that only the
   * connector knows how its wallet reports the change.
   *
   * The connector MUST have already updated `session.namespaces` before
   * invoking the handler, so a consumer can read the session directly. The
   * `accounts` argument is the flattened CAIP-10 list for convenience; an
   * empty array means the wallet is no longer authorizing this dApp, which the
   * consumer should treat as a disconnect.
   *
   * Returns an unsubscribe function. Calling it twice is a no-op.
   */
  onAccountsChanged?(
    session: UniversalWalletSession,
    handler: (accounts: string[]) => void,
  ): () => void;
  /**
   * Observe chain switches the user makes inside the wallet.
   *
   * The counterpart to onAccountsChanged, and subject to the same contract:
   * the connector MUST have already updated `session.namespaces` — including
   * re-keying the CAIP-10 accounts to the new chain — before invoking the
   * handler. `chainId` is CAIP-2.
   *
   * Returns an unsubscribe function.
   */
  onChainChanged?(
    session: UniversalWalletSession,
    handler: (chainId: string) => void,
  ): () => void;
  /**
   * Observe wallet-initiated changes to the session itself (CAIP-25
   * lifecycle): a narrowed or re-issued scope, a new expiry, or the wallet
   * ending the session. Connectors whose scope cannot change without a
   * reconnect (injected, embedded) simply do not implement this.
   *
   * The connector reports what the wallet said; it does not decide what the
   * app accepts. `SessionManager` applies a narrowed scope immediately and
   * never widens a session beyond what it already held.
   *
   * Returns an unsubscribe function.
   */
  onSessionChanged?(
    session: UniversalWalletSession,
    handler: (change: SessionChange) => void,
  ): () => void;
  signMessage?(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown>;
  signTransaction?(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown>;
  sendTransaction?(
    session: UniversalWalletSession,
    input: unknown,
  ): Promise<unknown>;
  /**
   * Sign an EIP-7702 authorization with the session's own account key.
   *
   * Only a connector that holds the key (the embedded wallet) implements
   * this. Browser and WalletConnect wallets expose no dapp-callable method
   * for arbitrary delegations — they upgrade accounts through
   * `wallet_sendCalls` — so an absent hook is the expected answer there, not
   * a gap to paper over. Build the request with
   * `prepareDelegationAuthorization`, never by hand, and refuse it when
   * `request.account` is not the address this connector signs for.
   */
  signAuthorization?(
    session: UniversalWalletSession,
    request: DelegationAuthorizationRequest,
  ): Promise<SignedDelegationAuthorization>;
  switchChain?(session: UniversalWalletSession, chainId: string): Promise<void>;
  deepLink?(target: string): Promise<void>;
  sendCalls?(
    session: UniversalWalletSession,
    calls: BatchCall[],
    chainId?: string,
    options?: SendCallsOptions,
  ): Promise<string>;
  getCapabilities?(
    session: UniversalWalletSession,
  ): Promise<Record<string, WalletCapabilities>>;
  getCallsStatus?(
    session: UniversalWalletSession,
    bundleHash: string,
  ): Promise<CallsStatus>;
  /**
   * EIP-5792 `wallet_showCallsStatus`: ask the wallet to display a bundle's
   * status to the user.
   *
   * A request for the wallet's own UI, not for data — there is nothing to
   * return. Treat a rejection as cosmetic: the bundle is unaffected either
   * way, so a caller should not surface a failure here as a transaction
   * problem. Wallets that do not implement it answer -32601.
   */
  showCallsStatus?(
    session: UniversalWalletSession,
    bundleHash: string,
  ): Promise<void>;
  request?(request: { method: string; params: unknown[] }): Promise<unknown>;
  getBalance?(chainId?: string): Promise<string>;
}

function extractFromNamespaces<K extends keyof SessionNamespace>(
  namespaces: Record<Namespace, SessionNamespace>,
  key: K,
): SessionNamespace[K] extends (infer T)[] ? T[] : never {
  const result = new Set<unknown>();
  Object.values(namespaces).forEach((ns) => {
    (ns[key] as unknown[]).forEach((v) => result.add(v));
  });
  return Array.from(result) as any;
}

export function extractAccounts(
  namespaces: Record<Namespace, SessionNamespace>,
): string[] {
  return extractFromNamespaces(namespaces, "accounts");
}

export function getChainsFromNamespaces(
  namespaces: Record<Namespace, SessionNamespace>,
): string[] {
  return extractFromNamespaces(namespaces, "chains");
}

export function getMethodsFromNamespaces(
  namespaces: Record<Namespace, SessionNamespace>,
): string[] {
  return extractFromNamespaces(namespaces, "methods");
}

export function getEventsFromNamespaces(
  namespaces: Record<Namespace, SessionNamespace>,
): string[] {
  return extractFromNamespaces(namespaces, "events");
}

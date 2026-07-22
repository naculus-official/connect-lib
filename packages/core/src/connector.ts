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
  to: `0x${string}`;
  value?: string;
  data?: `0x${string}`;
}

export interface WalletCapabilities {
  atomicBatch: { supported: boolean; maxBatchSize?: number };
  paymasterService?: { supported: boolean };
  [key: string]: unknown;
}

/** EIP-5792: getCallsStatus response */
export interface CallsStatus {
  status: "PENDING" | "CONFIRMED";
  receipts?: Array<{
    logs: Array<{
      address: string;
      data: string;
      topics: string[];
    }>;
    status: "0x1" | "0x0";
    blockHash: string;
    blockNumber: string;
    gasUsed: string;
    transactionHash: string;
  }>;
}

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
  switchChain?(session: UniversalWalletSession, chainId: string): Promise<void>;
  deepLink?(target: string): Promise<void>;
  sendCalls?(
    session: UniversalWalletSession,
    calls: BatchCall[],
    chainId?: string,
  ): Promise<string>;
  getCapabilities?(
    session: UniversalWalletSession,
  ): Promise<Record<string, WalletCapabilities>>;
  getCallsStatus?(
    session: UniversalWalletSession,
    bundleHash: string,
  ): Promise<CallsStatus>;
  request?(request: { method: string; params: unknown[] }): Promise<unknown>;
  getBalance?(chainId?: string): Promise<string>;
}

export function extractAccounts(
  namespaces: Record<Namespace, SessionNamespace>,
): string[] {
  return Object.values(namespaces).flatMap((namespace) => namespace.accounts);
}

export function getChainsFromNamespaces(
  namespaces: Record<Namespace, SessionNamespace>,
): string[] {
  const chains = new Set<string>();
  Object.values(namespaces).forEach((namespace) => {
    namespace.chains.forEach((chain) => chains.add(chain));
  });
  return Array.from(chains);
}

export function getMethodsFromNamespaces(
  namespaces: Record<Namespace, SessionNamespace>,
): string[] {
  const methods = new Set<string>();
  Object.values(namespaces).forEach((namespace) => {
    namespace.methods.forEach((method) => methods.add(method));
  });
  return Array.from(methods);
}

export function getEventsFromNamespaces(
  namespaces: Record<Namespace, SessionNamespace>,
): string[] {
  const events = new Set<string>();
  Object.values(namespaces).forEach((namespace) => {
    namespace.events.forEach((event) => events.add(event));
  });
  return Array.from(events);
}

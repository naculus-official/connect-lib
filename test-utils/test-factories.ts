/**
 * Test factories — reusable builder functions for test objects.
 *
 * Every test imports from here instead of inlining session/connector/config objects.
 */

import type {
  BatchCall,
  ConnectorSupport,
  UniversalConnector,
  WalletCapabilities,
} from "../packages/core/src/connector";
import type {
  Namespace,
  SessionNamespace,
  UniversalWalletSession,
} from "../packages/core/src/session";
import { ADDRESSES, CHAINS, GAS, SESSION } from "./test-constants";

// ── Session Factories ──────────────────────────────────────────────

interface SessionOverrides {
  id?: string;
  walletId?: string;
  walletType?: UniversalWalletSession["walletType"];
  platform?: UniversalWalletSession["platform"];
  expiry?: number;
  topic?: string;
  namespace?: Namespace;
  accounts?: string[];
  chains?: string[];
}

export function createTestSession(
  overrides: SessionOverrides = {},
): UniversalWalletSession {
  const ns = overrides.namespace ?? SESSION.NAMESPACES.EIP155;
  const chains = overrides.chains ?? [`${ns}:1`];
  const accounts = overrides.accounts ?? [`${ns}:1:${ADDRESSES.ALICE}`];
  const walletId = overrides.walletId ?? "test-wallet";

  return {
    id: overrides.id ?? `test-session-${Date.now()}`,
    topic: overrides.topic,
    walletId,
    walletType: overrides.walletType ?? walletId,
    namespaces: {
      [ns]: {
        chains,
        accounts,
        methods: [
          "eth_sendTransaction",
          "personal_sign",
          "wallet_switchEthereumChain",
        ],
        events: ["accountsChanged", "chainChanged"],
      },
    },
    platform: overrides.platform ?? "desktop-web",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiry: overrides.expiry ?? Date.now() + 300_000,
  };
}

export function createExpiredTestSession(
  overrides: SessionOverrides = {},
): UniversalWalletSession {
  return createTestSession({
    ...overrides,
    expiry: Date.now() - 60_000,
    id: `expired-${Date.now()}`,
  });
}

export function createMultiNamespaceSession(): UniversalWalletSession {
  return {
    id: `multi-session-${Date.now()}`,
    walletId: "multi-wallet",
    walletType: "multichain",
    namespaces: {
      [SESSION.NAMESPACES.EIP155]: {
        chains: [CHAINS.EVM_MAINNET, CHAINS.EVM_POLYGON],
        accounts: [
          `eip155:1:${ADDRESSES.ALICE}`,
          `eip155:137:${ADDRESSES.ALICE}`,
        ],
        methods: ["eth_sendTransaction", "personal_sign"],
        events: ["accountsChanged", "chainChanged"],
      },
      solana: {
        chains: [CHAINS.SOLANA_MAINNET],
        accounts: [`solana:0:${ADDRESSES.SOLANA}`],
        methods: ["solana_signMessage", "solana_signTransaction"],
        events: [],
      },
    },
    platform: "desktop-web",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiry: Date.now() + 300_000,
  };
}

// ── Connector Factories ────────────────────────────────────────────

interface MockConnectorOptions {
  id?: string;
  name?: string;
  namespace?: Namespace;
  accounts?: string[];
  chainId?: string;
  supports?: Partial<ConnectorSupport>;
  shouldFailOnSign?: boolean;
  shouldFailOnSend?: boolean;
  signDelay?: number;
  sendDelay?: number;
}

export function createMockConnector(
  options: MockConnectorOptions = {},
): UniversalConnector {
  const id = options.id ?? "mock-generic";
  const ns = options.namespace ?? "eip155";
  const accounts = options.accounts ?? [`${ns}:1:${ADDRESSES.ALICE}`];
  const chainId = options.chainId ?? `${ns}:1`;

  let session: UniversalWalletSession | null = null;
  let sendCallCount = 0;

  return {
    id,
    name: options.name ?? id,
    kind: "mock",
    namespaces: [ns],
    supports: {
      desktop: true,
      mobile: false,
      deepLink: false,
      qr: false,
      trustedReconnect: true,
      ...options.supports,
    },
    async connect() {
      session = createTestSession({
        walletId: id,
        namespace: ns,
        accounts,
        chains: [chainId],
      });
      return session;
    },
    async disconnect() {
      session = null;
    },
    async getAccounts() {
      return accounts;
    },
    async signMessage(_s, _input) {
      if (options.shouldFailOnSign) throw new Error("sign rejected");
      const delay = options.signDelay ?? 0;
      if (delay > 0) await delayMs(delay);
      return `0x${"ab".repeat(32)}`;
    },
    async sendTransaction(_s, _tx) {
      if (options.shouldFailOnSend) throw new Error("tx rejected");
      sendCallCount++;
      const delay = options.sendDelay ?? 0;
      if (delay > 0) await delayMs(delay);
      return `0x${"cd".repeat(32)}`;
    },
    async switchChain(_s, _chainId) {},
    async sendCalls(_s, _calls) {
      if (options.shouldFailOnSend) throw new Error("sendCalls rejected");
      return `0x${"ef".repeat(32)}`;
    },
    async getCapabilities() {
      return {};
    },
    async getBalance() {
      return "1000000000000000000";
    },
    getSendCallCount() {
      return sendCallCount;
    },
  } as UniversalConnector & { getSendCallCount(): number };
}

// ── Batch Call Factories ───────────────────────────────────────────

export function createBatchCalls(count: number): BatchCall[] {
  return Array.from({ length: count }, (_, i) => ({
    to: `0x${(0xab + i).toString(16).repeat(40).slice(0, 40)}` as `0x${string}`,
    value: `0x${i.toString(16)}`,
    data: "0x",
  }));
}

// ── Token Config Factories ─────────────────────────────────────────

export function createTestTokenConfig(
  overrides: Partial<{
    address: `0x${string}`;
    chainId: number;
    decimals: number;
  }> = {},
) {
  return {
    address: overrides.address ?? ADDRESSES.USDC_MAINNET,
    chainId: overrides.chainId ?? 1,
    decimals: overrides.decimals ?? 6,
  };
}

// ── Utility ────────────────────────────────────────────────────────

function delayMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

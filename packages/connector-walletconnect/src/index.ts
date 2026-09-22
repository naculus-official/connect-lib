import type {
  BatchCall,
  Namespace,
  SendCallsOptions,
  SessionNamespace,
  UniversalConnector,
  UniversalWalletSession,
  WalletCapabilities,
  SessionChange,
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
  WC_DISCONNECT_USER,
  scopeRequestFrom,
} from "@naculus/connect-core";
import { base58 } from "@scure/base";
import SignClient from "@walletconnect/sign-client";
import type { ProposalTypes } from "@walletconnect/types";
import {
  type CAIP25NamespaceProposal,
  isValidCAIP2,
  validateCAIP25Proposal,
} from "./caip25";
import {
  buildOptionalNamespaces,
  buildRequiredNamespaces,
  extractAddress,
  isValidCAIP10,
  mapNamespaces,
  parseCAIP10,
  toHexValue,
  type WalletConnectConfig,
} from "./namespaces";

function toEip155HexChainId(chainId: string): string {
  if (!chainId.startsWith("eip155:")) {
    throw new WalletError(
      "chain_unsupported",
      "wallet_sendCalls only supports EVM chains.",
    );
  }
  const reference = chainId.slice("eip155:".length);
  if (!/^[1-9][0-9]*$/.test(reference)) {
    throw new WalletError("invalid_input", `Invalid EVM chain ID: ${chainId}`);
  }
  return `0x${BigInt(reference).toString(16)}`;
}

function requireEvmAddress(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new WalletError(
      "invalid_input",
      `${field} must be a 20-byte EVM address string.`,
    );
  }
  const raw = value;
  const parsed = parseCAIP10(raw);
  if (parsed && parsed.namespace !== "eip155") {
    throw new WalletError(
      "invalid_input",
      `${field} must use the eip155 namespace.`,
    );
  }
  const address = parsed ? parsed.address : raw;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new WalletError(
      "invalid_input",
      `${field} must be a 20-byte EVM address.`,
    );
  }
  return address;
}

function assertSessionTransactionFrom(
  transaction: Record<string, unknown>,
  accounts: string[],
  expectedChainId?: string,
): void {
  if (transaction.from === undefined) return;
  const rawFrom = transaction.from;
  const requested = requireEvmAddress(rawFrom, "from").toLowerCase();
  const requestedCaip =
    typeof rawFrom === "string" ? parseCAIP10(rawFrom) : undefined;
  const allowed = accounts.some((account) => {
    const parsed = parseCAIP10(account);
    if (parsed?.namespace !== "eip155") return false;
    if (requestedCaip && parsed.chainId !== requestedCaip.chainId) return false;
    if (
      expectedChainId &&
      parsed.chainId !== expectedChainId.slice("eip155:".length)
    )
      return false;
    return parsed.address.toLowerCase() === requested;
  });
  if (!allowed) {
    throw new WalletError(
      "invalid_input",
      "Transaction from must match an account approved by the WalletConnect session.",
    );
  }
}

function assertSessionEvmAddress(
  value: string,
  accounts: string[],
  field: string,
  expectedChainId?: string,
): string {
  const address = requireEvmAddress(value, field);
  const requestedCaip = parseCAIP10(value);
  const allowed = accounts.some((account) => {
    const parsed = parseCAIP10(account);
    if (parsed?.namespace !== "eip155") return false;
    if (requestedCaip && parsed.chainId !== requestedCaip.chainId) return false;
    if (
      expectedChainId &&
      parsed.chainId !== expectedChainId.slice("eip155:".length)
    )
      return false;
    return parsed.address.toLowerCase() === address.toLowerCase();
  });
  if (!allowed) {
    throw new WalletError(
      "invalid_input",
      `${field} is not an account approved by the WalletConnect session.`,
    );
  }
  return address;
}

function assertSessionSolanaAddress(
  value: string,
  accounts: string[],
  field: string,
  expectedChainId?: string,
): string {
  const requested = parseCAIP10(value);
  if (requested && requested.namespace !== "solana") {
    throw new WalletError(
      "invalid_input",
      `${field} must use the solana namespace.`,
    );
  }
  const address = requested ? requested.address : value;
  const allowed = accounts.some((account) => {
    const parsed = parseCAIP10(account);
    if (parsed?.namespace !== "solana") return false;
    if (requested && parsed.chainId !== requested.chainId) return false;
    if (
      expectedChainId &&
      `${parsed.namespace}:${parsed.chainId}` !== expectedChainId
    )
      return false;
    return parsed.address === address;
  });
  if (!allowed) {
    throw new WalletError(
      "invalid_input",
      `${field} is not an account approved by the WalletConnect session.`,
    );
  }
  return address;
}

function sessionEvmAccountForChain(
  accounts: string[],
  chainId: string,
): string | undefined {
  if (!chainId.startsWith("eip155:")) return undefined;
  const reference = chainId.slice("eip155:".length);
  const account = accounts.find((candidate) => {
    const parsed = parseCAIP10(candidate);
    return parsed?.namespace === "eip155" && parsed.chainId === reference;
  });
  return account ? requireEvmAddress(account, "account") : undefined;
}

function requireHexData(value: unknown, field: string): string {
  if (value === undefined) return "0x";
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new WalletError(
      "invalid_input",
      `${field} must be even-length hexadecimal.`,
    );
  }
  return value;
}

function normalizeBatchCall(call: BatchCall): Record<string, unknown> {
  if (call.to === undefined && call.data === undefined) {
    throw new WalletError(
      "invalid_input",
      "Call must include a 20-byte 'to' address or contract-creation data.",
    );
  }
  const normalized: Record<string, unknown> = {};
  if (call.to !== undefined)
    normalized.to = requireEvmAddress(call.to, "call.to");
  if (call.value !== undefined) {
    try {
      normalized.value = toHexValue(call.value);
    } catch (error) {
      throw new WalletError(
        "invalid_input",
        "call.value must be an EIP-1474 quantity.",
        error,
      );
    }
  }
  if (call.data !== undefined)
    normalized.data = requireHexData(call.data, "call.data");
  return normalized;
}

function normalizeEvmTransaction(
  transaction: Record<string, unknown>,
  expectedChainId?: string,
  fallbackFrom?: string,
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
    transaction.from !== undefined
      ? requireEvmAddress(transaction.from, "from")
      : fallbackFrom
        ? requireEvmAddress(fallbackFrom, "from")
        : undefined;
  if (normalized.from === undefined) delete normalized.from;
  if (transaction.to !== undefined && transaction.to !== null) {
    normalized.to = requireEvmAddress(transaction.to, "to");
  } else if (transaction.to === null) {
    delete normalized.to;
  }
  if (transaction.data !== undefined) {
    normalized.data = requireHexData(transaction.data, "data");
  }
  if (transaction.value !== undefined) {
    if (
      (typeof transaction.value === "number" &&
        (!Number.isSafeInteger(transaction.value) || transaction.value < 0)) ||
      (typeof transaction.value === "bigint" && transaction.value < 0n)
    ) {
      throw new WalletError(
        "invalid_input",
        "value must be a non-negative safe EIP-1474 quantity.",
      );
    }
    try {
      normalized.value = toHexValue(String(transaction.value));
    } catch (error) {
      throw new WalletError(
        "invalid_input",
        "value must be an EIP-1474 quantity.",
        error,
      );
    }
  }
  for (const field of [
    "chainId",
    "gas",
    "gasLimit",
    "gasPrice",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "nonce",
  ]) {
    if (normalized[field] === undefined) continue;
    const rawValue = normalized[field];
    if (
      (typeof rawValue === "number" &&
        (!Number.isSafeInteger(rawValue) || rawValue < 0)) ||
      (typeof rawValue === "bigint" && rawValue < 0n)
    ) {
      throw new WalletError(
        "invalid_input",
        `${field} must be a non-negative safe EIP-1474 quantity.`,
      );
    }
    if (
      typeof rawValue !== "string" &&
      typeof rawValue !== "number" &&
      typeof rawValue !== "bigint"
    ) {
      throw new WalletError(
        "invalid_input",
        `${field} must be an EIP-1474 quantity.`,
      );
    }
    try {
      normalized[field] = toHexValue(String(rawValue));
    } catch (error) {
      throw new WalletError(
        "invalid_input",
        `${field} must be an EIP-1474 quantity.`,
        error,
      );
    }
  }
  if (expectedChainId && normalized.chainId !== undefined) {
    if (!expectedChainId.startsWith("eip155:")) {
      throw new WalletError(
        "chain_unsupported",
        `EVM transaction cannot be sent on ${expectedChainId}.`,
      );
    }
    const expected = toHexValue(expectedChainId.slice("eip155:".length));
    if (normalized.chainId !== expected) {
      throw new WalletError(
        "invalid_input",
        "Transaction chainId does not match the requested WalletConnect chain.",
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

function extractCallBundleId(result: unknown): string {
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
    result,
  );
}

/**
 * Capabilities a wallet volunteered on the session namespace.
 *
 * Not part of CAIP-25 or EIP-5792, so it is only consulted as a fallback and
 * only when a wallet actually populated it — an empty object means the wallet
 * said nothing, not that it said no.
 */
function sessionDeclaredCapabilities(
  session: UniversalWalletSession,
): Record<string, WalletCapabilities> | undefined {
  const capabilities: Record<string, WalletCapabilities> = {};
  let declared = false;

  for (const ns of Object.values(session.namespaces)) {
    const nsCaps = (ns.capabilities ?? {}) as Record<string, unknown>;
    if (Object.keys(nsCaps).length === 0) continue;
    declared = true;
    for (const chain of ns.chains) {
      capabilities[chain] = {
        atomicBatch: { supported: Boolean(nsCaps.atomicBatch) },
        paymasterService: nsCaps.paymasterService
          ? { supported: true }
          : undefined,
      };
    }
  }

  return declared ? capabilities : undefined;
}

/** Every CAIP-10 account across a session's namespaces. */
function flattenAccounts(session: UniversalWalletSession): string[] {
  return Object.values(session.namespaces).flatMap((ns) => ns.accounts ?? []);
}

function isUnsupportedSendCallsError(error: unknown): boolean {
  const wrapped = error instanceof WalletError ? error.details : undefined;
  const original =
    wrapped && typeof wrapped === "object" && "originalError" in wrapped
      ? (wrapped as { originalError?: unknown }).originalError
      : error;
  const candidate = original && typeof original === "object" ? original : error;
  const code = (candidate as { code?: unknown } | undefined)?.code;
  if (code === -32601 || code === -32004 || code === 4200) return true;
  const message =
    candidate instanceof Error ? candidate.message : String(candidate);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("method not found") ||
    normalized.includes("not supported") ||
    normalized.includes("unsupported")
  );
}

function validateApprovedNamespaces(
  namespaces: Record<
    string,
    {
      chains?: string[];
      accounts: string[];
      methods: string[];
      events: string[];
    }
  >,
  required: ProposalTypes.RequiredNamespaces,
): string[] {
  const errors: string[] = [];
  for (const [namespace, value] of Object.entries(namespaces)) {
    for (const chain of value.chains ?? []) {
      const [chainNamespace, chainReference] = chain.split(":");
      if (
        !isValidCAIP2(chain) ||
        chainNamespace !== namespace ||
        (namespace === "eip155" && !/^[1-9][0-9]*$/.test(chainReference ?? ""))
      ) {
        errors.push(`Invalid approved ${namespace} chain: ${chain}`);
      }
    }
    for (const account of value.accounts ?? []) {
      const parsed = parseCAIP10(account);
      if (
        !parsed ||
        parsed.namespace !== namespace ||
        !value.chains?.includes(`${namespace}:${parsed.chainId}`)
      ) {
        errors.push(`Invalid approved ${namespace} account: ${account}`);
        continue;
      }
      if (
        namespace === "eip155" &&
        !/^0x[0-9a-fA-F]{40}$/.test(parsed.address)
      ) {
        errors.push(`Invalid approved EVM account: ${account}`);
      }
      if (namespace === "solana") {
        try {
          if (base58.decode(parsed.address).length !== 32)
            errors.push(`Invalid approved Solana account: ${account}`);
        } catch {
          errors.push(`Invalid approved Solana account: ${account}`);
        }
      }
    }
    if (!Array.isArray(value.methods) || !Array.isArray(value.events)) {
      errors.push(`Approved ${namespace} methods/events must be arrays`);
    }
  }
  for (const namespace of Object.keys(required)) {
    const approved = namespaces[namespace];
    if (!approved) {
      errors.push(`Missing required approved namespace: ${namespace}`);
      continue;
    }
    const requested = required[namespace];
    for (const chain of requested.chains ?? []) {
      if (!(approved.chains ?? []).includes(chain)) {
        errors.push(`Required ${namespace} chain was not approved: ${chain}`);
      }
    }
    for (const method of requested.methods ?? []) {
      if (!(approved.methods ?? []).includes(method)) {
        errors.push(`Required ${namespace} method was not approved: ${method}`);
      }
    }
    for (const event of requested.events ?? []) {
      if (!(approved.events ?? []).includes(event)) {
        errors.push(`Required ${namespace} event was not approved: ${event}`);
      }
    }
  }
  return errors;
}

export type {
  WalletConnectConfig,
  WalletConnectConnectInput,
  WalletConnectMetadata,
} from "./namespaces";
export {
  buildOptionalNamespaces,
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
type WalletConnectNamespaceLike = {
  accounts?: unknown;
  chains?: unknown;
  methods?: unknown;
  events?: unknown;
};

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];

/**
 * A session_update payload as a CAIP-25 scope. WalletConnect may omit
 * `chains` on an update (deriving them from account CAIP-10s), so chains
 * are taken from the payload when present and from the accounts otherwise;
 * methods and events fall back to what the session already holds, since an
 * update that omits them did not change them.
 */
function scopeFromWalletConnectNamespaces(
  offered: Record<string, WalletConnectNamespaceLike>,
  held: UniversalWalletSession["namespaces"],
): UniversalWalletSession["namespaces"] {
  const out: UniversalWalletSession["namespaces"] = {};
  for (const [key, value] of Object.entries(offered)) {
    const accounts = strings(value?.accounts);
    const explicitChains = strings(value?.chains);
    const chains =
      explicitChains.length > 0
        ? explicitChains
        : [...new Set(accounts.map((a) => a.split(":").slice(0, 2).join(":")))];
    out[key] = {
      chains,
      accounts,
      methods: Array.isArray(value?.methods)
        ? strings(value.methods)
        : [...(held[key]?.methods ?? [])],
      events: Array.isArray(value?.events)
        ? strings(value.events)
        : [...(held[key]?.events ?? [])],
    };
  }
  return out;
}

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
  /**
   * Identifies the current pairing attempt so a cancelled one can be told
   * apart from the live one after the fact.
   */
  private pairingGeneration = 0;
  private sessionExpiryHandler?: () => void;
  private readonly accountsSubscribers = new Set<
    (accounts: string[]) => void
  >();
  private readonly chainSubscribers = new Set<(chainId: string) => void>();
  private readonly sessionSubscribers = new Set<
    (change: SessionChange) => void
  >();

  constructor(config: WalletConnectConfig) {
    this.config = config;
    this.client = config.client;
    if (this.client) {
      this.attachSessionListeners(this.client);
    }
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

    this.attachSessionListeners(this.client);

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

    // A connector-neutral scope request maps 1:1 onto WalletConnect's
    // proposal namespaces; an explicit requiredNamespaces still wins.
    const scope = scopeRequestFrom(connectInput);
    const requiredNamespaces =
      requiredNamespacesRaw ??
      (scope?.required as ProposalTypes.RequiredNamespaces | undefined) ??
      buildRequiredNamespaces();

    const optionalNamespaces =
      optionalNamespacesRaw ??
      (scope?.optional as ProposalTypes.OptionalNamespaces | undefined) ??
      (scope?.required ? {} : buildOptionalNamespaces());
    const validation = validateCAIP25Proposal({
      requiredNamespaces: requiredNamespaces as Record<
        string,
        CAIP25NamespaceProposal
      >,
      optionalNamespaces: optionalNamespaces as Record<
        string,
        CAIP25NamespaceProposal
      >,
    });

    if (!validation.valid) {
      throw new WalletError(
        "invalid_proposal",
        `CAIP-25 validation failed: ${validation.errors.join(", ")}`,
      );
    }

    try {
      const connectParams: Record<string, unknown> = { requiredNamespaces };
      connectParams.optionalNamespaces = optionalNamespaces;
      const { uri, approval } = await client.connect(connectParams as any);
      if (uri) {
        this.lastUri = uri;
      }

      const session = await approval();
      const approvedErrors = validateApprovedNamespaces(
        session.namespaces,
        requiredNamespaces,
      );
      if (approvedErrors.length > 0) {
        throw new WalletError(
          "namespace_mismatch",
          `WalletConnect returned invalid namespaces: ${approvedErrors.join(", ")}`,
        );
      }
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
      if (error instanceof WalletError) {
        throw error;
      }
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
      const approvedErrors = validateApprovedNamespaces(existing.namespaces, {
        eip155: {
          chains: namespaces.eip155?.chains ?? [],
          methods: namespaces.eip155?.methods ?? [],
          events: namespaces.eip155?.events ?? [],
        },
      });
      if (approvedErrors.length > 0) {
        throw new WalletError(
          "namespace_mismatch",
          `WalletConnect session has invalid namespaces: ${approvedErrors.join(", ")}`,
        );
      }
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

    const accountAddress = extractAddress(rawAddress);

    // Solana chain → use solana_signMessage with base58 encoding (CAIP-25)
    // Reference: Reown AppKit's SolanaWalletConnectProvider sends
    // { message: base58.encode(message), pubkey: address }
    if (this.isSolanaChain(chainId)) {
      const messageBytes = new TextEncoder().encode(message);
      if (
        parseCAIP10(rawAddress)?.namespace === "eip155" ||
        (() => {
          try {
            return base58.decode(accountAddress).length !== 32;
          } catch {
            return true;
          }
        })()
      ) {
        throw new WalletError(
          "invalid_input",
          "Solana signing requires a 32-byte base58 public key.",
        );
      }
      const approvedAddress = assertSessionSolanaAddress(
        rawAddress,
        session.namespaces.solana?.accounts ?? [],
        "address",
        chainId,
      );
      const base58Msg = base58.encode(messageBytes);
      return this.makeRequest(
        session,
        "solana_signMessage",
        [{ message: base58Msg, pubkey: approvedAddress }],
        chainId,
      );
    }

    // Remove CAIP-10 prefix, keeping the raw EVM address.
    const address = assertSessionEvmAddress(
      rawAddress,
      session.namespaces.eip155?.accounts ?? [],
      "address",
      chainId,
    );

    // EVM signing method fallback chain:
    //   JSON messages → eth_signTypedData_v4 → eth_signTypedData
    //   Plain messages → personal_sign only (eth_sign is blind signing; removed)
    // eth_sign is deliberately absent: it signs an arbitrary 32-byte digest,
    // which can be a transaction hash. It left the default namespace in 0.2.5;
    // a consumer authorizing it in a custom namespace no longer reaches it
    // through signMessage either.
    const tryMethods = message.trimStart().startsWith("{")
      ? ["eth_signTypedData_v4", "eth_signTypedData"]
      : ["personal_sign"];

    let lastError: unknown;
    for (const tryMethod of tryMethods) {
      let tryParams: unknown[];
      if (tryMethod === "personal_sign") {
        // Ethereum JSON-RPC personal_sign is [message, account].
        tryParams = [hexEncode(message), address];
      } else {
        // eth_signTypedData(_v4) takes [address, typedData].
        // Keep the caller's serialized EIP-712 payload; WalletConnect
        // transports it without inventing or reordering domain fields.
        tryParams = [address, message];
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
    const resolvedChainId = chainId ?? this.getDefaultChainId(session);
    const fromAccount = isSolana
      ? undefined
      : sessionEvmAccountForChain(
          session.namespaces.eip155?.accounts ?? [],
          resolvedChainId,
        );
    if (!isSolana) {
      assertSessionTransactionFrom(
        transaction,
        session.namespaces.eip155?.accounts ?? [],
        resolvedChainId,
      );
      if (!fromAccount) {
        throw new WalletError(
          "session_expired",
          CONNECTOR_ERROR_MESSAGES.NO_ACCOUNT_SIGNING,
        );
      }
    }
    const tx = isSolana
      ? transaction
      : normalizeEvmTransaction(transaction, resolvedChainId, fromAccount);

    try {
      return await this.makeRequest(session, method, [tx], resolvedChainId);
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
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(signedTx)) {
      throw new WalletError(
        "invalid_input",
        "signedTransaction must be an even-length hexadecimal byte string.",
      );
    }

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
    const method = isSolana
      ? "solana_signAndSendTransaction"
      : "eth_sendTransaction";

    const resolvedChainId = chainId ?? this.getDefaultChainId(session);
    const fromAccount = isSolana
      ? undefined
      : sessionEvmAccountForChain(
          session.namespaces.eip155?.accounts ?? [],
          resolvedChainId,
        );
    if (!isSolana) {
      assertSessionTransactionFrom(
        transaction,
        session.namespaces.eip155?.accounts ?? [],
        resolvedChainId,
      );
      if (!fromAccount) {
        throw new WalletError(
          "session_expired",
          CONNECTOR_ERROR_MESSAGES.NO_ACCOUNT_TX,
        );
      }
    }
    const tx = isSolana
      ? transaction
      : normalizeEvmTransaction(transaction, resolvedChainId, fromAccount);

    try {
      return await this.makeRequest(session, method, [tx], resolvedChainId);
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
    if (!/^eip155:[1-9]\d*$/.test(chainId)) {
      throw new WalletError(
        "chain_unsupported",
        "WalletConnect switchChain only supports EVM chains.",
      );
    }

    const canonicalChainId = `eip155:${BigInt(chainId.slice("eip155:".length)).toString(10)}`;

    try {
      await this.makeRequest(
        session,
        "wallet_switchEthereumChain",
        [
          {
            chainId: `0x${BigInt(canonicalChainId.split(":")[1]).toString(16)}`,
          },
        ],
        canonicalChainId,
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
    options?: SendCallsOptions,
  ): Promise<string> {
    if (!Array.isArray(calls) || calls.length === 0) {
      throw new WalletError("invalid_input", "At least one call is required.");
    }
    const resolvedChainId = chainId ?? this.getDefaultChainId(session);
    toEip155HexChainId(resolvedChainId);
    const accounts = session.namespaces.eip155?.accounts ?? [];
    const fromAccount = sessionEvmAccountForChain(accounts, resolvedChainId);
    if (!fromAccount) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.NO_ACCOUNT_TX,
      );
    }

    try {
      const result = await this.makeRequest<unknown>(
        session,
        "wallet_sendCalls",
        [
          {
            version: "2.0.0",
            from: fromAccount,
            chainId: toEip155HexChainId(resolvedChainId),
            atomicRequired: options?.atomicRequired === true,
            calls: calls.map(normalizeBatchCall),
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
          },
        ],
        resolvedChainId,
      );
      return extractCallBundleId(result);
    } catch (error) {
      // EIP-5792 fallback is safe only when wallet_sendCalls is unavailable.
      // A user rejection or authorization error must never become transactions.
      if (!isUnsupportedSendCallsError(error)) throw error;
      // Nor may it run when the caller required atomicity: sending the calls
      // one at a time is exactly the partial execution that requirement rules
      // out, and it would be indistinguishable from success.
      if (options?.atomicRequired || options?.paymasterService) throw error;
      const txHashes: string[] = [];
      for (const call of calls) {
        const hash = await this.makeRequest<string>(
          session,
          "eth_sendTransaction",
          [
            {
              from: fromAccount,
              ...normalizeBatchCall(call),
            },
          ],
          resolvedChainId,
        );
        txHashes.push(hash);
      }
      return txHashes.length === 1 ? txHashes[0] : txHashes.join(",");
    }
  }

  /**
   * EIP-5792 `wallet_getCapabilities`.
   *
   * Asks the wallet. The previous implementation only read a non-standard
   * `capabilities` key off the CAIP-25 session namespace, which almost no
   * wallet sets, and reported `supported: false` for every chain when it was
   * absent — a fabricated negative that a caller cannot distinguish from a
   * wallet that was actually asked and said no. Wallets that do support
   * batching (Coinbase Wallet and Safe among them) were being told they do not.
   *
   * Throws when the wallet cannot answer, so `getAccountCapabilities` reports
   * `discovered: false` rather than an invented "no".
   */
  async getCapabilities(
    session: UniversalWalletSession,
  ): Promise<Record<string, WalletCapabilities>> {
    const accounts = session.namespaces.eip155?.accounts ?? [];
    const chains = session.namespaces.eip155?.chains ?? [];
    if (chains.length === 0) {
      throw new WalletError(
        "chain_unsupported",
        "wallet_getCapabilities applies to EVM chains; this session has none.",
      );
    }
    const account = sessionEvmAccountForChain(accounts, chains[0]);
    if (!account) {
      throw new WalletError(
        "session_expired",
        CONNECTOR_ERROR_MESSAGES.NO_ACCOUNT_TX,
      );
    }

    let raw: unknown;
    try {
      raw = await this.makeRequest<unknown>(
        session,
        "wallet_getCapabilities",
        [account, chains.map(toEip155HexChainId)],
        chains[0],
      );
    } catch (error) {
      // A wallet that does not implement the method has not answered "no".
      // Fall back to the session-declared capabilities only when the wallet
      // actually declared some; otherwise let the caller see "not discovered".
      if (!isUnsupportedSendCallsError(error)) throw error;
      const declared = sessionDeclaredCapabilities(session);
      if (declared) return declared;
      throw error;
    }

    return normalizeEip5792Capabilities(raw);
  }

  /**
   * EIP-5792 `wallet_showCallsStatus`.
   *
   * A request for the wallet's own UI. Nothing returns, and a refusal is
   * cosmetic — the bundle is unaffected — so the error says so rather than
   * reading like the calls failed.
   */
  async showCallsStatus(
    session: UniversalWalletSession,
    bundleHash: string,
  ): Promise<void> {
    try {
      await this.makeRequest<unknown>(session, "wallet_showCallsStatus", [
        bundleHash,
      ]);
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

  async getCallsStatus(
    session: UniversalWalletSession,
    bundleHash: string,
  ): Promise<import("@naculus/connect-core").CallsStatus> {
    return this.makeRequest<import("@naculus/connect-core").CallsStatus>(
      session,
      "wallet_getCallsStatus",
      [bundleHash],
    );
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
    if (!session.namespaces.eip155?.chains.includes(cId)) {
      throw new WalletError(
        "chain_unsupported",
        `Chain ${cId} is not approved for this session.`,
      );
    }
    const rpcUrl = DEFAULT_RPC_URLS[cId];
    if (!rpcUrl)
      throw new WalletError("chain_unsupported", "No RPC URL for chain " + cId);
    const address = sessionEvmAccountForChain(
      session.namespaces.eip155?.accounts ?? [],
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
    if (data.error) {
      throw new WalletError(
        "rpc_error",
        `RPC error: ${data.error.message ?? JSON.stringify(data.error)}`,
      );
    }
    if (typeof data.result !== "string") {
      throw new WalletError("rpc_error", "RPC returned no balance result.");
    }
    if (!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(data.result)) {
      throw new WalletError(
        "rpc_error",
        "RPC returned a non-canonical eth_getBalance quantity.",
      );
    }
    try {
      return toHexValue(data.result);
    } catch (error) {
      throw new WalletError(
        "rpc_error",
        "RPC returned a non-canonical eth_getBalance quantity.",
        error,
      );
    }
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
    const evmNamespace = session.namespaces.eip155;
    if (evmNamespace && evmNamespace.chains.length > 0) {
      return evmNamespace.chains[0];
    }

    const solanaNamespace = session.namespaces.solana;
    if (solanaNamespace && solanaNamespace.chains.length > 0) {
      return solanaNamespace.chains[0];
    }

    throw new WalletError(
      "chain_unsupported",
      "Session does not contain a supported CAIP-2 chain.",
    );
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
  private attachSessionListeners(client: SignClient): void {
    client.on("session_delete", (event: { topic: string }) => {
      if (event.topic === this.lastSession?.topic) {
        this.sessionExpiryHandler?.();
        this.notifySessionChanged({ type: "revoked", reason: "wallet" });
      }
    });
    client.on("session_expire", (event: { topic: string }) => {
      if (event.topic === this.lastSession?.topic) {
        this.sessionExpiryHandler?.();
        this.notifySessionChanged({ type: "revoked", reason: "expired" });
      }
    });
    client.on(
      "session_extend",
      (event: { topic: string; params?: { expiry?: unknown } }) => {
        if (event.topic !== this.lastSession?.topic) return;
        const expiry = event.params?.expiry;
        // WalletConnect expiry is Unix seconds.
        const expiresAt =
          typeof expiry === "number" && Number.isFinite(expiry)
            ? new Date(expiry * 1000).toISOString()
            : null;
        if (this.lastSession) this.lastSession.expiry = expiresAt ?? undefined;
        this.notifySessionChanged({ type: "expiry", expiresAt });
      },
    );

    // A wallet reports an in-wallet account switch either as a session event
    // or as a namespace update, depending on the implementation. Neither was
    // handled, so a user switching accounts in a mobile wallet left this
    // connector reporting the account approved at pairing time forever.
    client.on(
      "session_event",
      (event: {
        topic: string;
        params?: {
          event?: { name?: string; data?: unknown };
          chainId?: string;
        };
      }) => {
        if (event.topic !== this.lastSession?.topic) return;
        const name = event.params?.event?.name;
        if (name === "accountsChanged") {
          this.applyAccountsChanged(
            event.params?.event?.data,
            event.params?.chainId,
          );
          return;
        }
        if (name === "chainChanged") {
          this.applyChainChanged(
            event.params?.event?.data,
            event.params?.chainId,
          );
        }
      },
    );

    client.on(
      "session_update",
      (event: {
        topic: string;
        params?: { namespaces?: Record<string, WalletConnectNamespaceLike> };
      }) => {
        if (event.topic !== this.lastSession?.topic) return;
        const namespaces = event.params?.namespaces;
        if (!namespaces) return;
        const session = this.lastSession;
        let changed = false;
        for (const [key, value] of Object.entries(namespaces)) {
          const accounts = Array.isArray(value?.accounts)
            ? value.accounts.filter(
                (account): account is string => typeof account === "string",
              )
            : undefined;
          const target = session.namespaces[key];
          if (!accounts || !target) continue;
          if (
            target.accounts.length === accounts.length &&
            target.accounts.every((a, i) => a === accounts[i])
          ) {
            continue;
          }
          target.accounts = accounts;
          changed = true;
        }
        // The full scope the wallet now grants, for SessionManager to apply
        // fail-closed. Sent whether or not the accounts changed: a
        // session_update can also drop chains or methods.
        this.notifySessionChanged({
          type: "scope",
          namespaces: scopeFromWalletConnectNamespaces(
            namespaces as Record<string, WalletConnectNamespaceLike>,
            session.namespaces,
          ),
        });
        if (!changed) return;
        session.updatedAt = new Date().toISOString();
        this.notifyAccountsChanged(flattenAccounts(session));
      },
    );
  }

  /** UniversalConnector.onSessionChanged: CAIP-25 lifecycle from the relay. */
  onSessionChanged(
    _session: UniversalWalletSession,
    handler: (change: SessionChange) => void,
  ): () => void {
    this.sessionSubscribers.add(handler);
    return () => {
      this.sessionSubscribers.delete(handler);
    };
  }

  private notifySessionChanged(change: SessionChange): void {
    for (const subscriber of [...this.sessionSubscribers]) {
      try {
        subscriber(change);
      } catch {
        // one listener failing must not stop the others
      }
    }
  }

  /**
   * Apply an `accountsChanged` session event.
   *
   * Wallets send either bare addresses or full CAIP-10; the event's own
   * `chainId` supplies the prefix for the bare form. An address that cannot be
   * keyed to a chain is dropped rather than guessed at.
   */
  private applyAccountsChanged(data: unknown, chainId?: string): void {
    const session = this.lastSession;
    if (!session) return;

    const raw = Array.isArray(data) ? data : [data];
    const addresses = raw.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (addresses.length === 0) {
      // An empty list is the disconnect signal in the shared contract.
      this.notifyAccountsChanged([]);
      return;
    }

    const namespaceKey = chainId?.split(":")[0];
    const namespace = namespaceKey
      ? session.namespaces[namespaceKey]
      : undefined;
    if (!namespace) return;

    const chain =
      chainId && namespace.chains.includes(chainId)
        ? chainId
        : namespace.chains[0];
    if (!chain) return;

    const next = addresses.map((address) =>
      address.split(":").length === 3 ? address : `${chain}:${address}`,
    );
    if (
      namespace.accounts.length === next.length &&
      namespace.accounts.every((a, i) => a === next[i])
    ) {
      return;
    }
    namespace.accounts = next;
    session.updatedAt = new Date().toISOString();
    this.notifyAccountsChanged(flattenAccounts(session));
  }

  /**
   * Apply a `chainChanged` session event.
   *
   * The event carries a bare reference or a CAIP-2 chain; the enclosing
   * `chainId` supplies the namespace when the payload does not. Accounts are
   * re-keyed to the new chain, because a CAIP-10 account is only meaningful
   * against the chain in its own prefix.
   */
  private applyChainChanged(data: unknown, eventChainId?: string): void {
    const session = this.lastSession;
    if (!session) return;

    const namespaceKey = eventChainId?.split(":")[0];
    const raw = typeof data === "string" ? data : eventChainId;
    if (!raw || !namespaceKey) return;

    const next = raw.includes(":") ? raw : `${namespaceKey}:${raw}`;
    if (!isValidCAIP2(next)) return;

    const namespace = session.namespaces[namespaceKey];
    if (!namespace || namespace.chains[0] === next) return;

    namespace.chains = [next, ...namespace.chains.filter((c) => c !== next)];
    namespace.accounts = namespace.accounts.map((account) => {
      const address = account.split(":").pop();
      return address ? `${next}:${address}` : account;
    });
    session.updatedAt = new Date().toISOString();
    this.notifyChainChanged(next);
    this.notifyAccountsChanged(flattenAccounts(session));
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
   * UniversalConnector.onAccountsChanged.
   *
   * The session is updated before subscribers run.
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

  private notifyAccountsChanged(accounts: string[]): void {
    for (const subscriber of [...this.accountsSubscribers]) {
      try {
        subscriber(accounts);
      } catch {
        // One bad subscriber must not stop the others from being told.
      }
    }
  }

  private isSolanaChain(chainId: string | undefined): boolean {
    return chainId?.startsWith("solana:") ?? false;
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

    if (this.isSolanaChain(chainId)) {
      throw new WalletError(
        "method_not_allowed",
        "signTypedData not supported for Solana.",
      );
    }
    const address = assertSessionEvmAddress(
      rawAddress,
      session.namespaces.eip155?.accounts ?? [],
      "address",
      chainId,
    );

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
    if (!isValidCAIP2(resolvedChainId)) {
      throw new WalletError(
        "invalid_input",
        `Invalid CAIP-2 chain ID: ${resolvedChainId}`,
      );
    }
    const namespace = resolvedChainId.slice(0, resolvedChainId.indexOf(":"));
    if (!session.namespaces[namespace]?.chains.includes(resolvedChainId)) {
      throw new WalletError(
        "chain_unsupported",
        `Chain ${resolvedChainId} is not approved for this session.`,
      );
    }

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
    // Same proposal as connect(). This path used to send only the required
    // namespaces, so a user who paired by scanning the QR got a session
    // limited to eip155:1 and could not use any other chain, and the CAIP-25
    // check that connect() runs was skipped entirely.
    const requiredNamespaces = buildRequiredNamespaces();
    const optionalNamespaces = buildOptionalNamespaces();
    const validation = validateCAIP25Proposal({
      requiredNamespaces: requiredNamespaces as Record<
        string,
        CAIP25NamespaceProposal
      >,
      optionalNamespaces: optionalNamespaces as Record<
        string,
        CAIP25NamespaceProposal
      >,
    });
    if (!validation.valid) {
      throw new WalletError(
        "invalid_proposal",
        `CAIP-25 validation failed: ${validation.errors.join(", ")}`,
      );
    }
    const result = await client.connect({
      requiredNamespaces,
      optionalNamespaces,
    });
    if (!result.uri) throw new WalletError("wallet_unavailable", "No URI");
    this.lastUri = result.uri;
    const generation = ++this.pairingGeneration;
    const approval = result.approval as unknown as () => Promise<{
      topic?: string;
    }>;

    // If the user cancels while the wallet is still deciding, the approval
    // promise keeps running and the wallet can still accept. Watch it here so
    // a session that arrives for a cancelled attempt is torn down instead of
    // silently staying live — a user who declined must not end up connected.
    // Guard the watcher itself: startPairing must still return the URI even if
    // the client hands back something that is not a promise. Losing the
    // late-approval teardown is bad; failing to show the QR at all is worse.
    const watched = (() => {
      try {
        return approval();
      } catch {
        return undefined;
      }
    })();

    void Promise.resolve(watched)
      .then(async (approved) => {
        if (this.pairingGeneration === generation) return;
        const topic = approved?.topic;
        if (!topic) return;
        try {
          const client = await this.getClient();
          await client.disconnect({
            topic,
            reason: {
              code: WC_DISCONNECT_USER,
              message: "Pairing cancelled by user",
            },
          });
        } catch {
          // Nothing further to do: the session was never surfaced to the app.
        }
      })
      .catch(() => {
        // A rejected approval on a cancelled attempt needs no handling.
      });

    this.pendingApproval =
      result.approval as unknown as () => Promise<UniversalWalletSession>;
    return result.uri;
  }

  /**
   * Complete pairing after user scans QR code
   * Should be called after displaying the QR and user has scanned it
   */
  /**
   * Abandon an in-flight pairing.
   *
   * WalletConnect offers no way to withdraw a proposal once the URI is out, so
   * cancelling cannot stop a wallet from approving. What it can do is refuse
   * to hand the session to the app and disconnect it the moment it arrives,
   * which is the behavior a user pressing "cancel" is entitled to.
   */
  cancelPairing(): void {
    this.pairingGeneration += 1;
    this.pendingApproval = undefined;
    this.lastUri = undefined;
  }

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
    if (!pendingNamespaces || typeof pendingNamespaces !== "object") {
      throw new WalletError(
        "namespace_mismatch",
        "WalletConnect pairing returned no namespaces.",
      );
    }
    const approvedErrors = validateApprovedNamespaces(
      pendingNamespaces,
      buildRequiredNamespaces(),
    );
    if (approvedErrors.length > 0) {
      throw new WalletError(
        "namespace_mismatch",
        `WalletConnect returned invalid namespaces: ${approvedErrors.join(", ")}`,
      );
    }
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

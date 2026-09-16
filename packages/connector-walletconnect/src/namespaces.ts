import type { Namespace, SessionNamespace } from "@naculus/connect-core";
import { SOLANA_TESTNET } from "@naculus/connect-core";
import type SignClient from "@walletconnect/sign-client";
import type { ProposalTypes } from "@walletconnect/types";

/**
 * WalletConnect v2 configuration metadata
 */
export type WalletConnectMetadata = {
  /** Application name displayed in WalletConnect modal */
  name: string;
  /** Application description */
  description: string;
  /** Application website URL */
  url: string;
  /** Application icon URLs */
  icons: string[];
};

/**
 * Configuration options for WalletConnectConnector
 */
export type WalletConnectConfig = {
  /** WalletConnect v2 project ID from cloud.walletconnect.com */
  projectId: string;
  /** Optional custom relay URL (defaults to WalletConnect cloud) */
  relayUrl?: string;
  /** Application metadata for WalletConnect pairing */
  metadata: WalletConnectMetadata;
  /** Pre-initialized SignClient instance (for testing) */
  client?: SignClient;
};

/**
 * Input options for connect method
 */
export type WalletConnectConnectInput = {
  /** Custom required namespaces override */
  requiredNamespaces?: ProposalTypes.RequiredNamespaces;
  /** Optional namespaces (informational validation only) */
  optionalNamespaces?: ProposalTypes.OptionalNamespaces;
};

/** Default EVM RPC methods for WalletConnect */
export const DEFAULT_EVM_METHODS = [
  "eth_accounts",
  "eth_requestAccounts",
  "personal_sign",
  "eth_signTypedData",
  "eth_signTransaction",
  "eth_sendTransaction",
  "eth_sendRawTransaction",
  "eth_signTypedData_v4",
  "wallet_switchEthereumChain",
] as const;

/** Methods needed for the default connection flow. Extra methods stay optional
 * so wallets that do not implement raw/transaction signing can still connect. */
export const REQUIRED_EVM_METHODS = [
  "personal_sign",
  "eth_sendTransaction",
] as const;

export const REQUIRED_EVM_EVENTS = ["accountsChanged", "chainChanged"] as const;

/** Default EVM event subscriptions */
export const DEFAULT_EVM_EVENTS = [
  "accountsChanged",
  "chainChanged",
  "disconnect",
  "connect",
  "message",
] as const;

/** Default Solana methods for WalletConnect */
export const DEFAULT_SOLANA_METHODS = [
  "solana_getAccounts",
  "solana_requestAccounts",
  "solana_signMessage",
  "solana_signTransaction",
  "solana_signAllTransactions",
  "solana_signAndSendTransaction",
] as const;

/** Default Solana event subscriptions */
export const DEFAULT_SOLANA_EVENTS = [
  "accountsChanged",
  "chainChanged",
  "disconnect",
] as const;

export function toHexValue(value: string): string {
  if (/^0x[0-9a-fA-F]+$/.test(value)) {
    return `0x${BigInt(value).toString(16)}`;
  }
  if (/^\d+$/.test(value)) return `0x${BigInt(value).toString(16)}`;
  throw new Error(`Invalid EIP-1474 quantity: ${value}`);
}

// ── CAIP-10 Helpers ─────────────────────────────────────────────────────

/**
 * Parses a CAIP-10 address (namespace:chainId:address) into components.
 * Returns undefined if the address doesn't match CAIP-10 format.
 */
export function parseCAIP10(
  caip10: string,
): { namespace: string; chainId: string; address: string } | undefined {
  const parts = caip10.split(":");
  // CAIP-10: namespace:chainId:address (3 parts)
  if (
    parts.length === 3 &&
    /^[-a-z0-9]{3,8}$/.test(parts[0]) &&
    /^[-_a-zA-Z0-9]{1,32}$/.test(parts[1]) &&
    /^[-.%a-zA-Z0-9]{1,128}$/.test(parts[2])
  ) {
    if (
      parts[0] === "eip155" &&
      // CAIP-10 reserves chain reference 0 for an EOA used in an
      // off-chain context (e.g. EIP-4361). It is a valid account ID,
      // although it must never be used as a transaction/session chain.
      (!/^(?:0|[1-9][0-9]*)$/.test(parts[1]) ||
        !/^0x[0-9a-fA-F]{40}$/.test(parts[2]))
    ) {
      return undefined;
    }
    return { namespace: parts[0], chainId: parts[1], address: parts[2] };
  }
  return undefined;
}

/**
 * Extracts the raw address from a CAIP-10 string.
 * If already a plain address, returns it as-is.
 */
export function extractAddress(caipOrAddress: string): string {
  const parsed = parseCAIP10(caipOrAddress);
  return parsed ? parsed.address : caipOrAddress;
}

/**
 * Builds a CAIP-10 address string from components.
 */
export function buildCAIP10(
  namespace: string,
  chainId: string,
  address: string,
): string {
  // CAIP-10 EIP-155 account IDs retain the `0x` address prefix. Removing it
  // creates an identifier that public wallets and other CAIP consumers reject.
  const normalizedAddress =
    namespace === "eip155" && !/^0x/i.test(address) ? `0x${address}` : address;
  if (!/^[-a-z0-9]{3,8}$/.test(namespace)) {
    throw new Error(`Invalid CAIP-10 namespace: ${namespace}`);
  }
  if (!/^[-_a-zA-Z0-9]{1,32}$/.test(chainId)) {
    throw new Error(`Invalid CAIP-10 chain reference: ${chainId}`);
  }
  if (namespace === "eip155" && !/^(?:0|[1-9][0-9]*)$/.test(chainId)) {
    throw new Error(`Invalid EIP-155 chain reference: ${chainId}`);
  }
  if (
    namespace === "eip155" &&
    !/^0x[0-9a-fA-F]{40}$/.test(normalizedAddress)
  ) {
    throw new Error(`Invalid EIP-155 account address: ${address}`);
  }
  if (!/^[-.%a-zA-Z0-9]{1,128}$/.test(normalizedAddress)) {
    throw new Error(`Invalid CAIP-10 account address: ${address}`);
  }
  return `${namespace}:${chainId}:${normalizedAddress}`;
}

/**
 * Resolves an account address to its CAIP-10 representation using the session's
 * namespace information. If no matching namespace is found, returns the raw address.
 */
export function resolveCAIP10(
  address: string,
  namespaces: Record<string, { chains?: string[]; accounts: string[] }>,
  preferredNamespace?: string,
): string {
  // If already CAIP-10, return as-is
  if (address.includes(":")) {
    if (parseCAIP10(address)) return address;
    throw new Error(`Invalid CAIP-10 account: ${address}`);
  }

  const nsKeys = preferredNamespace
    ? [
        preferredNamespace,
        ...Object.keys(namespaces).filter((k) => k !== preferredNamespace),
      ]
    : Object.keys(namespaces);

  for (const ns of nsKeys) {
    const nsData = namespaces[ns];
    if (!nsData) continue;

    for (const account of nsData.accounts) {
      const parsed = parseCAIP10(account);
      const matches =
        parsed &&
        (parsed.namespace === "eip155"
          ? parsed.address.toLowerCase() === address.toLowerCase()
          : parsed.address === address);
      if (matches) {
        return account;
      }
    }

    // If chains exist, construct from first chain
    if (nsData.chains && nsData.chains.length > 0) {
      return buildCAIP10(
        ns,
        nsData.chains[0].split(":")[1] || nsData.chains[0],
        address,
      );
    }
  }

  // Never invent a chain when the session did not identify one. A mainnet
  // default would create a valid-looking but incorrect CAIP-10 account.
  throw new Error(
    "Cannot resolve address to CAIP-10 without a matching namespace or chain.",
  );
}

/**
 * Resolves multiple accounts to their CAIP-10 representations.
 */
export function resolveCAIP10List(
  addresses: string[],
  namespaces: Record<string, { chains?: string[]; accounts: string[] }>,
): string[] {
  return addresses.map((addr) => resolveCAIP10(addr, namespaces));
}

/**
 * Validates a CAIP-10 address string.
 * Format: namespace:chainId:address
 */
export function isValidCAIP10(addr: string): boolean {
  return parseCAIP10(addr) !== undefined;
}

/**
 * Maps WalletConnect namespace format to SDK namespace format
 * @param namespaces - Raw namespace object from WalletConnect session
 * @returns Normalized namespace record
 */
export function mapNamespaces(
  namespaces: Record<
    string,
    {
      chains?: string[];
      accounts: string[];
      methods: string[];
      events: string[];
      capabilities?: Record<string, unknown>;
    }
  >,
): Record<Namespace, SessionNamespace> {
  return Object.entries(namespaces).reduce<Record<Namespace, SessionNamespace>>(
    (acc, [key, value]) => {
      acc[key as Namespace] = {
        chains: value.chains ?? [],
        accounts: value.accounts,
        methods: value.methods,
        events: value.events,
        capabilities: value.capabilities ?? {},
      };

      return acc;
    },
    {} as Record<Namespace, SessionNamespace>,
  );
}

/**
 * Builds the minimal default required namespace. Keeping only Ethereum
 * mainnet required lets a standard EVM wallet approve the session; additional
 * chains and Solana are advertised as optional below.
 */
export function buildRequiredNamespaces(): ProposalTypes.RequiredNamespaces {
  return {
    eip155: {
      chains: ["eip155:1"],
      methods: [...REQUIRED_EVM_METHODS],
      events: [...REQUIRED_EVM_EVENTS],
    },
  };
}

/** Optional chains advertised by the default WalletConnect proposal. */
export function buildOptionalNamespaces(): ProposalTypes.OptionalNamespaces {
  return {
    eip155: {
      chains: [
        "eip155:11155111", // Sepolia Testnet
        "eip155:137", // Polygon Mainnet
        "eip155:42161", // Arbitrum One
        "eip155:10", // Optimism
        "eip155:8453", // Base
      ],
      methods: [...DEFAULT_EVM_METHODS],
      events: [...DEFAULT_EVM_EVENTS],
    },
    solana: {
      chains: [
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", // Solana Mainnet
        "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", // Solana Devnet
        SOLANA_TESTNET,
      ],
      methods: [...DEFAULT_SOLANA_METHODS],
      events: [...DEFAULT_SOLANA_EVENTS],
    },
  };
}

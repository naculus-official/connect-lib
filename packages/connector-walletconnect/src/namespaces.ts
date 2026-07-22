import type { Namespace, SessionNamespace } from "@naculus/connect-core";
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
  "eth_sign",
  "eth_signTransaction",
  "eth_sendTransaction",
  "eth_sendRawTransaction",
  "eth_signTypedData_v4",
  "wallet_switchEthereumChain",
] as const;

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
  "solana_signMessage",
  "solana_signTransaction",
  "solana_sendTransaction",
] as const;

/** Default Solana event subscriptions */
export const DEFAULT_SOLANA_EVENTS = ["accountChanged", "disconnect"] as const;

export function toHexValue(value: string): string {
  if (value.startsWith("0x")) return value;
  return `0x${BigInt(value).toString(16)}`;
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
  if (parts.length === 3) {
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
  const cleanAddress = address.replace(/^0x/, "");
  return `${namespace}:${chainId}:${cleanAddress}`;
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
  if (address.includes(":") && address.split(":").length === 3) {
    return address;
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
      if (parsed && parsed.address.toLowerCase() === address.toLowerCase()) {
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

  // Fallback: use eip155:1 as default
  return buildCAIP10("eip155", "1", address);
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
  return addr.includes(":") && addr.split(":").length === 3;
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
 * Builds default required namespaces for EIP-155 and Solana
 * Includes mainnet, testnet, and popular L2 chains
 */
export function buildRequiredNamespaces(): ProposalTypes.RequiredNamespaces {
  return {
    eip155: {
      chains: [
        "eip155:1", // Ethereum Mainnet
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
        "solana:0", // Solana Mainnet
        "solana:1", // Solana Devnet
        "solana:2", // Solana Testnet
      ],
      methods: [...DEFAULT_SOLANA_METHODS],
      events: [...DEFAULT_SOLANA_EVENTS],
    },
  };
}

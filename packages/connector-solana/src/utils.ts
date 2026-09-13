import {
  SOLANA_DEVNET,
  SOLANA_MAINNET,
  SOLANA_TESTNET,
} from "@naculus/connect-core";
/**
 * Known Solana cluster genesis hashes, keyed by the CAIP-2 reference.
 *
 * CAIP-2's Solana namespace uses the first 32 characters of the cluster
 * genesis hash; numeric aliases such as `solana:0` are not canonical IDs.
 */
export const GENESIS_HASHES: Record<string, { hash: string; rpc: string }> = {
  [SOLANA_MAINNET]: {
    hash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    rpc: "https://api.mainnet-beta.solana.com",
  },
  [SOLANA_DEVNET]: {
    hash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    rpc: "https://api.devnet.solana.com",
  },
  [SOLANA_TESTNET]: {
    hash: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
    rpc: "https://api.testnet.solana.com",
  },
};

/** Reverse lookup: genesis hash → CAIP-2 chain ID. */
export const HASH_TO_CHAIN: Record<string, string> = {};
for (const [chain, info] of Object.entries(GENESIS_HASHES)) {
  HASH_TO_CHAIN[info.hash.slice(0, 32)] = chain;
}

/**
 * Query a Solana RPC endpoint for its genesis hash and return the matching
 * CAIP-2 chain ID.  The RPC response is authoritative: if it cannot be
 * verified, this function throws instead of guessing from configuration.
 *
 * Uses plain fetch() instead of @solana/web3.js to avoid loading the
 * entire (~500KB) bundle just for a single RPC call.
 */
export async function resolveSolanaChain(rpcUrl: string): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getGenesisHash",
      params: [],
    }),
  });
  if (!res.ok) {
    throw new Error(`Solana RPC returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as { result?: unknown };
  if (typeof data.result !== "string" || data.result.length < 32) {
    throw new Error("Solana RPC returned no valid genesis hash");
  }
  const chain = HASH_TO_CHAIN[data.result.slice(0, 32)];
  if (!chain) {
    throw new Error("Unknown Solana genesis hash");
  }
  return chain;
}

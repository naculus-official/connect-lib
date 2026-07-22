/** Known genesis hashes for Solana clusters, keyed by CAIP-2 chain ID. */
export const GENESIS_HASHES: Record<string, { hash: string; rpc: string }> = {
  "solana:0": {
    hash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    rpc: "https://api.mainnet-beta.solana.com",
  },
  "solana:1": {
    hash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    rpc: "https://api.devnet.solana.com",
  },
  "solana:2": {
    hash: "4uhcVJyU9pJkvQyS88uRDis2L8SZfzWU7Z8B5Qv7yqG",
    rpc: "https://api.testnet.solana.com",
  },
};

/** Reverse lookup: genesis hash → CAIP-2 chain ID. */
export const HASH_TO_CHAIN: Record<string, string> = {};
for (const [chain, info] of Object.entries(GENESIS_HASHES)) {
  HASH_TO_CHAIN[info.hash] = chain;
}

/**
 * Query a Solana RPC endpoint for its genesis hash and return the matching
 * CAIP-2 chain ID.  Falls back to `defaultChain` on error.
 *
 * Uses plain fetch() instead of @solana/web3.js to avoid loading the
 * entire (~500KB) bundle just for a single RPC call.
 */
export async function resolveSolanaChain(
  rpcUrl: string,
  defaultChain: string,
): Promise<string> {
  try {
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
    const data = (await res.json()) as { result?: string };
    return data.result
      ? (HASH_TO_CHAIN[data.result] ?? defaultChain)
      : defaultChain;
  } catch {
    return defaultChain;
  }
}

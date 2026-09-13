import { CHAINS } from "./chain-registry";

/** Optional freshness policy for an oracle response. */
export interface NativeTokenPriceOptions {
  /** Reject a response older than this many seconds. */
  maxAgeSeconds?: number;
}

function caip2ToChainId(caip2: string): number | null {
  if (typeof caip2 !== "string" || !/^eip155:[1-9][0-9]*$/.test(caip2)) {
    return null;
  }
  const value = BigInt(caip2.slice("eip155:".length));
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}

/**
 * Get the USD price of a native token (e.g. ETH, POL) by chain ID.
 *
 * This function was missing from the source but exists in the dist build.
 * It was added to the Storybook Vite bridge to unblock storybook-based testing.
 *
 * @param chain - EIP-155 chain ID (e.g. "eip155:1")
 * @param rpcUrl - Optional RPC URL for on-chain price lookup
 * @returns USD price as a number, or null if unavailable
 */
export async function getNativeTokenPriceUsd(
  chain: string,
  _rpcUrl?: string,
  options?: NativeTokenPriceOptions,
): Promise<number | null> {
  const chainId = caip2ToChainId(chain);
  if (chainId === null) return null;
  const info = CHAINS[chainId];
  const feedAddress = info?.chainlinkEthUsdFeed;
  if (!feedAddress || typeof _rpcUrl !== "string" || _rpcUrl.trim() === "") {
    return null;
  }
  if (
    options?.maxAgeSeconds !== undefined &&
    (!Number.isFinite(options.maxAgeSeconds) || options.maxAgeSeconds < 0)
  ) {
    return null;
  }

  try {
    const latestResult = await callAggregator(
      _rpcUrl,
      feedAddress,
      "0xfeaf968c", // latestRoundData()
    );
    const latestWords = decodeWords(latestResult, 5);
    if (!latestWords) return null;

    const roundId = BigInt(`0x${latestWords[0]}`);
    const unsignedAnswer = BigInt(`0x${latestWords[1]}`);
    const answer =
      unsignedAnswer >= 1n << 255n
        ? unsignedAnswer - (1n << 256n)
        : unsignedAnswer;
    const updatedAt = BigInt(`0x${latestWords[3]}`);
    const answeredInRound = BigInt(`0x${latestWords[4]}`);

    // Chainlink's standard feed validity conditions. A zero/negative answer,
    // uninitialized round, or incomplete round is not a usable price.
    if (
      roundId === 0n ||
      answer <= 0n ||
      updatedAt === 0n ||
      answeredInRound < roundId
    ) {
      return null;
    }

    if (options?.maxAgeSeconds !== undefined) {
      const now = Math.floor(Date.now() / 1000);
      const updatedAtNumber = Number(updatedAt);
      if (
        !Number.isSafeInteger(updatedAtNumber) ||
        updatedAtNumber > now + 60 ||
        now - updatedAtNumber > options.maxAgeSeconds
      ) {
        return null;
      }
    }

    const decimalsResult = await callAggregator(
      _rpcUrl,
      feedAddress,
      "0x313ce567", // decimals()
    );
    const decimalsWords = decodeWords(decimalsResult, 1);
    if (!decimalsWords) return null;
    const decimals = BigInt(`0x${decimalsWords[0]}`);
    if (decimals > 100n) return null;

    const price = Number(answer) / 10 ** Number(decimals);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

async function callAggregator(
  rpcUrl: string,
  feedAddress: string,
  data: string,
): Promise<string | null> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: feedAddress, data }, "latest"],
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return null;
  const json = (await response.json()) as { result?: unknown; error?: unknown };
  if (json.error || typeof json.result !== "string") return null;
  return json.result;
}

function decodeWords(result: string | null, count: number): string[] | null {
  if (
    result === null ||
    !/^0x[0-9a-fA-F]*$/.test(result) ||
    (result.length - 2) % 64 !== 0 ||
    result.length < 2 + count * 64
  ) {
    return null;
  }
  const hex = result.slice(2);
  return Array.from({ length: count }, (_, index) =>
    hex.slice(index * 64, (index + 1) * 64),
  );
}

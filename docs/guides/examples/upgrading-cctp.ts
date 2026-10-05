// Example for docs/guides/upgrading-to-0.11.md (CCTP V2 bridge, 0.11.0+).
// Typechecked by the root `tsc --noEmit`; not shipped in any package.
import { CHAINS, type Token } from "@naculus/connect-core";
import {
  CctpBridgeProvider,
  waitForCctpAttestation,
} from "@naculus/connect-core/cctp";

/** Sends one transaction with the app's wallet and returns its hash. */
type SendTransaction = (tx: {
  to: `0x${string}`;
  data: `0x${string}`;
  chainId?: number;
}) => Promise<string>;

function usdc(chainId: number): Token {
  const address = CHAINS[chainId]?.usdcAddress;
  if (!address) throw new Error(`no USDC on chain ${chainId}`);
  return { chainId, address, decimals: 6, symbol: "USDC", variant: "native" };
}

/** Sepolia → Base Sepolia; the recipient needs no Base Sepolia ETH. */
export async function bridgeUsdc(
  send: SendTransaction,
  recipient: string,
  amount: bigint, // USDC base units burned on Sepolia
) {
  const cctp = new CctpBridgeProvider(); // forwarding + fast transfer
  const quote = await cctp.estimate({
    amount,
    fromChain: { chainId: 11155111 },
    toChain: { chainId: 84532 },
    fromToken: usdc(11155111),
    toToken: usdc(84532),
    recipient,
  });
  // Two steps: approve(exact amount), then depositForBurnWithHook.
  let burnTx = "";
  for (const step of quote.steps) {
    if (step.transaction) burnTx = await send(step.transaction);
  }
  // Bounded (30 minutes by default): throws on timeout, never a partial result.
  await waitForCctpAttestation({ sourceChainId: 11155111, txHash: burnTx });
  return quote.outputAmount; // at least this much is minted to `recipient`
}

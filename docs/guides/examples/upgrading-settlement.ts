// Example for docs/guides/upgrading-to-0.10.md (settlement verification,
// 0.8.0+). Typechecked by the root `tsc --noEmit`; not shipped in any package.
import type { SettlementRpc } from "@naculus/connect-core";
import {
  type MppFetchResult,
  verifyMppSettlement,
} from "@naculus/payments-mpp";
import {
  verifyX402Settlement,
  type X402FetchResult,
} from "@naculus/payments-x402";

/**
 * Fetch never verifies. After a paid fetch, check the receipt on chain
 * yourself, against what the client signed (`result.settlementBinding`).
 */
export async function isSettled(
  result: X402FetchResult | MppFetchResult,
  rpc: SettlementRpc, // a JSON-RPC endpoint for the chain that settled
): Promise<boolean> {
  const verification =
    "settlement" in result
      ? await verifyX402Settlement(result, rpc)
      : await verifyMppSettlement(result, rpc);
  // "pending" may be retried later; "failed", "mismatch" and "unavailable"
  // are not proof of payment.
  return verification.status === "verified";
}

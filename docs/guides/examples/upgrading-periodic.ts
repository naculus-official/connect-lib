// Example for docs/guides/upgrading-to-0.10.md (periodic limits, 0.10.0+).
// Typechecked by the root `tsc --noEmit`; not shipped in any package.
import {
  type Authorization,
  compileEvmSessionScope,
} from "@naculus/connect-core";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const OWNER = "0x2222222222222222222222222222222222222222";
const MERCHANT = "0x1111111111111111111111111111111111111111";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia
const DAY = 86_400;
const client = createPublicClient({ chain: baseSepolia, transport: http() });

export async function compileSubscription(userAway: boolean) {
  // start from chain time (latest block), never Date.now(); it must be > 0.
  const start = Number((await client.getBlock()).timestamp);
  const authorization: Authorization = {
    version: 1,
    principal: `eip155:${baseSepolia.id}:${OWNER}`,
    grants: [
      {
        asset: `eip155:${baseSepolia.id}/erc20:${USDC}`,
        recipients: [MERCHANT],
        maxPerPayment: 10_000_000n, // = period.amount, so the chain can hold it
        maxTotal: 120_000_000n,
        period: { amount: 10_000_000n, seconds: 30 * DAY, start },
        rails: ["transfer"],
      },
    ],
    expiresAt: start + 365 * DAY,
  };
  // User present: device enforcement ("device"). User away: the chain must
  // enforce it ("on-chain"); requireOnChain refuses anything device-only.
  return userAway
    ? compileEvmSessionScope(authorization, baseSepolia.id, {
        mode: "eip7702",
        requireOnChain: true,
      })
    : compileEvmSessionScope(authorization, baseSepolia.id);
}

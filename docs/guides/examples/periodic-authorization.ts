// Example for docs/guides/periodic-authorization.md. Typechecked by the root
// `tsc --noEmit`; not shipped in any package.
import {
  type Authorization,
  compileEvmSessionScope,
  delegationTypedData,
  evaluateSpend,
  type SessionKeyManager,
  validateAuthorization,
} from "@naculus/connect-core";
import { createPublicClient, type Hex, http } from "viem";
import { baseSepolia } from "viem/chains";

const OWNER = "0x2222222222222222222222222222222222222222";
const MERCHANT = "0x1111111111111111111111111111111111111111";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia
const DAY = 86_400;

const client = createPublicClient({ chain: baseSepolia, transport: http() });

/**
 * Period 0 starts at the latest block's timestamp, never at Date.now(): the
 * on-chain enforcer compares block.timestamp, which trails the device clock,
 * and refuses a start in its future as `transfer-not-started`.
 */
export async function periodStart(): Promise<number> {
  const block = await client.getBlock({ blockTag: "latest" });
  return Number(block.timestamp); // always > 0, as the enforcer requires
}

/** "At most 10 USDC per 30 days, 120 USDC in total, for one year." */
export async function subscription(): Promise<Authorization> {
  const start = await periodStart();
  return {
    version: 1,
    principal: `eip155:${baseSepolia.id}:${OWNER}`,
    label: "Example Pro, monthly",
    grants: [
      {
        asset: `eip155:${baseSepolia.id}/erc20:${USDC}`,
        recipients: [MERCHANT],
        maxPerPayment: 10_000_000n, // 10 USDC (6 decimals)
        maxTotal: 120_000_000n,
        period: { amount: 10_000_000n, seconds: 30 * DAY, start },
        rails: ["transfer"],
      },
    ],
    expiresAt: start + 365 * DAY,
  };
}

export async function preview(authorization: Authorization) {
  const checked = validateAuthorization(authorization);
  if (!checked.ok) throw new Error(checked.reason);
  // Same verdict the enforcer gives. Feed the period spend from the usage
  // record of the period `at` falls in; omitting it refuses.
  return evaluateSpend(checked.authorization, {
    asset: `eip155:${baseSepolia.id}/erc20:${USDC}`,
    recipient: MERCHANT,
    amount: 10_000_000n,
    rail: "transfer",
    at: Math.floor(Date.now() / 1000),
    spentSoFar: 0n,
    countSoFar: 0,
    periodSpentSoFar: 0n,
  }); // { allow: true, grant: 0 }
}

/** The user is present: the device enforces the period before signing. */
export async function createDeviceKey(
  authorization: Authorization,
  keys: SessionKeyManager,
) {
  const compiled = compileEvmSessionScope(authorization, baseSepolia.id);
  if (!compiled.ok) throw new Error(compiled.reason);
  // compiled.enforcement === "device"
  return keys.createSessionKey(compiled.scope, OWNER);
}

/**
 * The user is away (a merchant server charges): the chain must enforce it.
 * `requireOnChain` refuses anything the delegation's caveats cannot hold.
 */
export async function createOnChainKey(
  authorization: Authorization,
  keys: SessionKeyManager,
  signTypedData: (
    typedData: ReturnType<typeof delegationTypedData>,
  ) => Promise<Hex>,
) {
  const compiled = compileEvmSessionScope(authorization, baseSepolia.id, {
    mode: "eip7702",
    requireOnChain: true,
  });
  if (!compiled.ok) throw new Error(compiled.reason);
  // compiled.enforcement === "on-chain"
  const key = await keys.createSessionKey(compiled.scope, OWNER);
  const delegation = await keys.prepareDelegation(key.id, baseSepolia.id);
  // The owner's wallet signs the delegation (eth_signTypedData_v4).
  const signature = await signTypedData(delegationTypedData(delegation));
  await keys.attachDelegation(key.id, delegation, signature);
  return key;
}

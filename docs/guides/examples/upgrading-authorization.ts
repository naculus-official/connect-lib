// Example for docs/guides/upgrading-to-0.10.md (authorization model, 0.8.0+).
// Typechecked by the root `tsc --noEmit`; not shipped in any package.
import {
  type Authorization,
  compileEvmSessionScope,
  evaluateSpend,
  listAuthorizations,
  revokeListedAuthorization,
  type SessionKeyManager,
  validateAuthorization,
} from "@naculus/connect-core";

const OWNER = "0x2222222222222222222222222222222222222222";
const MERCHANT = "0x1111111111111111111111111111111111111111";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base
const ASSET = `eip155:8453/erc20:${USDC}`;

/** Declare once: at most 5 USDC per payment, 50 USDC in total, to MERCHANT. */
export async function grantAndCreateKey(keys: SessionKeyManager, now: number) {
  const authorization: Authorization = {
    version: 1,
    principal: `eip155:8453:${OWNER}`,
    grants: [
      {
        asset: ASSET,
        recipients: [MERCHANT],
        maxPerPayment: 5_000_000n,
        maxTotal: 50_000_000n,
        rails: ["transfer"],
      },
    ],
    expiresAt: now + 7 * 86_400,
  };
  const checked = validateAuthorization(authorization); // fail-closed
  if (!checked.ok) throw new Error(checked.reason);
  // Preview a payment with the same verdict the enforcer gives.
  const verdict = evaluateSpend(checked.authorization, {
    asset: ASSET,
    recipient: MERCHANT,
    amount: 5_000_000n,
    rail: "transfer",
    at: now,
    spentSoFar: 0n,
    countSoFar: 0,
  }); // { allow: true, grant: 0 }
  // Compile to the existing EVM session-key enforcer (refuses, never widens).
  const compiled = compileEvmSessionScope(checked.authorization, 8453);
  if (!compiled.ok) throw new Error(compiled.reason);
  const key = await keys.createSessionKey(compiled.scope, OWNER);
  return { verdict, key };
}

/** One view across the managers you pass; revoke through the owning one. */
export async function revokeAllFor(keys: SessionKeyManager, recipient: string) {
  for (const entry of await listAuthorizations({ evm: keys })) {
    if (entry.status !== "active") continue;
    if (!entry.grants.some((g) => g.recipients?.includes(recipient))) continue;
    const { onChainRevocationRequired } = await revokeListedAuthorization(
      { evm: keys },
      entry,
    );
    // true for Solana delegates and EIP-7702 delegations: the owner must act on chain.
    if (onChainRevocationRequired) console.warn(entry.keyId);
  }
}

# Periodic authorization (spend per period)

This guide shows how to let a delegate spend **at most an amount per period**
("10 USDC per 30 days") with the authorization model in
`@naculus/connect-core` (0.10.0 or later), and how to choose who enforces that
limit: the user's device, or the chain.

Design and rationale: [periodic-authorization.md](../design/periodic-authorization.md),
extending [authorization-model.md](../design/authorization-model.md). The code
below is excerpted from
[examples/periodic-authorization.ts](./examples/periodic-authorization.ts),
which is typechecked with the rest of the repository (`npx tsc --noEmit`).

## 1. Declare `period` on a grant

```ts
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
```

`period` is `{ amount, seconds, start }`:

| Field | Meaning | Rule |
|---|---|---|
| `amount` | Most that may be spent in one period, in base units. | `0 < amount <= maxTotal` |
| `seconds` | Period length. | integer `> 0` |
| `start` | Unix seconds when period 0 begins. | integer `> 0` (see [start time](#3-the-start-time)) |

The semantics are exactly those of MetaMask Delegation Framework v1.3.0's
`ERC20PeriodTransferEnforcer`:

- Periods are **fixed windows**, not rolling: period index =
  `floor((at - start) / seconds)`. Calendar months are not expressible; pick a
  fixed length such as 30 days.
- Spend resets at each boundary. **Unused amount is forfeited**; it does not
  roll over.
- A payment before `start` is refused.
- The period is an **extra** bound. `maxPerPayment`, `maxTotal` and `maxCount`
  still apply; the subscription above stops after 120 USDC even if periods
  remain.
- `period` cannot be combined with the `mpp-session` rail (MPP vouchers are
  cumulative per channel); `validateAuthorization` refuses it.

### Previewing a payment

`evaluateSpend` gives the same verdict as the enforcer, for consent screens and
previews. With a `period`, pass `periodSpentSoFar`, the amount already spent in
the period that `at` falls in; leaving it out refuses
(`period-limit-exceeded`), fail-closed.

```ts
  const checked = validateAuthorization(authorization);
  if (!checked.ok) throw new Error(checked.reason);
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
```

## 2. Device or on-chain enforcement

An authorization is compiled into the scope of an existing enforcer. Every
successful compile reports who enforces it, in `enforcement`:

| Target | `period` enforced by | `enforcement` |
|---|---|---|
| EVM session key, `mode: "offchain"` (default) | `SessionKeyManager`, before signing, with a per-period counter in the key's usage record | `"device"` |
| EVM session key, `mode: "eip7702"` | an `ERC20PeriodTransferEnforcer` caveat on the owner's delegation | `"on-chain"` |
| Solana session key | `SolanaSessionKeyManager`, before signing | `"device"` |
| MPP session | not expressible: refused | — |

**Device enforcement** is a boundary only while the key stays on the user's
device: the SDK refuses to sign beyond the period. It fails closed: a missing
or unreadable period record refuses. Use it when the user is present.

```ts
  const compiled = compileEvmSessionScope(authorization, baseSepolia.id);
  if (!compiled.ok) throw new Error(compiled.reason);
  // compiled.enforcement === "device"
  return keys.createSessionKey(compiled.scope, OWNER);
```

**On-chain enforcement** is what you need when the delegate key lives
somewhere you do not trust as a boundary, typically a merchant's server
charging while the user is away. An SDK check on that server does not protect
against that server being compromised; the chain does. Compile with
`mode: "eip7702"` and `requireOnChain: true`. `requireOnChain` refuses any
target that would only be device-enforced (any `offchain` EVM scope, every
Solana and MPP target), so you cannot get a device-only scope by mistake.

```ts
  const compiled = compileEvmSessionScope(authorization, baseSepolia.id, {
    mode: "eip7702",
    requireOnChain: true,
  });
  if (!compiled.ok) throw new Error(compiled.reason);
  // compiled.enforcement === "on-chain"
  const key = await keys.createSessionKey(compiled.scope, OWNER);
  const delegation = await keys.prepareDelegation(key.id, baseSepolia.id);
  const signature = await signTypedData(delegationTypedData(delegation));
  await keys.attachDelegation(key.id, delegation, signature);
  return key;
```

The owner signs the delegation with `eth_signTypedData_v4`. For it to be
redeemable, the owner's account must be EIP-7702-delegated to
`EIP7702StatelessDeleGator`; see
[eip7702-session-delegation.md](../design/eip7702-session-delegation.md) for
that step and for redeeming.

### What `mode: "eip7702"` accepts

The compiler never silently widens: if a limit has no on-chain caveat, it
refuses (`{ ok: false, reason }`) instead of dropping it. On chain, a grant
compiles only when:

- the chain is supported by the delegation framework (Ethereum, Sepolia, Base,
  Base Sepolia, Arbitrum One, Optimism, Polygon);
- there is exactly one grant on that chain, for an ERC-20 token (no native
  asset), with at most one recipient;
- its rails are `["transfer"]` only;
- the authorization has no `notBefore`;
- the per-payment cap is not tighter than what the other caveats imply (below);
- `period.start > 0`.

### When a per-payment cap is accepted on chain

No caveat caps a single transfer. But the lifetime-total caveat and the period
caveat already bound it: one transfer can never exceed
`min(maxTotal, period.amount)`. So `maxPerPayment` is accepted on chain only
when it is **at least** that bound, because then the chain enforces it by
implication:

| Grant | Bound on one transfer | Compiles on chain? |
|---|---|---|
| `maxPerPayment` 10, `period.amount` 10, `maxTotal` 120 | 10 | yes |
| `maxPerPayment` 5, `period.amount` 10, `maxTotal` 120 | 10 | **no**: a single 10 transfer would pass the chain |
| `maxPerPayment` 120, no period, `maxTotal` 120 | 120 | yes |
| `maxPerPayment` 50, no period, `maxTotal` 120 | 120 | **no** |

For a subscription, set `maxPerPayment` equal to `period.amount`. If you need
a tighter per-payment cap, use device enforcement.

## 3. The start time

Set `start` from the **latest block's timestamp**, not from the device clock:

```ts
export async function periodStart(): Promise<number> {
  const block = await client.getBlock({ blockTag: "latest" });
  return Number(block.timestamp); // always > 0, as the enforcer requires
}
```

Why: the on-chain enforcer compares `block.timestamp`, which trails the
device's clock by a block or more (and device clocks drift). A `start` taken
from `Date.now()` is often a few seconds in the chain's future, and the first
charge is refused by the enforcer as `transfer-not-started`. This was observed
on Sepolia. A `start` at or before the latest block is safe; an earlier
`start` only shifts where the period boundaries fall.

`start` must also be **greater than zero**: the enforcer refuses
`start == 0`, so `validateAuthorization` refuses it too (`invalid grant
period`), for device-enforced grants as well, so the two never disagree.

Take `start` from the chain for device-enforced grants too, so device and
chain count the same periods. Device checks use the
device's clock for `at`, so near a period boundary a payment can be allowed on the
device and refused on chain. When they disagree, the chain wins: the payment
fails, and it is not retried in a way that skips the check.

## Checklist

- [ ] `period.amount <= maxTotal`; `seconds` and `start` are positive
      integers.
- [ ] `start` comes from the latest block's timestamp, not `Date.now()`.
- [ ] User away (server-held delegate key): `mode: "eip7702"`,
      `requireOnChain: true`, and `compiled.enforcement === "on-chain"`.
- [ ] On chain: one ERC-20 grant, one recipient, rails `["transfer"]`, no
      `notBefore`, `maxPerPayment >= min(maxTotal, period.amount)`.
- [ ] Show the user who enforces the limit: `"device"` or `"on-chain"`.

# Periodic authorization (per-period limits)

Status: **approved 2026-10-04** — decisions 1–4 below accepted as recommended. Extends
[authorization-model.md](./authorization-model.md); its rules (fail-closed,
compilers never widen, signing only in the existing managers) are binding.

## Problem

`Grant` limits one payment (`maxPerPayment`), the lifetime total (`maxTotal`)
and the count (`maxCount`). A subscription needs "at most 10 USDC **per 30
days**", resetting each period, for months. With today's fields an app must
either grant a large lifetime total (a compromised delegate can drain it in one
period) or re-ask the user every period (no subscription UX).

The second gap is **who enforces**. A device-held session key is enforced by
our SDK on that device. For a charge made while the user is away, the delegate
key sits on the merchant's or SenderPay's server; an SDK check running on that
server is not a boundary against that server being compromised. Absent-user
charges need an on-chain limit.

## Approach

1. Add an optional `period` to `Grant`, with exactly the semantics of MetaMask
   Delegation Framework v1.3.0's `ERC20PeriodTransferEnforcer` /
   `NativeTokenPeriodTransferEnforcer` (deployed at deterministic addresses,
   source checked 2026-10-04):

   ```ts
   interface GrantPeriod {
     amount: bigint;   // max base units per period, 0 < amount <= maxTotal
     seconds: number;  // period length, integer > 0
     start: number;    // unix seconds when period 0 begins
   }
   ```

   Period index = `floor((at - start) / seconds)`; spend resets at each
   boundary; unused amount is forfeited (does not roll over); `at < start` →
   refused. Fixed windows, not rolling: rolling needs the full spend history,
   fixed windows need one counter, and they match the on-chain enforcer
   byte for byte. Calendar months are not expressible here — "monthly" in
   SenderPay maps to a fixed length (e.g. 30 days) chosen there.

2. `evaluateSpend` gains `periodSpentSoFar` in `SpendRequest` and a refusal
   `period-limit-exceeded`. `maxPerPayment`, `maxTotal` and `maxCount` still
   apply; the period is an additional bound, never a replacement.

3. Compilation:

   | Enforcer | `period` |
   |---|---|
   | EVM `eip7702` delegation | `ERC20PeriodTransferEnforcer` (terms: token, amount, seconds, start) or `NativeTokenPeriodTransferEnforcer` caveat — **on-chain** |
   | EVM `offchain` session key | local per-period counter in the usage record — **device** |
   | Solana session key | local per-period counter — **device**; scope hash gets a new version, legacy scopes unchanged |
   | MPP voucher / session | **not expressible** (vouchers are cumulative per channel) → refused |

4. Every compiled scope reports `enforcement: "on-chain" | "device"`.
   `describeAuthorization` exposes it so consent can say "limit enforced by the
   blockchain" vs "by this device". A compiler asked for `requireOnChain: true`
   refuses any target that would only be device-enforced.

## Storage and signing (boundary)

- Usage records gain optional `periodIndex` and `periodSpent` per asset.
  Records without them behave exactly as today. No migration; no change to
  how existing scopes are enforced.
- Signing stays in `SessionKeyManager` / `SolanaSessionKeyManager`. The new
  check runs before signing, next to the existing cumulative check, under the
  same lock, and is fail-closed: an unreadable period record refuses.
- The eip7702 path only adds a caveat; the delegation's other caveats are
  unchanged. A delegation whose period caveat cannot be built is not built.
- Clock: the device check uses the same `at` the enforcer already uses for
  expiry. On-chain uses `block.timestamp`; a request near a period boundary
  can be allowed locally and refused on chain — the on-chain verdict wins and
  is surfaced as a failed payment, never retried in a way that skips the check.

## Start time (found on Sepolia, 2026-10-04)

The on-chain enforcer compares `block.timestamp`, which lags the device clock
by a block or more. A period whose `start` is "now" by the device clock can be
refused as `transfer-not-started` on the first charge. Set `start` from the
latest block's timestamp (or earlier), never from `Date.now()` alone; the
enforcer also requires `start > 0`.

## Tests

- Differential: generated requests across period boundaries — evaluator verdict
  equals each compiled enforcer's verdict (same harness as phase 1).
- EVM eip7702: encoded terms byte-equal to the enforcer's 116-byte layout;
  one fork test redeeming two periods against the deployed enforcer.
- Legacy records and scopes without `period`: unchanged outcomes.

## Decisions to approve

1. **Fixed windows matching the on-chain enforcer** (not rolling, not calendar
   months). Recommended.
2. **`enforcement` label + `requireOnChain`**: absent-user subscriptions in
   SenderPay must use `requireOnChain: true` (eip7702 delegation). Recommended.
3. **Solana: device-enforced only** for now (no on-chain period program).
   An absent-user Solana subscription is therefore refused under
   `requireOnChain`. Recommended; revisit if Solana demand appears.
4. Phase order: (a) model + evaluator + device enforcers, (b) eip7702 caveat +
   fork test, (c) appkit consent/listing shows period and enforcement.

## Out of scope

Billing schedules, invoices, retries, dunning, calendar logic, fiat amounts —
SenderPay. Swap/bridge `minOut` bounds — Authorization v1 is value transfers
only (decision 1 of authorization-model.md); a separate design.

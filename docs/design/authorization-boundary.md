# Authorization boundary: what Naculus decides, and what it does not

Status: **decided 2026-10-01** (product direction from the maintainer).
Scope: connect-lib and connect-appkit. This document sets the boundary that
later design work (the unified authorization model, receipt verification,
consent UX) must stay inside.

## Position

Naculus is a **programmable authorization and execution layer**: it lets
software move a limited amount of value on someone's behalf, checks that
what gets signed is what was authorized, executes it, and proves what
happened. It is not a wallet-connection kit with payments bolted on, and it
is not a payment product.

| Layer | Owns |
|---|---|
| `connect-lib` | identity, wallet capability, authorization policy, delegated keys, signing, simulation, execution, receipt primitives |
| `connect-appkit` | the UX of that authority: connect, consent, policy editing, payment preview, execution state, receipts, revocation |
| Payment products built on it (e.g. SenderPay) | payment intents, routing, quotes and FX, merchants, fiat / bank / card rails, on- and off-ramp, compliance, ledger, reconciliation, refunds |

Naculus decides **whether** a payment may happen. The product above it
decides **how** it should be paid.

## The questions Naculus answers

| Question | Meaning in Naculus | Where it is enforced today |
|---|---|---|
| Who | the principal (wallet owner) and the delegate (a session or voucher key) | owner authorization on session keys; `authorizedSigner` on MPP channels |
| What | an asset on a chain: a token contract or mint, under a CAIP-2 chain ID | `tokenAllowances`, `allowedChainIds` (EVM); `mint` + `cluster` (Solana) |
| To whom | recipient **addresses** | `allowedRecipients` (EVM, Solana); `payee` (MPP channel) |
| How much | amounts in the asset's **base units**: per payment, cumulative, deposit | `maxValuePerTx` / `maxTotalValue` / `tokenAllowances`; `maxPerPayment` / `budget`; `maxDelta` / `maxCumulative` |
| Until when | an expiry the key cannot outlive | `expiry` on every policy; voucher `expiresAt` |
| How | the execution path the key may use | session mode (`offchain` / `eip7702` / `aa_module`), x402 / MPP charge / MPP session |
| Verify | the bytes signed match what was authorized | typed-data and transaction checks before signing; `verifySignedChannelOpen`; trusted-program pins |
| Execute | broadcast only through an app-supplied path | `sendTransaction` hooks; no hidden broadcast |
| Prove | what actually happened on chain | **gap** — receipts are server-reported and unverified (see *Gaps*) |

The four enforcement points that exist today:

- `SessionKeyScope` (EVM session keys; also x402 EVM `exact`)
- `SolanaSessionKeyScope` (Solana session keys; MPP `charge`, x402 SVM)
- `ChannelVoucherPolicy` (MPP session voucher keys)
- `MppSessionPolicy` (MPP session client limits)

They express the same questions with different field names. Unifying them
is the next design step, not part of this document.

## Invariants

1. **Limits are in base units of a concrete asset on a concrete chain.**
   Never a fiat amount. A fiat limit needs a price, a price comes from a
   quote, and a quote can be wrong or hostile; the key would then sign
   whatever the quote says. Converting "at most 50 USD" into "at most
   50 000 000 base units of USDC on `eip155:8453`" is the product's job,
   done before the authorization is created, and the authorization holds
   only the result.
2. **Recipients are addresses.** A merchant name or ID is resolved to
   addresses by the product's directory before authorization; the signing
   check compares addresses.
3. **Chain IDs are CAIP-2**, and assets are identified per chain by contract
   address or mint; account and chain selection must remain explicit.
4. **Fail closed.** Unknown fields, unknown chains, unknown programs and
   unverifiable signatures are refusals, not warnings.
5. **No hidden broadcast.** Naculus signs; the app decides where a signed
   transaction goes, except where a protocol requires the server to submit
   it (x402 / MPP credentials).
6. **Server claims are data until verified.** A settlement hash, receipt or
   price from a server is shown as unverified until Naculus has checked it
   on chain.

## Non-goals

These stay out of connect-lib and connect-appkit even when a product needs
them:

- KYC / KYB, AML and sanctions decisions
- FX quotes, price feeds, fee estimation in fiat
- on-ramp and off-ramp
- merchant onboarding, acquiring, merchant ledgers
- invoices, purchase orders, refunds, disputes, tax and accounting
- fiat, bank-transfer and card rails
- liquidity (e.g. TWD ↔ USDC)
- a protocol-neutral **payment intent** that includes fiat or rail choice

Naculus may define **interfaces** a product implements and passes in — for
example a policy evaluator, quote provider, compliance check or settlement
provider — so its flows can call out at the right moment. It does not ship
implementations of them, and an absent provider must not loosen any
invariant above.

## Gaps this boundary implies

1. **One authorization model** across the four enforcement points, with the
   same questions and the invariants above; each existing enforcer becomes
   an adapter. Design first, reviewed before code (signing path).
2. **Receipt verification**: check on chain that a reported settlement paid
   the expected recipient, asset and amount (EVM transfer logs, Solana token
   balance deltas), so "prove" stops relying on the server.
3. **Consent and revocation UX** in appkit on top of (1): authorize, preview,
   list and revoke delegated authority.

## Out of scope for this document

The shape of the unified model, its storage, migration of existing keys,
and any API. Those are the subject of the next design document.

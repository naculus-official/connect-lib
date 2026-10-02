# Unified authorization model

Status: **approved 2026-10-02** — decisions 1–3 below accepted as recommended. Implements
gap 1 of [authorization-boundary.md](./authorization-boundary.md); read that
first — its invariants are binding here.

## Problem

Four enforcement points answer the same questions (who, what asset, to whom,
how much, until when, by which path) with four field vocabularies:

| | EVM session key | Solana session key | MPP voucher key | MPP session client |
|---|---|---|---|---|
| Type | `SessionKeyScope` | `SolanaSessionKeyScope` | `ChannelVoucherPolicy` | `MppSessionPolicy` |
| Chain | `allowedChainIds: number[]` | `cluster` (CAIP-2) | `cluster` | from the challenge |
| Asset | `tokenAllowances` keys; native via `maxValuePerTx` | `mint` | `mint` | from the challenge |
| Recipient | `allowedRecipients` (optional) | `allowedRecipients` (required) | `payee` | `recipient` |
| Per payment | `maxValuePerTx` / allowance | `maxPerPayment` | `maxDelta` | `maxDelta` |
| Cumulative | `maxTotalValue` / `tokenAllowances` | `budget` | `maxCumulative` | `maxCumulative`, `deposit` |
| Expiry | `expiry` | `expiry` | `expiry` | `expiresAt` |
| Used by | x402 EVM `exact`, EVM calls | MPP `charge`, x402 SVM | MPP session | MPP session |

An app that wants "this agent may pay OpenAI up to 20 USDC per call, 100 in
total, until 31 October" has to know which manager to create, translate the
limits into that manager's fields, and build a different consent screen for
each. A UI that lists "everything this wallet has delegated" has to read four
stores. Nothing checks that two policies created for the same intent agree.

## Approach: declare once, compile to the existing enforcers

The enforcers stay. They are on the signing path, reviewed, and two of them
were verified against the deployed program; rewriting them buys risk, not
safety. Instead:

1. **`Authorization`** — one declarative, serializable description of what a
   delegate may spend.
2. **`evaluateSpend(authorization, request)`** — a pure function giving the
   same allow/deny answer the enforcers give, for previews and consent UI.
3. **Compilers** — `Authorization` → `SessionKeyScope` /
   `SolanaSessionKeyScope` / `ChannelVoucherPolicy` + `MppSessionPolicy`.
   The compiled scope is what the existing manager enforces at signing time.
4. **Differential tests** — for generated spend requests, the evaluator's
   verdict must equal the compiled enforcer's verdict. A disagreement is a
   bug in one of them, found before release.

Signing still happens only in the existing managers. The new layer never
holds key material and never signs.

## The model

```ts
/** CAIP-19 asset: "eip155:8453/erc20:0x8335…" or "solana:5eykt…/token:EPjF…". */
type AssetId = string;

interface Authorization {
  version: 1;
  /** The owner granting authority (CAIP-10 account). */
  principal: string;
  /** Human label shown in consent and listing UIs; never used for checks. */
  label?: string;
  grants: Grant[];        // non-empty
  notBefore?: number;     // unix seconds
  expiresAt: number;      // unix seconds, required
}

interface Grant {
  asset: AssetId;                       // chain is the asset's CAIP-2 prefix
  recipients: string[];                 // addresses on that chain, non-empty
  maxPerPayment: bigint;                // base units
  maxTotal: bigint;                     // base units, >= maxPerPayment
  maxCount?: number;
  rails: Rail[];                        // non-empty
}

type Rail = "transfer" | "x402-exact" | "mpp-charge" | "mpp-session";

interface SpendRequest {
  asset: AssetId;
  recipient: string;
  amount: bigint;
  rail: Rail;
  at: number;                           // unix seconds
  spentSoFar: bigint;                   // from the enforcer's usage record
  countSoFar: number;
}

type SpendVerdict =
  | { allow: true; grant: number }
  | { allow: false; reason: SpendRefusal };
```

Rules, all fail-closed:

- No fiat, no price, no merchant ID anywhere (boundary invariants 1 and 2).
- `recipients` is required and non-empty; "any recipient" is not expressible.
  The EVM scope's optional `allowedRecipients` is compiled as required.
- Unknown `version`, rail, CAIP-2 namespace or asset namespace → invalid.
- Addresses are compared in the chain's canonical form (EIP-55 / base58).
- A request matches at most one grant: overlapping grants for the same asset,
  recipient and rail are rejected when the authorization is validated, so a
  verdict never depends on grant order.

## Compilation

| Authorization | EVM `SessionKeyScope` | Solana `SolanaSessionKeyScope` | MPP voucher + client |
|---|---|---|---|
| grants on one chain | `allowedChainIds: [id]` | `cluster` | `cluster` |
| `asset` | ERC-20 → `tokenAllowances[token] = maxTotal`; native → `maxTotalValue` | `mint` | `mint` |
| `recipients` | `allowedRecipients` | `allowedRecipients` | single `payee` (more than one → not compilable) |
| `maxPerPayment` | `maxValuePerTx` (native); per-token per-tx is **not expressible today** | `maxPerPayment` | `maxDelta` |
| `maxTotal` | as above | `budget` | `maxCumulative`; `deposit` chosen by the app ≥ `maxTotal` |
| `maxCount` | `maxTxCount` | `maxTxCount` | not expressible |
| `expiresAt` | `expiry` | `expiry` | `expiry` / `expiresAt` |
| rails | x402-exact / transfer → mode `offchain` | mpp-charge / x402 SVM | mpp-session |

A compiler returns `{ ok: true, scope }` or `{ ok: false, reason }`; it never
silently widens. Two cells above are not expressible by the current
enforcers. The compiler refuses them, and the doc records them as follow-ups:

- **EVM per-token per-payment limit** (`tokenAllowances` caps the total
  only). Follow-up: add `tokenMaxPerTx` to `SessionKeyScope`, enforced in
  `checkSessionScope` — a signing-path change, reviewed on its own.
- **`maxCount` for MPP sessions** — vouchers are cumulative; a count limit
  has no meaning there and is refused rather than ignored.

One `Authorization` with grants on several chains compiles to several keys
(one per enforcer and chain). Creating them is the app's call, made through
the existing managers; this layer only produces the scopes.

## Listing and revocation

A read-only `listAuthorizations()` aggregates the three managers' records
into `{ authorization, enforcer, keyId, status, spent }` so one screen can
show and revoke everything a principal delegated. Revocation calls the
owning manager's existing revoke. The aggregate stores nothing of its own.

## Where it lives

- `@naculus/connect-core`: types, `validateAuthorization`, `evaluateSpend`,
  compilers, `listAuthorizations`. Pure except the listing, which reads the
  managers it is given.
- `@naculus/connect-appkit-core`: consent text, preview formatting and
  listing view models built on the above; React/Vue stay thin shells.
- Nothing in payments-x402 / payments-mpp changes in phase 1.

## Phases

1. **Model + evaluator + compilers + differential tests** (core). No storage,
   no signing change. Review: 1–2 rounds (it decides what keys may do).
2. **`tokenMaxPerTx`** on `SessionKeyScope` so EVM grants compile fully.
   Signing path; review 2 rounds.
3. **`listAuthorizations`** across managers.
4. **appkit consent / preview / revoke** components on top.

## Decisions (approved 2026-10-02)

1. Scope of v1: **value transfers only** (the four rails above). Arbitrary
   EVM contract-call permissions (`allowedContracts` / `allowedMethods`)
   stay EVM-specific and are not part of `Authorization` v1. **Accepted.**
2. `recipients` required everywhere, including EVM where it is optional
   today. Existing EVM keys without recipients are listed as
   "unrestricted recipient (legacy)" and cannot be produced by the compiler.
   **Accepted.**
3. Phase order as above (evaluator before the EVM per-token limit).
   **Accepted.**

## Out of scope

Payment intents, routing, quotes and any fiat amount (boundary non-goals);
migrating existing keys into a new store; server-side authorization.

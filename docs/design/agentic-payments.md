# Agentic payments (x402 / MPP) on the session-key policy engine

Status: design, step 1 of STATE.md thread 14. No code change.
Date: 2026-09-21.

Protocol details below are from memory of the public specs as of mid-2026
and are marked **verify** where the exact wire shape matters. Step 2 starts
by pinning them against the current x402 and MPP repositories.

## Why

An agent hitting an HTTP resource gets a 402 with a machine-readable price
and pays without a human in the loop. Naculus already has the hard part —
a session key whose signing is bounded by a signed, owner-authorized policy
(`SessionKeyScope`: `allowedContracts`, `allowedMethods`, `tokenAllowances`,
`maxValuePerTx`, `maxTotalValue`, `maxTxCount`, `expiry`,
`allowedChainIds`) and enforced fail-closed at signing time
(`signWithVerifiedOffchainAuthorization`, 0.2.5). What is missing is the
adapter that turns a 402 challenge into a policy-checked payment and a
retried request. Nothing in the repo speaks either protocol today.

## The two protocols, as they matter here

| | x402 (Coinbase) | MPP (Machine Payments Protocol) |
|---|---|---|
| Challenge | HTTP 402 + `PAYMENT-REQUIRED` header, base64 JSON: `scheme` (`"exact"`), `network` (CAIP-2-ish, **verify** exact form), `maxAmountRequired` (base units), `asset` (token contract), `payTo`, `resource`, `maxTimeoutSeconds`, `extra`. **verify**: header name casing and whether a JSON body variant exists | HTTP 402 + `WWW-Authenticate: Payment …` challenge listing one or more methods (`tempo`, card, …) with `intent` (`charge` / `session`), amount, currency, `payTo`-equivalent, expiry. **verify**: field names, and how a method advertises its chain |
| Payment | `X-PAYMENT` header: signed payload. For EVM stable-coins the `exact` scheme is an **EIP-3009 `transferWithAuthorization`** signature (EIP-712 typed data: from, to, value, validAfter, validBefore, nonce) — the payer signs an authorization; a **facilitator** verifies and settles on-chain and returns `X-PAYMENT-RESPONSE`. **verify**: Solana scheme details | `Authorization: Payment <credential>`; the credential is method-specific. For an on-chain method the client submits (or authorizes) a transfer and presents proof. **verify**: whether the client broadcasts or only signs |
| What the payer signs | EIP-712 typed data, not a transaction | Method-specific; for chain methods likely a transaction or typed data |
| Who broadcasts | Facilitator (x402) | Client or method operator (MPP) |
| Chain | EVM first (USDC on Base), Solana added | Tempo L1 first, others via methods |

The consequence for Naculus: **x402's EVM path never asks the session key to
sign a transaction — it signs EIP-712 typed data** (`transferWithAuthorization`).
The current policy engine reasons about transactions (`to`, `data`, `value`,
`chainId`). That is the gap, and it is a policy-engine gap, not an HTTP one.

## What the policy engine already covers

| Payment fact | Policy field that bounds it | Enforced today? |
|---|---|---|
| Token contract (`asset`) | `allowedContracts` + `tokenAllowances` key | yes, for `transfer`/`transferFrom` calldata |
| Amount (`maxAmountRequired`) | `tokenAllowances[asset]` cumulative, `maxValuePerTx` for native | yes, for calldata; **no** for typed data |
| Recipient (`payTo`) | not modelled — `allowedContracts` is the *token*, not the payee | **no** |
| Chain (`network`) | `allowedChainIds` | yes, when the tx carries `chainId` |
| Lifetime (`maxTimeoutSeconds`, `validBefore`) | `expiry` (session), nothing per-payment | partial |
| Origin (`resource` host) | `buildDelegationPolicyMessage` binds `origin` into the signed policy | the *policy* is origin-bound; individual payments are not checked against a resource allowlist |
| Count | `maxTxCount` | yes |

## The delta

1. **Typed-data awareness in the scope check** (`connect-core`,
   `session-keys/SessionKeyManager.ts`). A new
   `SessionKeyTypedDataRequest` (`chainId`, `verifyingContract`,
   `primaryType`, decoded `message`) alongside `SessionKeyTransaction`, and
   a `checkTypedDataAgainstScope` that recognizes **exactly one** primary
   type at first — `TransferWithAuthorization` (EIP-3009) — mapping
   `verifyingContract` → token, `value` → amount, `to` → payee,
   `validBefore` → per-payment lifetime, and refusing any other primary type
   (fail-closed: unknown typed data is not "unscoped", it is denied).
   `signWithVerifiedOffchainAuthorization` accepts either request form and
   accounts the token spend the same way calldata does.
2. **Payee allowlist** on the scope: `allowedRecipients?: 0x[]` (EVM) —
   the field the current model lacks. Absent means any payee, consistent with
   `allowedContracts`; `requireAllowedContracts`-style default-on is a
   product decision, recorded here as *recommended on for agent policies*.
3. **A `payments-x402` package** (new, `connect-lib/packages/`): parses the
   challenge (fail-closed on anything unparseable or on a scheme other than
   `exact`), maps `network` → CAIP-2, builds the EIP-3009 typed data,
   asks the session-key manager to sign it under the policy, builds
   `X-PAYMENT`, retries the request once, verifies `X-PAYMENT-RESPONSE`
   shape. No facilitator trust beyond what the protocol requires; no
   broadcasting. MPP is a second adapter behind the same
   `PaymentChallenge → PaymentAuthorization` interface once its chain
   method's signing shape is pinned.
4. **Not in scope**: card / fiat methods, running a facilitator, a
   spending-limit UI (appkit hooks come after the core API is stable).

## Boundary for step 2

- Files: `core/src/session-keys/{types,SessionKeyManager}.ts` (+tests) for
  1–2; new package for 3 with its own tests and a tester gate expectation
  only if it is intentionally not installable there.
- No new dependency in core. The x402 package may depend on
  `@noble/hashes` (already present) for EIP-712 hashing; **not** on viem.
- Invariants: no key material outside `SessionKeyManager`; typed data with
  an unrecognized `primaryType` is refused; `validBefore` beyond session
  `expiry` is refused; amount is charged against `tokenAllowances` before
  the signature is returned (same withhold-on-persist-failure rule as
  calldata); chain must be in `allowedChainIds` when set; payee must be in
  `allowedRecipients` when set.
- Review: session-keys is always-review; steps 1–2 are signing-path changes
  and get a Claude pass each; step 3 a further pass on the challenge parser.

## Order

1 and 2 are prerequisites and are useful on their own (any dApp using
EIP-3009 gasless transfers benefits). 3 follows. Estimated: ~250 lines core +
tests, ~300 lines package + tests. Two Codex work packages, two review
rounds. Suggested for a 0.3.0 alongside thread 1 (EIP-7702 execution),
since both change what a session key may sign.

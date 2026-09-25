# Agentic payments (x402 / MPP) on the session-key policy engine

Status: steps 1–2 done (2026-09-22), hardened after independent review in
0.2.8; step 3 done (2026-09-24): `@naculus/payments-x402`, client side of
x402 v2 over HTTP, EVM `exact` scheme with EIP-3009 only.

**Wire shapes pinned 2026-09-24** against coinbase/x402 `specs/`
(`x402-specification-v2.md`, `transports-v2/http.md`,
`schemes/exact/scheme_exact_evm.md`); these supersede the *verify* notes
below. Headers are `PAYMENT-REQUIRED` (402 challenge), `PAYMENT-SIGNATURE`
(client payload) and `PAYMENT-RESPONSE` (settlement), each base64-encoded
JSON with `x402Version: 2` — the `X-PAYMENT` names are v1. `accepts[]`
entries carry `scheme`, `network` (plain CAIP-2), `amount`, `asset`, `payTo`,
`maxTimeoutSeconds` and `extra` (`name`/`version` of the token's EIP-712
domain, optional `assetTransferMethod`). EVM `exact` prefers EIP-3009 and
falls back to Permit2; the package refuses Permit2 (a session key signs only
`TransferWithAuthorization`). SVM `exact` is a partially signed
`TransferChecked` transaction — out of scope until the Solana Kit work
(thread 15).
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

## Step 4: the MPP adapter (pinned 2026-09-26)

Pinned against `tempoxyz/mpp-specs` @ `08e7dd8` (`draft-httpauth-payment-01`,
`draft-payment-intent-charge-00`, `draft-evm-charge-00`) and the reference
client `wevm/mppx` `src/evm/client/Charge.ts` / `src/evm/Types.ts`.

**Wire format.** A 402 carries one or more `WWW-Authenticate: Payment`
challenges (RFC 9110 auth-params): required `id`, `realm`, `method`
(lowercase), `intent`, `request` (base64url-nopad JCS JSON); optional
`expires` (RFC 3339), `digest` (RFC 9530 body digest), `description`,
`header` (only `Payment-Authorization` is legal), `opaque` (base64url JCS
flat string map). The credential is `Payment <base64url-nopad JSON>` with
`{ challenge: <echo of every received param, unchanged>, payload, source? }`,
sent in `Authorization`, or in `Payment-Authorization` when the challenge
says so. Success returns `Payment-Receipt` (base64url JSON: `status:
"success"`, `method`, `timestamp`, `reference`, EVM adds `challengeId`,
`chainId`); failure is 402 + a fresh challenge + RFC 9457 problem JSON.

**The one method that fits the session-key engine: `method="evm"`,
`intent="charge"`, credential `type="authorization"`.** It is EIP-3009
`TransferWithAuthorization`, exactly what `signTypedDataWithSessionKey`
already bounds (token, payee, amount, chain, lifetime, usage). Request:
`amount` (base units), `currency` (token), `recipient`,
`methodDetails.chainId`, `methodDetails.credentialTypes`. Payload `{ type:
"authorization", from, to, value, validAfter: "0", validBefore, nonce,
signature }` where:

- `nonce = keccak256(utf8(challenge.id + challenge.realm))` — the server,
  not the client, fixes the nonce; the token contract consumes it, so a
  replayed challenge cannot be paid twice.
- `validBefore` = `expires` in unix seconds, or now + 300 s when absent (as
  mppx); core already refuses a `validBefore` beyond the session's expiry.
- Used only when `credentialTypes` lists `"authorization"` and there are no
  `splits` (the spec forbids splits with this type).

Refused, fail-closed: `type="permit2"` (the engine cannot bound a Permit2
witness transfer — same reason x402 refuses it), `type="transaction"` and
`type="hash"` (the key would sign or broadcast a transfer transaction; a
later step if a consumer needs it), every non-`evm` method, every intent
but `charge`, `splits`, an expired challenge, a `header` other than
`Payment-Authorization`, a malformed or duplicated auth-param.

**The gap the spec leaves: the token's EIP-712 domain.** x402 sends
`extra.name/version`; MPP sends nothing, and mppx resolves it from a
known-assets table or a caller setting. A wrong domain only yields a
signature the token rejects (the domain binds `verifyingContract` and
`chainId`), so it is a liveness risk, not a funds risk.

**Boundary.** Only the new adapter's files and tests; no change to core or
to the signing path (it calls `signTypedDataWithSessionKey` as x402 does);
no new dependency beyond `@noble/hashes` for keccak (already in the
workspace); no broadcasting, no retries beyond one, redirects refused on
the paid retry (`redirect: "error"`), the credential never sent to another
origin than the challenge's. Review: the challenge parser and the
credential echo get an independent pass.

**Decisions needed before implementing:**

1. Home: a new `@naculus/payments-mpp` package (needs the user's npm
   bootstrap, as for x402), or inside `@naculus/payments-x402`.
2. Domain source: caller-supplied only; or a built-in USDC table for the
   seven thread-17 chains, each value read from the chain and pinned by a
   test, with a caller override.
3. Credential types: `authorization` only for now (recommended).

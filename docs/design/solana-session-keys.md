# Solana session keys (STATE thread 18)

Status: **approved 2026-09-27** — decisions (a) SPL delegate, sponsored fees only,
one mint per key, separate `SolanaSessionKeyManager`. Packages 1–2 implemented.

## Goal

Pay x402 `exact` on SVM and MPP `solana` charges without a wallet prompt per
payment, bounded by an owner-approved policy — the Solana counterpart of the
EVM session keys that pay EIP-3009 authorizations today. Thread 14 shipped
the wallet-signed path and the byte-level transaction builder / verifier in
`connect-core/src/solana-payment.ts`; this reuses them.

## Where the spending power comes from

A Solana keypair cannot move another account's tokens unless the chain says
so. Two ways, both one wallet prompt at setup:

| | (a) SPL delegate (recommended) | (b) Funded session key |
|---|---|---|
| Setup | Owner signs `ApproveChecked` on its token account: delegate = session key, `delegated_amount` = budget | Owner transfers the budget to the session key's own token account (+ ~0.002 SOL rent to create it) |
| Where funds sit | Owner's account until spent | Session key's account (a hot key in browser storage) |
| Total cap | **Chain-enforced**: `delegated_amount` decrements per transfer | Chain-enforced by balance |
| Revoke | Owner signs `Revoke` (any time, from any device) | Session key must sign a sweep back; lost key = lost funds |
| Transfer shape | `TransferChecked` source = owner's ATA, authority = session key | source = session key's ATA, authority = session key |
| Compatibility | x402 reference facilitator (Go, `mechanisms/svm/exact/facilitator`) checks mint, destination ATA, amount and that the authority is not its own signer — not that source belongs to the authority; it simulates on chain. MPP checks destination, amount, client signature. **Compatible** | Compatible with everything (it is the wallet-signed shape) |
| Limitation | One delegate per token account: approving replaces any existing delegate on that account (another dapp's) — shown to the user before the prompt | Funds out of the owner's control until swept |

**Recommendation: (a).** Funds stay with the owner, the chain enforces the
total, and revocation does not depend on the session key. The one-delegate
limit is disclosed at setup.

## Policy (enforced before the session key signs)

- One mint per key (as thread 17 is single-token), on one cluster (CAIP-2).
- `allowedRecipients` (owners of destination ATAs); required, non-empty.
- `maxPerPayment`; the total is the chain's `delegated_amount`, also tracked
  locally so an over-budget payment is refused before signing.
- `expiry` (the chain does not expire a delegate; after expiry the key
  refuses, and the UI offers `Revoke`), `maxTxCount`.
- Fees: **sponsored only** — the fee payer must be the facilitator / server
  (x402 `extra.feePayer`, MPP `feePayer: true`). The session key holds no SOL
  and never pays fees; a self-funded MPP charge is refused.

## Signing rule

The session key never signs bytes it is handed. The manager takes the
payment facts, checks them against the policy, builds the message itself
with `buildSplTransferTransaction` (extended with `sourceOwner`: source =
ATA(owner), authority = session key), signs that message, and accounts the
spend before returning — the same "digest from what was checked" rule as the
EVM typed-data path. Nothing else is signable with a Solana session key:
no raw messages, no other instructions, no Lighthouse (nothing to inject —
no wallet is involved).

Cluster binding as in thread 14: the RPC's genesis must match the key's
cluster, and the blockhash comes from that RPC, never from the server.

## Storage and code placement

- New `SolanaSessionKeyManager` in `connect-core/src/session-keys/` (ed25519
  via `@noble/curves`, already a dependency), reusing the existing encrypted
  storage (`storage.ts`, PBKDF2 / AES-GCM) with its own record type. The EVM
  `SessionKeyManager` is not modified — its policy engine is EVM-shaped and
  heavily reviewed.
- core: `buildApproveDelegateTransaction` / `buildRevokeDelegateTransaction`
  (owner-signed, wallet prompt), verified after signing like the payment.
- payments-x402 / payments-mpp: `solana: { sessionKey }` as an alternative to
  `solana: { signer }`.
- appkit: `useSolanaSessionKey` (create → approve → pay → revoke state) in
  React and Vue, logic in appkit-core.

## Work packages

1. core: key manager, policy, approve/revoke builders, `sourceOwner` in the
   payment builder; vectors vs @solana/kit + @solana-program/token
   (`getApproveCheckedInstruction`, delegate transfer). Review.
2. payments-x402 / payments-mpp wiring + tests. Review.
3. appkit hooks. Review (1 round).
4. Optional: a devnet end-to-end run (approve, pay a local x402 facilitator,
   revoke) — needs a funded devnet account.

## Decisions (user, 2026-09-27)

1. Spending power: **(a) SPL delegate**.
2. Fees: sponsored only.
3. Scope: one mint per key.
4. Placement: separate `SolanaSessionKeyManager`; the EVM manager's store
   only had its lock extracted (`withAdapterLock`), behavior unchanged.

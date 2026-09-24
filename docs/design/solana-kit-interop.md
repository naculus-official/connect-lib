# Solana Kit-native interop

Status: step 2 implemented 2026-09-24 as `@naculus/connector-solana-kit`,
against Kit **8** (peer `^8.0.0`; 8 adds
`getTransactionLifetimeConstraintFromCompiledTransactionMessage`, which the
modifying bridge needs to re-derive a rewritten transaction's lifetime).
Messages map to `MessagePartialSigner`, not the modifying variant: Naculus's
`signMessage` signs the given bytes and returns only a signature. Every
returned signature is verified against the identity address. The reverse
adapter (item 3) is not started.
Date: 2026-09-21.

## Why

`connector-solana` speaks Wallet Standard and, since 0.2.4, splits a
connected wallet into `identity` / `signer` / `payer` roles
(`roles.ts`). Solana's current recommended stack is `@solana/kit` plus
`@solana/kit-plugin-wallet`, whose signer interfaces make the same split.
The daily benchmark scores Naculus 8/10 here; the remaining gap is that a
Kit-based app cannot hand a Naculus role to Kit's transaction builders
without writing glue. The connector itself depends on `@solana/web3.js` (v1
API) and `tweetnacl`, not Kit.

## What exists, mapped onto Kit

| Naculus (`roles.ts`) | Kit signer interface | Fit |
|---|---|---|
| `SolanaIdentity { address, chain }` | `Address` (branded string) + a signer's `address` field | direct: `address as Address` |
| `SolanaSigner.signTransaction(Uint8Array) → Uint8Array` | `TransactionModifyingSigner` (wallet may alter the tx) or `TransactionPartialSigner` (adds signatures only) | needs a bridge: Kit passes `Transaction` objects (compiled message + signature map), Naculus passes wire bytes. Wallet Standard `solana:signTransaction` returns full bytes, so **`TransactionModifyingSigner`** is the honest mapping — a wallet may rewrite the message |
| `SolanaSigner.signAllTransactions` | same interfaces take arrays natively | direct once the single-tx bridge exists |
| `SolanaSigner.signMessage(Uint8Array)` | `MessageModifyingSigner` / `MessagePartialSigner` | bridge: Kit's `SignableMessage` wraps bytes + signature map |
| `SolanaPayer.signAndSendTransaction → signature` | `TransactionSendingSigner` | direct: Kit's sending signer returns `SignatureBytes`; Naculus returns base58 — decode |
| `SolanaWalletFeatures` (4 booleans) | which of the above interfaces the wallet implements | `solanaRoles()` already computes this from Wallet Standard features |
| `requireRole("payer")` throwing when absent | Kit has no equivalent — a missing capability is a type error at build time | keep Naculus's runtime refusal; the adapter only exposes interfaces the wallet actually has |

Conclusion: the role model is already Kit-shaped; the work is an
**adapter that converts byte-level Naculus roles into Kit signer objects**,
plus the reverse for apps that own a Kit signer and want to drive Naculus.

## The delta

1. **New optional package `@naculus/connector-solana-kit`** (not a change to
   `connector-solana`): `toKitSigners(roles: SolanaRoles)` returning
   `{ identity: Address; signer?: TransactionModifyingSigner & MessageModifyingSigner; payer?: TransactionSendingSigner }`,
   each present only when `roles.features` says the wallet can. Depends on
   `@solana/kit` as a **peer**; `connector-solana` stays Kit-free, so
   apps on web3.js v1 pay nothing.
2. **Byte bridge**: Kit `Transaction` → wire bytes via
   `getTransactionEncoder()`, wallet returns bytes → `getTransactionDecoder()`
   back to a `Transaction`; signatures map merged. Message signing wraps and
   unwraps `SignableMessage`. This is where the correctness risk is: a wallet
   that *modifies* the message (fee payer / blockhash) must surface as a new
   `Transaction`, not as a signature on the old one — hence
   `TransactionModifyingSigner`.
3. **Reverse adapter** (later): `fromKitSigner(signer)` → `SolanaSigner` /
   `SolanaPayer`, so an app that already built a Kit signer (e.g. a session
   key held in Kit form) can use Naculus's session/policy layer.
4. **Not in scope**: replacing `@solana/web3.js` inside `connector-solana`
   (separate, larger migration); Token-2022 helpers; Kit RPC types in core.

## Boundary for step 2

- Files: new `connect-lib/packages/connector-solana-kit/` only; no edit to
  `connector-solana` beyond exporting types it already has.
- Dependency: `@solana/kit` as a peer of the new package — **a user
  decision**, to be confirmed before step 2 starts. Nothing else.
- Invariants: no signing bytes are constructed by the adapter — it only
  encodes/decodes what Kit or the wallet produced; a wallet lacking a
  feature yields no signer of that kind rather than a stub; `chain` on the
  identity stays CAIP-2 (`solana:5eykt4Us…`), never `solana:0`.
- Tester: the package should be installable there; add it to the gate's
  package set (release-gate discovers public packages from the repos).
- Review: signing adapter → one Claude pass, focused on the modifying-signer
  bridge.

## Order

Step 2 is one Codex package (~200 lines + tests, with Kit's own test signers
as fixtures) once the peer dependency is approved. Independent of threads 1
and 14; can ship in any patch.

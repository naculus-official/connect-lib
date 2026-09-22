# Session keys: one policy engine for embedded and external wallets

Status: review + corrected plan for STATE.md thread 16. No code change.
Date: 2026-09-22.

## What was found

Two `SessionKeyManager`s exist:

| | `core/src/session-keys/` | `wallet-engine/src/session-keys/` |
|---|---|---|
| Size | ~1900 lines | ~940 lines |
| Used by | appkit hooks/composables, `useDelegationPolicy`, external wallets | `PocketWallet` only (`wallet.ts:1941`), i.e. the **embedded wallet** |
| Signs | a 32-byte digest under policy (`signWithSessionKey`, `signWithVerifiedOffchainAuthorization`) | a **whole EVM transaction**: `signWithSession(sessionId, TransactionRequest)` → raw signed tx that `PocketWallet.sendTransactionWithSession` broadcasts |
| Types | own | re-exports core's scope/info types (`types.ts:24-30`) — so the *schema* is already shared |
| Enforces expiry, status, per-tx/total value & gas, tx count, allowedContracts/Methods | yes | yes |
| Enforces `tokenAllowances` | yes (0.2.5) | **no** — a policy that says "USDC ≤ 100" is accepted and ignored |
| Forbidden selectors (`approve`, `increaseAllowance`, `setApprovalForAll`) | yes | **no** |
| Refuses to sign a key with no owner authorization | yes (0.2.5, `unsafeAllowUnauthorizedSigning` opt-out) | **no** — `createSessionKey` then `signWithSession` works |
| Cross-tab lock around check/sign/account (Web Locks) | yes | **no** (`storage.ts` has no lock) |
| Withholds signature if usage cannot be persisted | yes | signs first, `recordUsage` after; a persist failure returns a usable raw tx |
| `kdfIterations` per record | yes (0.2.7) | no |

So the **embedded wallet — the most sensitive path, where Naculus holds the
key — runs the weaker engine**, and none of the 0.2.5 session-key hardening
reached it. That is worse than the SimulationManager duplication was: there
the two copies behaved the same; here one is missing four security controls.

## Why it cannot be a plain re-export

The dependency direction is `wallet-engine → core`, so core cannot import
wallet-engine's EVM serializer; and core deliberately signs digests, not
transactions, because it does not know how to build one. The wallet-engine
copy exists because `PocketWallet` needs "sign this transaction with a
session key" as an EOA would. The shape is legitimate; the second policy
engine is not.

## Corrected plan

1. **core**: no new signing method. `signWithSessionKey(sessionId, digest,
   tx)` already takes the transaction facts (`to`, `value`, `data`,
   `chainId`, `gas`) alongside the digest and enforces the full policy on
   them. That is the seam.
2. **wallet-engine**: replace `session-keys/SessionKeyManager.ts`,
   `storage.ts`, `crypto.ts` with a thin `session-transaction-signer.ts`:
   - build the unsigned transaction and its signing hash with the existing
     `EVMSigner` machinery (`signers/evm.ts` already computes
     `keccak(0x02 ‖ rlp(unsigned))` at line ~287; expose that step as
     `transactionSigningHash(tx)` alongside `signTransaction`);
   - call **core's** `SessionKeyManager.signWithSessionKey(sessionId, hash,
     { to, value, data, chainId, gas })` — policy, authorization check,
     token allowance accounting, lock and withhold-on-persist-failure all
     happen there;
   - assemble the raw signed transaction from the returned 65-byte signature
     (`0x02 ‖ rlp([... , yParity, r, s])`) — the assembler exists in
     `signers/evm.ts` (line ~368), split from the sign step.
   `PocketWallet` keeps its public API (`createSessionKey`, `listSessions`,
   `revokeSession`, `sendTransactionWithSession`, `checkSessionScope`) as
   delegates to a core manager it constructs with its own storage adapter
   and encryption key (the wallet's unlock secret — same key boundary as
   today's `_getSessionMgr`).
3. **Migration**: records written by the wallet-engine copy use its own
   `crypto.ts` encryption (`encryptSessionKey`); core's storage format is
   different (`EncryptedKeyPair` with AES-GCM + AAD). Rather than a
   converter for keys that are by definition short-lived (24h default, 30d
   max), the embedded wallet **revokes and forgets pre-0.2.7 session keys
   on first load** and says so in the release note. No silent
   re-encryption of key material.
4. **Delete** wallet-engine's `session-keys/` copy and its exports from
   `wallet-engine/src/index.ts` (`SessionKeyManager`, the re-exported
   types). Consumers importing `SessionKeyManager` from wallet-engine get it
   from core instead — a public-API change for wallet-engine, so **0.3.0**
   for connect-lib, or a deprecation shim for one patch.

## Boundary for the implementation package

- Files: `wallet-engine/src/session-keys/*` (delete/replace),
  `wallet-engine/src/signers/evm.ts` (split hash/assemble; byte output
  unchanged — pinned by the existing signing-vector tests),
  `wallet-engine/src/wallet.ts` (delegates), `wallet-engine/src/index.ts`;
  no core change expected. Tests: every existing `PocketWallet` session test
  must pass with the new engine, plus one per newly enforced control
  (token allowance, forbidden selector, unauthorized key refused, persist
  failure withholds).
- No new dependency. Signing bytes for a given (tx, key) must be identical
  before and after — assert with the existing vectors.
- Invariants: private key never leaves `IsolatedSigner` / the core manager's
  decrypt-in-memory path; the policy check runs on the *same* `tx` whose
  hash is signed (no check-then-hash gap — hash the built tx,
  then pass both); pre-0.2.7 records are revoked, not migrated.
- Review: wallet-engine + session-keys are both always-review; two Claude
  rounds (engine swap, then PocketWallet wiring).

## Size

~150 lines added (signer + delegates), ~940 deleted, tests ~200. One Codex
package after thread 1 package 1 (both touch `signers/evm.ts`; do the split
once). Ship in the same 0.3.0 as 7702.

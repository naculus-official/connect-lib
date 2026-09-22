# EIP-7702 end-to-end execution

Status: design, step 1 of STATE.md thread 1. No code change.
Date: 2026-09-22.

## Why

Today Naculus *reads* EIP-7702: `core/src/delegation.ts` decodes an
account's code (`0xef0100 || address`) into `DelegationStatus`, appkit has
`useDelegation`, and `useDelegationPolicy` refuses to create a `mode:
"eip7702"` policy because nothing can execute it. There is no way to
**produce** a delegation — sign an authorization tuple, put it in a
type-4 (`SET_CODE_TX_TYPE = 0x04`) transaction, send it — and no executor
that, once an EOA is delegated, runs a session-key-authorized call through
it. Every competitor in the daily benchmark scores 9 here; Naculus 6.5.
ERC-4337 v0.8 also assumes 7702 for EOA-based smart accounts, so this
unblocks that path too.

## The pieces, and where each belongs

```
 owner wallet                    Naculus                          chain
 ────────────                    ───────                          ─────
 signs authorization  ◄──  (A) authorization tuple builder
   (chainId, address,          + signer abstraction
    nonce) → yParity,r,s
                           (B) type-4 tx builder / serializer
                               [chainId,nonce,fees,gas,to,value,
                                data,accessList,authorizationList]  ──►  EOA code = 0xef0100||impl
                           (C) delegation executor
                               session key signs the *call*,
                               dispatched to the EOA's implementation ──►  execute(calls)
                           (D) policy: eip7702 mode becomes creatable
                               only when (A)+(B)+(C) exist for the chain
```

| Piece | Package | Why there |
|---|---|---|
| (A) `buildAuthorization({chainId, address, nonce})` → unsigned tuple; `authorizationHash` = keccak(0x05 ‖ rlp([chainId, address, nonce])); `signAuthorization(signer)` → `{chainId, address, nonce, yParity, r, s}` | `wallet-engine` (hashing + raw signature over a 32-byte digest, no connector knowledge) + a `UniversalConnector.signAuthorization?` hook for external wallets that support `eth_signAuthorization` / `wallet_signAuthorization` (**verify** the method name wallets ship) | wallet-engine already owns secp256k1 raw-digest signing and RLP (`signers/rlp.ts`); the connector hook is the same pattern as `onSessionChanged` |
| (B) type-4 transaction: `0x04 ‖ rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList, authorizationList, yParity, r, s])` | `wallet-engine/src/signers/evm.ts` next to the existing 0x02 path | same file already serializes 1559; 7702 adds one list field and the `0x04` prefix. Rule: `to` must not be empty (7702 forbids creation), `authorizationList` must be non-empty |
| (C) executor: given `DelegationStatus.delegate` and a known implementation (the delegate address is an allow-listed, audited "delegation target" contract), encode `execute(calls)` per that implementation's ABI, produce the session-key-signed request, broadcast via the connector | `core` (`account-abstraction/` sibling: `delegation-executor.ts`), implementation ABIs as constants; a `PolicyExecutionAdapter` with `route: "eip7702"` so `useDelegationPolicy` uses it unchanged | the adapter contract already exists (`check / prepare / broadcast`) and `executePolicy` already re-checks delegation matches `executorAddress` |
| (D) `SessionKeyScope.mode === "eip7702"` creation | `core/session-keys` + appkit `useDelegationPolicy` | currently refused with `method_not_allowed`; allowed only when an adapter is configured for the chain |

## What is fixed by the spec and not negotiable

- Authorization signs `keccak256(0x05 ‖ rlp([chain_id, address, nonce]))`;
  `chain_id = 0` means "any chain" and must be refused by default (a
  cross-chain-replayable delegation is exactly the wrong default for a
  wallet SDK); `nonce` is the **authority's** current nonce, +1 when the
  same EOA also sends the type-4 tx (self-sponsored) — the single most
  common integration bug, so it is computed, never caller-supplied.
- Delegating to `address(0)` clears the delegation — that is the revoke
  path and must exist from day one.
- Which implementation an EOA is delegated to is a security decision: the
  executor refuses any `delegate` not in an explicit allowlist the app
  configured (defaults to none). Naculus does not ship an implementation
  contract; it ships adapters for known ones (**verify** current audited
  candidates — e.g. the reference "simple 7702 account" / Kernel /
  MetaMask delegation framework — and pin their `execute` ABIs).

## Delta, in order

1. **wallet-engine**: `authorizationHash`, `signAuthorization` (via
   `IsolatedSigner` so the key never leaves the worker), type-4 serialization
   with the two rules above, and a `TransactionRequest.type = "eip7702"`
   with `authorizationList`. Tests against spec vectors (**verify**: the EIP
   test vectors / a Foundry-generated fixture).
2. **core**: `UniversalConnector.signAuthorization?` hook; `SessionChange`
   already covers scope, so nothing there. `delegation-executor.ts` with
   the allowlist, `DelegationExecutionAdapter implements
   PolicyExecutionAdapter` (`route: "eip7702"`), `check` reading
   `readDelegation` + allowlist membership + nonce, `prepare` encoding the
   call, `broadcast` sending through the connector.
3. **connectors**: `connector-embedded` implements `signAuthorization` via
   wallet-engine; `connector-evm-injected` / `walletconnect` forward to the
   wallet method when the wallet advertises it (capability, **verify** how
   — likely `wallet_getCapabilities` `atomic`/`auxiliaryFunds` neighbors or
   a dedicated key), otherwise `method_unsupported`.
4. **session-keys + appkit**: allow `mode: "eip7702"` creation when an
   adapter is configured; `useDelegationPolicy` needs no logic change (the
   flow already handles the adapter route); add `useDelegate()` (sign +
   send the type-4 tx, and the `address(0)` revoke) in React and Vue over a
   new `core` helper.

## Boundary for step 2

- Files: `wallet-engine/src/signers/{evm,rlp}.ts`, `wallet-engine/src/wallet.ts`
  (+tests) for 1; `core/src/connector.ts`, `core/src/account-abstraction/
  delegation-executor.ts`, `core/src/delegation.ts` (+tests) for 2;
  the three connectors for 3; `core/src/session-keys/*`, appkit hooks for 4.
- No new dependency. No change to the authorization hash or tx encoding
  beyond the spec. No default allowlist entries.
- Invariants: `chainId: 0` refused unless `unsafeAllowAnyChainAuthorization`
  (named to be found in review); nonce computed from chain state;
  delegate must be allowlisted; the session key signs only the *call*, never
  the authorization (the owner signs that); revoke (`address(0)`) is always
  available; every path fail-closed on unknown wallet capability.
- Review: wallet-engine signing bytes and connector signing paths are
  always-review; each step gets a Claude pass, and step 1 additionally a
  spec-vector test before any wallet is asked to sign.

## Size

Roughly: 1 ≈ 250 lines + vectors; 2 ≈ 300; 3 ≈ 150; 4 ≈ 200 + appkit
shells. Four Codex work packages in that order, each stopping at review.
This is the 0.3.0 headline together with thread 14 step 2 (both change what
a session key may sign). Step 1 can start now; nothing blocks it.

# Session keys through an EIP-7702 delegated account

Status: design **approved by the user 2026-09-25**, STATE.md thread 17
(option (b) of the 2026-09-23 decision in `eip7702-execution.md`).

**Decisions (user, 2026-09-25):** the session key pays the redemption gas
(it stays an EOA, as in thread 16); single-token / single-recipient scopes
only — anything more is refused; chains: Ethereum, Sepolia, Base, Base
Sepolia, Arbitrum One, Optimism, Polygon. `eth_getCode` on all seven
(2026-09-25) found DelegationManager (11503 bytes),
EIP7702StatelessDeleGatorImpl (11185), TimestampEnforcer (1255) and
ERC20TransferAmountEnforcer (2078) at the pinned addresses with identical
sizes.

## Why

0.3.0 made EIP-7702 an owner feature: an embedded-wallet EOA can delegate its
code to an allowlisted implementation and revoke it. A session key still acts
as **its own EOA** — it holds its own funds and sends its own transactions
(thread 16). Option (b) lets a session key act **on the owner's account**
instead: spend the owner's tokens, within limits enforced *on chain*, without
a wallet prompt and without first funding the key with the assets it moves.

The audited minimal target, `Simple7702Account`, cannot do this: it executes
only for itself or the EntryPoint and validates the EOA's own key. A
permission framework is required.

## Choice: MetaMask Delegation Framework v1.3.0

Checked 2026-09-25 against `github.com/MetaMask/delegation-framework`
(`documents/`, `src/`, release `v1.3.0` of 2025-07-24).

| | MetaMask Delegation Framework | ERC-7579 account + session module |
|---|---|---|
| 7702 target | `EIP7702StatelessDeleGatorImpl` `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B` — stateless, validates `ECDSA.recover(hash, sig) == address(this)` | depends on the account (Kernel, Nexus, Safe7579) and the module |
| Audits | Cyfrin ×7, ConsenSys Diligence ×5 (`audits/`) | per vendor |
| Deployment | deterministic, same addresses on 25+ main and test networks (`Deployments.md` v1.3.0) | per vendor |
| Permission model | **offchain EIP-712 `Delegation`** from the owner to a delegate, with `Caveat[]` checked by enforcer contracts at redemption | module-specific session structs |
| Standard | ERC-7710 `redeemDelegations` | ERC-7579 modules |

The delegation model is the closest fit to `SessionKeyScope`: the owner signs
a statement "this delegate may do X under these caveats", which is what a
Naculus policy already is — off chain today, enforced on chain here. One
framework, one audited implementation, one address set. **Recommended.**

## How it works

```
 owner EOA ──7702──► EIP7702StatelessDeleGator (code at the owner's address)
     │
     └─ signs Delegation{ delegate: sessionKeyAddress, delegator: owner,
                          authority: ROOT, caveats: [...], salt }  (EIP-712,
                          domain "DelegationManager" v"1", chainId,
                          verifyingContract = DelegationManager)
 session key EOA ──tx──► DelegationManager.redeemDelegations(
                            [abi.encode([delegation])], [mode], [execution])
                            → validates signature via the owner's ERC-1271
                            → caveat hooks (before/after)
                            → owner.executeFromExecutor(execution)
```

- `DelegationManager` v1.3.0: `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3`.
- Typehash (signature excluded):
  `Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)`.
- The owner signs the delegation with the same key that controls the EOA;
  the stateless DeleGator's `isValidSignature` accepts exactly that.
- The session key sends the redemption transaction and pays its gas (it is
  still an EOA, as in thread 16). A 4337 / sponsored redemption is a later
  step, not in this design.

## `SessionKeyScope` → caveats

| Scope field | Enforcer (v1.3.0 address) | `terms` | Fit |
|---|---|---|---|
| `expiry` | `TimestampEnforcer` `0x1046…c069` | `uint128 after ‖ uint128 before` (32 bytes) | exact |
| `maxTxCount` | `LimitedCallsEnforcer` `0x0465…5416` | `uint256` | exact |
| `allowedContracts` | `AllowedTargetsEnforcer` `0x7F20…EeB` | packed 20-byte addresses | exact |
| `allowedMethods` | `AllowedMethodsEnforcer` `0x2c21…42B5` | packed 4-byte selectors | exact |
| `maxValuePerTx` | `ValueLteEnforcer` `0x92Bf…6A8F` | `uint256` | exact |
| `maxTotalValue` (native) | `NativeTokenTransferAmountEnforcer` | `abi.encode(uint256)` | exact (cumulative, on chain) |
| `tokenAllowances` | `ERC20TransferAmountEnforcer` `0xf100…D2Fc` | `address token ‖ uint256 max` (52 bytes) | **one token per enforcer**; several tokens need `LogicalOrWrapperEnforcer` or one delegation per token |
| `allowedRecipients` | `AllowedCalldataEnforcer` on the ERC-20 `to` word | `uint256 dataStart ‖ value` | **one recipient**; several need `LogicalOrWrapperEnforcer` |
| `allowedChainIds` | none — the EIP-712 domain binds the delegation to one chain | — | one delegation per chain |
| forbidden selectors | none — the framework is allow-list only | — | require `allowedMethods` to be set (no deny-list on chain) |
| `maxGasPerTx`, `maxTotalGas` | none | — | not needed: the session key pays its own gas |

What cannot be expressed is refused, not approximated: a scope with several
tokens or several recipients is **not** created in this mode until the
`LogicalOrWrapperEnforcer` composition is designed and tested (it has
context-switching pitfalls documented in `CaveatEnforcers.md`). A scope
without `allowedMethods` is refused, because on chain there is no deny-list
to stand in for Naculus's forbidden selectors.

## Invariants

- The delegate is always the session key's address; never an **open
  delegation** (`delegate = 0xa11`).
- `authority` is always ROOT, and every delegation carries
  `RedeemerEnforcer` = [session key] (v1.3.0
  `0xE144b0b2618071B4E56f746313528a669c7E65c5`, on all seven chains). The
  session key is an EOA and DelegationManager accepts a re-delegation it
  signs; the key signs caller-computed digests (package 2, option (b)), so it
  could be made to sign one. The redeemer caveat makes any such chain revert:
  only the session key itself can redeem (review, 2026-09-25).
- The owner's EOA must be delegated to `EIP7702StatelessDeleGatorImpl` for
  the chain in question (checked with `readDelegation`); if it is later
  re-delegated or revoked, every delegation becomes unredeemable — that is
  the intended kill switch.
- Revocation: local revoke immediately; on-chain `disableDelegation` by the
  owner (costs gas) offered, since a leaked session key plus a signed
  delegation is otherwise valid until `expiry`.
- The off-chain `SessionKeyManager` check still runs before the session key
  signs a redemption (defense in depth); the on-chain caveats are the
  authority.
- Addresses above are pinned constants per chain in `constants.ts`, checked
  against `Deployments.md`; no address is accepted from a dapp.
- Nothing new is allowed by default: the mode is off unless the app
  configures the framework for a chain.

## Delta (work packages, in order)

1. **core** `session-keys/delegation-framework/`: EIP-712 `Delegation`
   hashing (independent vectors from the framework's own tests / viem),
   scope → caveats encoder with the refusals above, `buildDelegation`,
   constants. No signing.
2. **core** manager: `mode: "eip7702"` creation when the framework is
   configured — the owner signs the delegation through the connector
   (`signTypedData`), stored alongside the session record; the session key
   signs a `redeemDelegations` transaction for an execution checked against
   the same scope.
3. **wallet-engine / connector-embedded**: owner signs the delegation
   (embedded), session key sends the redemption (same tx path as thread 16).
4. **appkit**: `useDelegationPolicy` accepts the `eip7702` route with the
   framework adapter; React + Vue shells.

Review: session-keys and signing are always-review — two independent passes
(1–2, then 3–4). Verification against a fork of a chain where v1.3.0 is
deployed (anvil `--fork-url`) before any wallet is asked to sign.

## Open questions for the user

Answered 2026-09-25 — see *Decisions* at the top.

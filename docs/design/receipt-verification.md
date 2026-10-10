# Receipt verification

Status: **approved 2026-10-02**. Implements gap 2 ("Prove") of [authorization-boundary.md](./authorization-boundary.md).

## Problem
x402 `PAYMENT-RESPONSE` and MPP `Payment-Receipt` carry a settlement reference the server chose. appkit's `describePayment` shows it as "unverified" (payment-fetch.ts). Nothing checks that the chain actually paid the expected recipient, asset and amount for *this* authorization. A server can report another payment's hash, a failed transaction, or nothing that happened.

## Principle
A receipt is verified only when the chain shows a settled transfer that is bound to what this client signed. "A transfer of the right amount to the right address exists" is not enough: it must be *ours*.

## Checks per rail
| Rail | Reference | Verified when (all must hold) | Binding to our authorization |
|---|---|---|---|
| x402 EVM `exact`, MPP EVM `charge` (EIP-3009) | tx hash | receipt status 1 on the expected chain; ERC-20 `Transfer(from=payer, to=payTo, value=amount)` emitted by the asset contract; `AuthorizationUsed(authorizer=payer, nonce)` in the same tx | the 32-byte EIP-3009 nonce we signed |
| x402 SVM `exact`, MPP Solana `charge` | tx signature | tx found at ≥ confirmed, `meta.err == null`; recipient's token balance for `mint` increases by `amount`; payer's decreases by ≥ amount | the transaction contains the payer signature over the message we signed (we keep the signed message hash) |
| MPP Solana `session` | channel id | after close, channel account `settled == last voucher cumulative` and status Distributed (or account reclaimed + distribute tx found); after forced close, `payerWithdrawnAt != 0` | channel id derived from our open; cumulative from our last voucher |

Result type: `{ status: "verified", block/slot } | { status: "pending" } | { status: "mismatch", reason } | { status: "failed" } | { status: "unavailable" }`. Only "verified" may be shown as paid. `pending` is retried by the caller.

## Placement
- connect-core: `verifyEip3009Settlement(rpc, expected)`, `verifySolanaTransferSettlement(rpc, expected)`, `verifyChannelSettlement(rpc, expected)` — pure over a minimal RPC interface (eth_getTransactionReceipt; getTransaction jsonParsed; getAccountInfo). No new dependency (log decoding by topic constants).
- payments-x402 / payments-mpp: keep what the client signed (nonce / signed message hash / last voucher) on the fetch result so a verifier has the binding. Opt-in `verifySettlement` helper per rail.
- appkit-core: `describePayment` gains `verification` state; shells re-run on `pending`.

## Decisions (approved 2026-10-02)
1. Verification is a **separate, opt-in step**; fetch results are never withheld for it (settlement can lag the response by seconds to minutes).
2. Confirmation depth is caller-configurable; defaults **EVM 1 block, Solana `confirmed`**.

## Test plan
EVM: real Base Sepolia or a recorded receipt fixture from Base mainnet for a known USDC transferWithAuthorization (read-only). Solana: a local Surfpool fork harness — charge and session close produce real transactions to verify; negative cases: swapped recipient, wrong amount, another payer's tx, failed tx.

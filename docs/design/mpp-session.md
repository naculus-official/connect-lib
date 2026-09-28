# MPP session intent (metered payments over a payment channel)

Status: **approved 2026-09-28** — Solana, client side, pinned program
(address + deployed slot), delegated voucher key. Not implemented yet.
Sources: tempoxyz/mpp-specs `specs/methods/solana/draft-solana-session-00.md`,
`specs/methods/evm/draft-evm-session-00.md`; reference SDKs `@solana/mpp`
0.7.0 and `mppx` 0.11.0 (read, not installed).

## Goal

Pay a server per unit of use (LLM tokens, bytes, requests) without a wallet
prompt per unit and without reserving the worst case up front. The `charge`
intent we ship pays one fixed amount per 402; `session` opens an on-chain
escrow once, then pays with off-chain **cumulative vouchers**
("the server may take up to N in total from this channel"), settled by the
server when it likes.

## What the specs require

- The deposit sits in an **escrow program / contract named by the server's
  challenge** (`methodDetails.channelProgram` on Solana,
  `methodDetails.escrowContract` on EVM). The escrow is the only thing
  standing between the deposit and the server: a server that names its own
  contract can take everything deposited. Solana's spec says clients MUST
  verify the program is the expected one before depositing; the EVM spec
  calls the escrow "trusted code" and names none.
- A voucher is a signature over (`channelId`, `cumulativeAmount`[,
  `expiresAt`]). The chain pays out at most the deposit; the server settles
  `cumulativeAmount − settled`.
- The voucher key may be the payer or a delegated key bound into the
  channel at open (`authorizedSigner`). A delegated key signs without
  prompts; the deposit is its hard cap.
- Forced close: the payer can always `requestClose`, wait the grace period
  and withdraw what no voucher covers.

## Where it can actually run today

| | Solana | EVM (Base, Ethereum, …) | Tempo (EVM-like L1) |
|---|---|---|---|
| Escrow deployed | **Yes**: `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX` on mainnet and devnet (checked 2026-09-28: executable, upgradeable loader) | **No canonical deployment**; mppx implements EVM `charge` only | Yes: mppx pins `0x33b9…4f25` (mainnet) |
| Reference SDK | `@solana/mpp` (client + server) | none for session | `mppx` (client + server) |
| Naculus base | charge client + server, SPL builder/verifier, `SolanaSessionKeyManager` | charge only | no Tempo chain support |

The Solana program is **upgradeable by a single key** (mainnet upgrade
authority `DXtFpbPjcn2hxPnw79x1Pfoj35vXh5AsWBkS37YnXMVv`, a plain system
account, not a multisig; last deployed at slot 431447053). Whoever holds it
can replace the program and with it the rules protecting every open
deposit. The spec's "verify the program address" does not cover this.

## Proposed design (Solana, client side first)

### Trust in the channel program — default deny

- Built-in allowlist per cluster: program address **and** the ProgramData
  last-deployed slot recorded when we reviewed it. Before every open and
  top-up the client reads the program's ProgramData over the app's RPC
  (after the genesis cluster check we already do) and refuses if the
  address is not listed or the program was redeployed since (slot moved,
  or authority changed). A redeploy therefore stops new deposits until an
  SDK update re-pins it; existing channels can still be closed.
- `trustProgram: { address, slot }` lets an app pin another deployment
  explicitly (the mppx `allowCustomEscrow` equivalent). Never taken from
  the challenge.

### Keys and signing

- The owner's wallet signs the **open** transaction once (deposit transfer,
  PDA creation), verified after signing like our charge path: the exact
  instructions we built, the pinned program, the challenge's payee, mint
  and amounts; only Lighthouse assertions may be added.
- `authorizedSigner` is a **fresh ed25519 voucher key** held encrypted by
  a new record type in the existing session-key storage (same PBKDF2 /
  AES-GCM, AAD record binding). It signs only the 50-byte voucher layout
  (`0x56 0x01 ‖ channelId ‖ u64 cumulative ‖ i64 expiresAt`), built by us
  from checked facts — never bytes it is handed. That format cannot be a
  transaction message (fixed 50 bytes, `0x56` first byte), so the key
  cannot be tricked into signing a transfer.
- `voucherSigner: "operator"` (the server signs vouchers, client sends a
  bearer proof) is refused: it gives the server the payment decision.

### Voucher policy (enforced before signing, persisted before returning)

- Per channel: the deposit is the chain cap; locally also `maxCumulative`
  (≤ deposit), `maxDelta` per voucher, `expiry`, and the cumulative amount
  only ever increases (recorded before the signature is returned, as the
  EVM and Solana session keys do today).
- How much to sign: the app says what it consumed (`meter.add(units)`),
  the client signs `price × units` on top of the last voucher. It never
  signs an amount the server asks for without the app's count; a server
  asking for more than the metered amount gets refused, not paid.
- Challenge checks: `network` matches the RPC's genesis; `currency` mint
  passes our Token-2022 screen; `recipient`, `amount` (per unit),
  `gracePeriodSeconds` (minimum configurable, default 1 hour) and
  `distributionSplits` are shown to / bounded by the app; the
  `recentBlockhash` the server supplies must be valid on the app's RPC.

### Close

- Cooperative: send `action="close"` with the final voucher; the server
  settles and refunds atomically.
- Forced: `requestClose` then `withdrawPayer` after the grace period,
  signed by the owner's wallet (or submitted by anyone where the spec
  makes it permissionless). The SDK tracks open channels so a UI can offer
  this.

### Package placement

- `@naculus/payments-mpp`: `createMppSessionFetch` (client), beside
  `createMppFetch`. Channel PDA, instruction builders and voucher encoding
  in `connect-core/src/solana-channel.ts` (pure bytes, no new dependency),
  vectors checked against `@solana/mpp`'s generated client in a scratch
  directory (not added as a dependency).
- appkit: a `useMppSession` hook later, logic in appkit-core.

### Out of scope (this phase)

EVM session (no deployed escrow outside Tempo), Tempo chain support, the
server side (`payments-mpp/server` accepting sessions: channel state,
`settleAndSeal` + `distribute`), operator-signed vouchers, secp256r1
(passkey) voucher signers, distribution splits other than a single payee.

## Work packages

1. connect-core: channel PDA derivation, open / topUp / requestClose /
   withdraw instruction builders, voucher encoding, program-trust check;
   vectors vs `@solana/mpp`. Review (wallet / signing path).
2. payments-mpp: `createMppSessionFetch` — challenge parsing, open, voucher
   loop with the meter, close; voucher-key storage record. Review.
3. Interop run on devnet against a `@solana/mpp` server in a scratch
   directory (open → vouchers → close), funded devnet account needed.
4. appkit `useMppSession`. Review (1 round).
5. Later, separately decided: server side; Tempo / EVM.

## Decisions (user, 2026-09-28)

1. Chain: **Solana first**. Tempo is recorded as an open thread in the
   workspace state, not started.
2. Side: **client only**; the server side is decided separately later.
3. Program trust: **address + deployed-slot pin**; a redeploy refuses new
   deposits until an SDK update re-pins it.
4. Voucher key: **delegated voucher key**, no prompt per voucher.

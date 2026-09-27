# x402 over Bitcoin Lightning (`exact` on `lnbtc`)

Status: **design only, nothing implemented.** Date: 2026-09-27. Naculus has
no Bitcoin or Lightning code today: no BOLT11 decoder, no Lightning
connector, no `lnbtc` handling in `payments-x402` (whose
`selectRequirement` routes anything that is not `solana:` to the EVM check
and refuses it, `packages/payments-x402/src/evm-exact.ts`).

## Pinned sources

| Source | Where | Pinned at |
|---|---|---|
| x402 `exact` on Lightning spec | `https://github.com/x402-foundation/x402/blob/02e80f38e015ac0dc522a4285f41bf93d90b102f/specs/schemes/exact/scheme_exact_lnbtc.md` | file added by `6fe0d4b` "Specify exact Lightning on lnbtc (#2861)", 2026-09-23; repository head `02e80f3`, 2026-09-27 |
| x402 v2 core and HTTP / MCP transports | same repository, `specs/x402-specification-v2.md`, `specs/transports-v2/http.md`, `specs/transports-v2/mcp.md` | `02e80f3` (HTTP and core last changed `e187dda`, 2026-08-31) |
| Open follow-up: `invoice` transfer method | `https://github.com/x402-foundation/x402/pull/3572` | open as of 2026-09-27 (read via the PR page) |
| NIP-47 Nostr Wallet Connect | `https://github.com/nostr-protocol/nips/blob/b82211e96c6dad616ed2ea43034c1c621256b745/47.md` | `47.md` last changed `c538775`, 2026-08-01 |
| LNURL LUD-03 / LUD-06 | `https://github.com/lnurl/luds/tree/913c49e5b65081473eed7889eee5f806dd30f049` | 2026-08-06 |
| WebLN provider interface | `https://github.com/joule-labs/webln/blob/961f02edf0ba9f99235eb28e29e981acd24158f6/src/provider.ts` | 2022-12-22 (last commit) |
| BOLT 11 | `https://github.com/lightning/bolts/blob/1aadb719b4007c4cea0ba6e36b08c4fb53788dee/11-payment-encoding.md` | file last changed `14901bd`, 2026-03-09 |

**Repository move.** `coinbase/x402` — the repository
`docs/design/agentic-payments.md` pinned on 2026-09-24 — now says in its
README (commit `dd927a2`, 2026-04-21) that the canonical repository is
`x402-foundation/x402` and that `coinbase/x402` is a development fork.
The Lightning spec exists only in the foundation repository. Future pins
should use `x402-foundation/x402`.

## What the spec requires (summary, not a substitute)

- **Network**: CAIP-2 namespace `lnbtc`, reference = first 32 hex chars of
  the Bitcoin genesis hash. Only `lnbtc:000000000019d6689c085ae165831e93`
  (mainnet, BOLT11 currency `bc`) and `lnbtc:000000000933ea01ad0ee984209779ba`
  (testnet, `tb`).
- **Requirement**: `scheme: "exact"`, `asset: "BTC"`, `amount` in
  **millisatoshis** (decimal string), `payTo` = the receiver node's
  compressed secp256k1 public key (66 lowercase hex), `maxTimeoutSeconds` =
  the invoice expiry. `extra`: `paymentFlow: "upfront"` (required, only
  value), `assetTransferMethod` absent or `"bolt11"`, `invoice` (a fresh
  BOLT11 per challenge), `requestHash`, `requestBindingProfile` (`http:1`
  or `mcp:1`), `requestBindingParams`.
- **Request binding**: the invoice's signed **description hash** equals
  `SHA-256(UTF8(JCS(binding)))`, where `binding` is built from the actual
  request — for `http:1`: method, absolute URL, SHA-256 of the body bytes,
  and hashes of server-listed headers; for `mcp:1`: server URI, `tools/call`,
  tool name, arguments, and hashes of listed `_meta` members. The client
  **must recompute it from its own request** and reject the challenge if it
  differs, if the invoice carries an inline description, or if the profile
  does not match the transport (MCP calls must use `mcp:1`).
- **Client checks before paying** (spec §Client Payment Construction):
  strict BOLT11 decode and signature check; signing key = `payTo`; currency
  matches the network; invoice amount (integral msat) = `amount`; expiry =
  `maxTimeoutSeconds`; creation time ≤ now + skew (default 60 s); not
  expired.
- **Payment**: the payer's node pays the invoice (routing fees are extra,
  paid by the payer) and must return the **preimage**. The client checks
  `SHA-256(preimage) = payment_hash` and that the adapter reports the same
  invoice, hash and amount. A client **must not** use an adapter that cannot
  return the preimage.
- **Payload**: `{ x402Version: 2, accepted: <requirement incl. invoice>,
  payload: { preimage } }`. The preimage is a **bearer proof**; it must be
  sent only to the resource server whose invoice was paid, and never
  logged.
- **Settlement**: facilitator `/settle` only (no `/verify`), checks the
  proof locally, records `network:payment_hash` in a durable replay store.
  `SettlementResponse.transaction` is the payment hash; `payer` is omitted.
- **No refund path**; an overpayment buys nothing extra.

Difference from the flows Naculus already supports: in EVM `exact` the
client **signs** and the facilitator **moves the money**; in Lightning
`exact` the client **moves the money first** and then presents a proof.
There is no authorization the server could decline to settle — the spend
happens before the retry.

### Reference implementation status

At `02e80f3` the foundation repository has **no** `lnbtc` mechanism in any
SDK: `typescript/packages/mechanisms/` holds thirteen network directories
(from `aptos` to `xrpl`), none for Lightning; `go/mechanisms/` holds `evm`
and `svm` (its README lists "Bitcoin Lightning —
`lightning/exact/`" under networks that *can be added*);
`python/x402/mechanisms/` holds `evm`, `svm`, `tvm`. `docs/schemes/exact.mdx`
links the spec. The PR #2861 discussion links third-party TypeScript
implementations (one describes "LND behind a swappable interface"); these
were **not reviewed** for this note. PR #3572
(open) proposes a second transfer method, `invoice`, for payers that
cannot obtain a preimage, verified by the facilitator querying the
receiver; `bolt11` stays the default.

## What Naculus would need

Only the **client (payer)** side; running a receiver or facilitator is out
of scope, as for EVM and Solana (`docs/design/agentic-payments.md` §The
delta, item 4).

1. **Parsing and checks** (pure, no key material):
   - `lnbtc` requirement validator mirroring `unsupportedReason` /
     `svmUnsupportedReason`, refusing anything outside the spec lists.
   - A strict **BOLT11 decoder** with signature recovery (bech32,
     tagged fields, amount multipliers to integral msat, `h` description
     hash, `n` payee, `x` expiry, timestamp). `@noble/curves` (already a
     core dependency) covers secp256k1 recovery; `@scure/base` (already a
     core dependency) covers bech32. A new dependency such as
     `light-bolt11-decoder` is an alternative — a maintainer decision.
   - **JCS** (RFC 8785) encoding and the two binding profiles. Naculus has
     no JCS encoder today; `payments-mpp` only parses the base64url JCS JSON
     it receives (`packages/payments-mpp/src/wire.ts`) and echoes
     challenge values unchanged.
   - Test vectors: the spec's own (§Request Binding Test Vectors: HTTP
     article A/B, MCP `get_article`) plus its example invoice.
2. **A payer adapter** — the part that holds or reaches spending power
   (options below). Interface **(proposed)**:

   ```ts
   interface LightningPayer {
     network: "lnbtc:000000000019d6689c085ae165831e93" | "lnbtc:000000000933ea01ad0ee984209779ba";
     /** Pays exactly the invoice amount; resolves only on a terminal state. */
     payInvoice(invoice: string, amountMsat: bigint): Promise<
       | { status: "paid"; preimage: string; paymentHash: string; feesPaidMsat?: bigint }
       | { status: "in_flight"; paymentHash: string }
       | { status: "failed"; reason: string }
     >;
   }
   ```

   The adapter's answer is untrusted: the client re-checks the preimage
   against the invoice's hash (spec requirement) before building a payload.
3. **Policy** — Lightning has no on-chain allowance or delegate, so the
   limits live in Naculus and/or in the payer (see §Policy limits).
4. **`createX402Fetch` integration**: a third `lightning?: { payer, policy }`
   option next to `signer` and `solana`, routed on `network.startsWith("lnbtc:")`.
   The existing origin/redirect rules apply unchanged; additionally the
   `http:1` binding needs the request body bytes, which the wrapper already
   keeps (`new Request(input, init)` then `request.clone()`, `fetch.ts`).
5. **In-flight handling**: a payment that is neither paid nor failed must
   not trigger a second payment; the spec's `exact_lnbtc_payment_in_flight`
   is surfaced to the caller with the payment hash so a later retry can
   look it up rather than re-pay.

## Payer options

| | NWC (NIP-47) | WebLN | Node API (LND REST / CLN / LDK) | LNURL |
|---|---|---|---|---|
| What it is | Encrypted Nostr events (kinds 23194/23195) to a wallet service over relays; `pay_invoice` returns `preimage` (47.md §Commands) | `window.webln` injected by a browser extension; `sendPayment(paymentRequest)` → `{ preimage }` (`provider.ts`) | HTTP/gRPC to a node the app or user runs, with a macaroon/rune | LUD-06 is a *payee* protocol (fetch an invoice from a static link); LUD-03 is a *withdraw* flow |
| Returns preimage | yes, required in the response | yes | yes | n/a |
| Runs in browser / RN / server | all three (WebSocket + NIP-44) | browser with an extension only | server; browser only with CORS and an exposed credential | — |
| Key custody | wallet service holds node keys; client holds a **per-connection secret** from the `nostr+walletconnect://` URI | extension | whoever runs the node; the app holds a spending credential | — |
| Wallet-side limits | spec says keys "can have arbitrary constraints (eg. budgets)" (47.md §Connection URI); enforcement is the wallet service's | per extension (e.g. per-site allowances) | node-level only unless a proxy adds them | — |
| Fits x402 `exact` | **yes** | yes, interactive | yes, server-side agents | **no** — x402 hands the client a fixed invoice; neither LUD-03 nor LUD-06 pays one |
| Fit with Naculus architecture | a connector-like adapter; no new key type in Naculus | a connector (like `connector-evm-injected` for EIP-1193) | out of scope for a browser SDK; an adapter interface lets server users plug one in | — |

NWC notes from 47.md: NIP-44 v2 is required, NIP-04 is deprecated and
assumed when the wallet's info event has no `encryption` tag — a client
should refuse NIP-04 (**proposal**). Events are ephemeral; relays that drop
idle connections lose requests, which maps to the spec's "in flight" state.

## Key custody

- **NWC**: the only secret Naculus would hold is the connection secret
  (32 bytes). It authorizes spending up to whatever the wallet service
  allows. It is equivalent in sensitivity to a session key and should be
  stored the same way: sealed like `SolanaSessionKeyManager` records
  (`packages/core/src/session-keys/solana-session-keys.ts`, AES-GCM with the
  record's fixed facts as associated data) **(proposal)**.
- **WebLN**: nothing held by Naculus.
- **Node API**: a macaroon/rune — never in a browser bundle.
- **Embedded Lightning node** (LDK in-browser / RN): would make Naculus a
  custodian of channel state and on-chain funds with liveness duties
  (watchtowers, force-close handling). **Not recommended** for this SDK;
  listed for completeness.

## Policy limits

The spec leaves spending decisions to the client. EVM and Solana policies
are enforced where the key signs; for Lightning Naculus never sees a key,
so a **Naculus-side policy** would sit in front of the payer
(**proposal**):

| Limit | Why |
|---|---|
| `networks` allowlist (mainnet / testnet) | a testnet challenge must not reach a mainnet wallet; the spec's currency check is the second line |
| `maxPerPaymentMsat` | the server sets `amount` |
| `maxFeeMsat` (absolute and/or ppm) | routing fees are paid on top of `amount` and are not bounded by the spec |
| cumulative `budgetMsat` with expiry | same role as `tokenAllowances` / SPL `delegated_amount` |
| `allowedPayees` (node public keys) and/or origin allowlist | the only stable payee identity is `payTo` |
| `maxTxCount` | parity with session keys |

Accounting must be persisted **before** the payer is called (the spend is
irreversible and happens before the retry), under the same Web Lock
pattern as session keys (`withAdapterLock`,
`packages/core/src/session-keys/storage.ts`). A payment reported
`in_flight` stays charged until it fails. These limits are local and can be
reset by same-origin code (compare threat model O3,
`docs/security/threat-model.md`); the wallet-side NWC budget is the
independent cap and should be required to be set (**proposal**).

## Recommendation

1. **Payer**: NWC first, behind the `LightningPayer` interface; WebLN as a
   second, interactive adapter. Node APIs only as a documented
   interface for server-side users. No LNURL, no embedded node.
2. **Scope**: `bolt11` / `upfront` only, both profiles, both networks, as
   the spec defines; ignore the `invoice` method until PR #3572 is merged.
3. **Placement**: pure parts (BOLT11, JCS binding, requirement checks,
   policy) in `payments-x402` or a new `@naculus/payments-lightning`; NWC
   transport in its own package so that relays/WebSockets are not pulled into
   users who do not want Lightning.
4. **Fail-closed defaults**: no Lightning payment unless a payer *and* a
   policy with `maxPerPaymentMsat`, `maxFeeMsat` and `budgetMsat` are
   configured; `approve` callback honored as for EVM/Solana.
5. **Verification**: spec vectors in unit tests; a testnet end-to-end run
   against a receiver that follows the spec (none in the foundation repo
   today — see Reference implementation status).

## Decisions the maintainer must make

1. **Do it now or wait** for an official reference implementation in
   `x402-foundation/x402` (none at `02e80f3`).
2. **Payer adapters**: NWC only; NWC + WebLN; or an interface only, with no
   bundled adapter.
3. **Dependencies**: write BOLT11/bech32 decoding on `@scure/base` +
   `@noble/curves`, or add a BOLT11 library; NWC on a Nostr library
   (e.g. `nostr-tools`) or a minimal NIP-44 + relay client.
4. **Package home**: inside `payments-x402` vs. a new package (new packages
   need the npm bootstrap, as for `payments-x402` / `payments-mpp`).
5. **Policy location**: Naculus-side limits only, wallet-side (NWC budget)
   only, or both (recommended: both, with NWC budget required).
6. **Storage of the NWC secret**: sealed record like Solana session keys,
   or caller-held only.
7. **Networks**: mainnet from the start, or testnet only until an
   end-to-end run has passed.
8. **MPP**: whether to track a Lightning method in `tempoxyz/mpp-specs`
   (not reviewed for this note).

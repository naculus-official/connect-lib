# x402 / MPP service discovery and MCP tools

Status: **design only, nothing implemented.** Date: 2026-09-27. Naculus
pays HTTP 402 challenges today (`createX402Fetch`,
`packages/payments-x402/src/fetch.ts`; `createMppFetch`,
`packages/payments-mpp/src/fetch.ts`). It has no discovery client and no
MCP code: `grep -rli "modelcontextprotocol\|bazaar" packages` finds only a
test fixture in `payments-x402/src/x402.test.ts` that checks
`extensions.bazaar` is echoed unchanged.

## Pinned sources

| Source | Where | Pinned at |
|---|---|---|
| x402 Bazaar extension | `https://github.com/x402-foundation/x402/blob/02e80f38e015ac0dc522a4285f41bf93d90b102f/specs/extensions/bazaar.md` | file last changed `e187dda`, 2026-08-31; repository head `02e80f3`, 2026-09-27 |
| x402 MCP transport | same repository, `specs/transports-v2/mcp.md` | file last changed `7c3d63e`, 2026-08-03 |
| Bazaar user docs (endpoints, CDP URL) | same repository, `docs/extensions/bazaar.mdx`, `docs/getting-started/quickstart-for-buyers.mdx` §4 | `02e80f3` |
| x402 reference MCP client | same repository, `typescript/packages/mcp/src/client/x402MCPClient.ts` (`@x402/mcp` 2.27.0) | `02e80f3` |
| x402 reference Bazaar client | same repository, `typescript/packages/extensions/src/bazaar/facilitatorClient.ts` (`withBazaar`) | `02e80f3` |
| MPP discovery | `https://github.com/tempoxyz/mpp-specs/blob/fe0d414f3d71469d5784a2ce973aa7269ee0c8b7/specs/extensions/draft-payment-discovery-01.md` | file last changed `ccab885`, 2026-08-25; head `fe0d414`, 2026-09-26 |
| MPP MCP transport | same repository, `specs/extensions/transports/draft-payment-transport-mcp-00.md` | `ccab885`, 2026-08-25 |

`coinbase/x402` now points to `x402-foundation/x402` as canonical (README,
`dd927a2`, 2026-04-21); see `docs/design/lightning-x402.md` §Pinned sources.

## How discovery works today

### x402: Bazaar (facilitator-hosted catalog)

1. **Declaration.** A resource server adds `extensions.bazaar` to its
   `PaymentRequired`: `info.input` (discriminated by `type`: `"http"` with
   `method`, query/body examples; or `"mcp"` with `toolName`,
   `inputSchema`, optional `transport` `"streamable-http"`/`"sse"`),
   optional `info.output`, and a JSON Schema (`schema`, Draft 2020-12, only
   same-document `$ref`) that validates `info`. Optional service metadata
   sits on `resource`: `serviceName`, `tags`, `iconUrl`, with soft-drop
   validation rules (bazaar.md §Service Metadata). Dynamic routes add
   `routeTemplate`.
2. **Cataloging happens on payment.** Clients "are expected to echo the
   `bazaar` extension from `PaymentRequired` into their `PaymentPayload`.
   If the extension is omitted, discovery cataloging will not occur"
   (bazaar.md §Client Behavior). The facilitator validates `info` against
   `schema` and indexes it; outcome goes to the resource server in the
   `EXTENSION-RESPONSES` side-channel header, never to the buyer.
3. **Query.** A Bazaar-enabled facilitator *may* expose
   `GET /discovery/resources` (filters `type`, `payTo`, `scheme`, `network`,
   `extensions`, `limit`, `offset`) and `GET /discovery/search?query=…`
   (natural-language; `limit`/`cursor` advisory). Each item carries
   `resource`, `type` (`http`/`mcp`), `accepts[]`, `extensions`,
   `lastUpdated`, `x402Version` (docs/extensions/bazaar.mdx §Response
   Schema). The docs name
   `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources`
   (Coinbase CDP) and `https://facilitator.payai.network/discovery/resources`
   as examples. The catalog is per facilitator; there is no global
   registry and no signature on catalog entries.
4. MCP tools are identified by the tuple (`resource.url`,
   `input.toolName`).

**Naculus already does step 2 on the client side**: both EVM and Solana
payload builders copy `required.extensions` unchanged into the payload
(`packages/payments-x402/src/evm-exact.ts:204`, `svm-exact.ts`), and the
parser keeps extensions as an object (`wire.ts:187`).

### x402: paying an MCP tool

From `specs/transports-v2/mcp.md`:

- The server answers `tools/call` without payment with a **tool result**
  (`isError: true`) whose `structuredContent` is the `PaymentRequired`
  object and whose `content[0].text` is the same JSON as a string. There is
  no HTTP 402 and no `PAYMENT-REQUIRED` header — also when MCP runs over
  HTTP.
- The client retries `tools/call` with the `PaymentPayload` in
  `params._meta["x402/payment"]`.
- Settlement arrives in `result._meta["x402/payment-response"]`; failure is
  again an `isError` result.
- `resource.url` may be a non-HTTP URI (the spec's example is
  `mcp://tool/financial_analysis`).

The reference client `x402MCPClient` wraps the MCP SDK `Client`; its
`callTool` pays automatically with `autoPayment` defaulting to `true` and
`onPaymentRequested` defaulting to `() => true` (`x402MCPClient.ts:285-286`).

For `lnbtc`, the MCP request binding profile `mcp:1` must be used for tool
calls (`scheme_exact_lnbtc.md` §Request Binding); see
`docs/design/lightning-x402.md`.

### MPP

- **Discovery** is service-published, not facilitator-hosted: a service
  publishes `GET /openapi.json` (OpenAPI 3.x) with top-level
  `x-service-info` (categories, docs links incl. `llms`) and per-operation
  `x-payment-info` (offers: intent, method, amount, currency) plus a
  declared `402` response (`draft-payment-discovery-01.md`). The draft says
  discovery improves client experience but the 402 challenge stays
  authoritative.
- **MCP transport**: payment required is a JSON-RPC **error** `-32042`
  with `error.data.challenges[]` (challenges as native JSON, not base64url);
  the credential goes in `_meta["org.paymentauth/credential"]`; the receipt
  in `_meta["org.paymentauth/receipt"]`; servers may advertise support under
  `capabilities.experimental.payment`
  (`draft-payment-transport-mcp-00.md`).

## What a Naculus integration would be

Two separable pieces.

### A. Client-side discovery (read-only)

A small, dependency-free client **(proposal)**:

```ts
interface DiscoveryQuery { type?: "http" | "mcp"; network?: string; scheme?: string; payTo?: string; limit?: number; offset?: number }
function createBazaarClient(options: { facilitatorUrl: string; fetch?: typeof fetch }): {
  list(query?: DiscoveryQuery): Promise<DiscoveredResource[]>;
  search(query: string, filters?: DiscoveryQuery): Promise<DiscoveredResource[]>;
};
function discoverOpenApi(origin: string): Promise<DiscoveredResource[]>; // MPP x-payment-info
```

Rules:

- Catalog data is **untrusted and advisory**. Nothing from a catalog entry
  is ever used to sign: the price, payee and network that count are the
  ones in the live 402 / tool result, checked against the session-key
  policy exactly as today. A catalog entry can only narrow what the client
  chooses to call.
- `accepts[]` entries are parsed with the same fail-closed validators
  (`unsupportedReason`, `svmUnsupportedReason`) so a caller can filter
  "resources this key could pay" — e.g. matching a session key's
  `tokenAllowances`, `allowedChainIds` and `allowedRecipients` — without
  contacting the resource.
- Free-text fields (`description`, `serviceName`, `tags`, tool
  descriptions, `inputSchema`) are displayed or handed to an agent as data.
  They are the prompt-injection surface for agents that pick tools from the
  catalog **(inferred)**; the SDK should not concatenate them into
  instructions.
- No JSON Schema `$ref` resolution, no fetching of `iconUrl` by the SDK.

### B. Paying the discovered resource

- **HTTP resources**: no new code. The discovered `resource` is an
  ordinary URL; the app calls it through the existing `createX402Fetch` /
  `createMppFetch`, which already enforce same-origin challenge, no redirect,
  one payment, and the policy.
- **MCP tools**: `createX402Fetch` / `createMppFetch` **cannot be reused
  as-is**. The challenge is inside a JSON-RPC result or error, not an HTTP
  402 header, and x402's `resource.url` may be `mcp://…`, which the HTTP
  same-origin check (`fetch.ts:112`) would refuse. What can be reused is
  everything below the transport:
  - x402: `selectRequirement`, `createPaymentPayload` (EVM, EIP-3009),
    `createSvmPaymentPayload` (Solana, wallet or session key) — all
    exported from `@naculus/payments-x402` and independent of HTTP.
  - MPP: `selectCharge`, `createChargeCredential`,
    `createSolanaChargeCredential`.
  - Parsing: `parsePaymentRequired` takes a base64 **header string**
    (`wire.ts:152`) and MPP's `parsePaymentChallenges` an
    `WWW-Authenticate` string; an MCP adapter needs object-input entry
    points over the same validators (a small, additive export change).

  Proposed shape: a wrapper around an MCP client's `callTool` that
  detects the payment signal, runs the same selection/`approve`/signing
  path, retries once with the `_meta` key, and returns the result plus the
  parsed receipt — a `payToolCall(client, request, options)` function
  rather than a subclass of any MCP SDK class.

  MCP-specific checks **(proposal)**, replacing the HTTP origin rule:
  - the challenge must come from the MCP server the client connected to
    (the transport, not a field in the challenge, identifies it);
  - `input.toolName` from discovery, if used, must equal the called tool;
  - exactly one paid retry per `callTool`; a second payment signal is an
    error;
  - no auto-pay default: unlike `x402MCPClient`, payment requires a
    configured signer/session key and honors `approve`.

## Options

| | Discovery | MCP payment |
|---|---|---|
| **1. Nothing new** | Apps call Bazaar themselves | Apps use `@x402/mcp` with their own signer; Naculus session keys plug in only if the app adapts `signTypedData` |
| **2. Discovery only** | `createBazaarClient` + OpenAPI reader in `payments-x402` / `payments-mpp` | none |
| **3. MCP payment only** | none | `payToolCall` for x402 and MPP over an injected MCP client |
| **4. Both (recommended)** | as 2 | as 3 |
| **5. Depend on `@x402/mcp` / `@x402/extensions`** | use `withBazaar` | wrap `x402MCPClient` |

Option 5 brings the reference SDK's scheme registry and its own signing
path into Naculus's dependency tree, and its defaults auto-pay; it would
also sit beside, not under, the session-key policy engine. Options 2–4
keep one signing path.

## Recommendation

Option 4, in this order:

1. Object-input parsers for x402 `PaymentRequired` and MPP challenges
   (additive exports), with tests reusing the existing fixtures.
2. `payToolCall` for x402 over MCP (EVM and Solana), then MPP
   (`-32042`, `org.paymentauth/*`). MCP client injected by the caller — no
   dependency on `@modelcontextprotocol/sdk` (peer at most).
3. `createBazaarClient` (list/search) and an MPP `openapi.json` reader,
   returning validated, typed entries and a `payableBy(policy)` filter.
4. No change to the signing path, `SessionKeyManager`, or the HTTP
   wrappers.

## Decisions the maintainer must make

1. **Scope**: discovery, MCP payment, or both (options table).
2. **Package home**: inside `payments-x402` / `payments-mpp`, or a new
   `@naculus/payments-mcp` (npm bootstrap needed for a new package).
3. **MCP SDK dependency**: none (caller passes a `callTool`-shaped
   function), optional peer `@modelcontextprotocol/sdk`, or hard
   dependency.
4. **Default facilitator URL**: ship none (caller must configure), or
   default to CDP's discovery URL. Recommended: none — a default endpoint
   is a trust decision the app should make.
5. **Catalog → policy filter**: whether Naculus provides `payableBy(policy)`
   helpers, and whether agent-facing output strips free-text fields.
6. **MPP discovery**: implement the OpenAPI reader now, or wait until
   `draft-payment-discovery` leaves draft.
7. **Lightning over MCP**: whether `payToolCall` should accept the Lightning
   payer from `docs/design/lightning-x402.md` once that exists (it needs
   the `mcp:1` binding).

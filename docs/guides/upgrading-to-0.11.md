# Upgrading from 0.10 to 0.11

0.11.0 adds a Circle CCTP V2 bridge for native USDC and makes session-key
errors say why they were raised. Everything is additive except one change to
the text of session-key error messages; nothing changes if you match on
`error.code`.

Source: [CHANGELOG.md](../../CHANGELOG.md). The example below is an excerpt
from `docs/guides/examples/upgrading-cctp.ts`, which is typechecked with the
rest of the repository (`npx tsc --noEmit`).

## At a glance

| Change | Package | Required of you |
|---|---|---|
| Session-key error `message` ends with the specific reason | `connect-core` | only if you compare the full message text, see [below](#session-key-error-messages-end-with-the-reason-0110) |
| Circle CCTP V2 bridge: `CctpBridgeProvider`, `waitForCctpAttestation` | `connect-core` (`/cctp` entry) | opt-in |
| Sepolia's Circle USDC in the chain registry | `connect-core` | nothing |
| `validateAuthorization` refuses a grant `period` with `start: 0` | `connect-core` | nothing if `start` comes from chain time |

## Action needed

### Session-key error messages end with the reason (0.11.0)

**What changed.** A session-key error's `message` used to be only the generic
text for its code. It now ends with the specific reason the error was raised
with. For the EIP-7702 refusal shown in the
[0.10 guide](./upgrading-to-0.10.md#eip-7702-delegations-refuse-limits-they-cannot-express-0100):

```text
0.10: Session key signing input is invalid.
0.11: Session key signing input is invalid. Cannot express this scope as an EIP-7702 delegation: tokenMaxPerTx has no on-chain caveat yet.
```

`error.code` and `error.details` are unchanged. An error raised without a
string reason keeps the generic message.

**Who is affected.** Only code that compares the full `message` string of a
session-key error (`===`, a lookup table keyed by message, a snapshot test).
Code that matches on `error.code` is unaffected.

**What to do.** Match on `error.code`, and read `error.details` if you need
the reason as data. Treat `message` as display text.

**How the reason is cleaned.** The appended reason is safe to show:

- control characters (and line or paragraph separators) become spaces, and
  runs of whitespace collapse to one;
- it is capped at 200 code points, then `…` is appended;
- next release (CHANGELOG "Unreleased", not in 0.11.0): Unicode bidirectional
  control characters (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069)
  also become spaces.

`error.details` is never cleaned; it is what the error was raised with.

## Opt-in features

### Circle CCTP V2 bridge (0.11.0)

Move native USDC between chains: CCTP burns it on the source chain and Circle
mints native USDC on the destination, with no wrapped token. Design:
[cctp-bridge.md](../design/cctp-bridge.md).

**Import path.** `@naculus/connect-core/cctp` is a separate entry, so apps
that do not bridge never load it. The root `@naculus/connect-core` entry does
not export the bridge.

**What `CctpBridgeProvider` returns.** `estimate` quotes the fee from Circle's
API and returns two route steps on the source chain, built but never signed
or sent:

1. USDC `approve` of TokenMessengerV2 for exactly the burn amount (never
   unlimited);
2. `depositForBurnWithHook` with Circle's Forwarding Service hook, so Circle
   submits the destination mint and the recipient needs no gas on the
   destination chain.

`amount` is what is burned; the recipient receives at least `outputAmount`
(`amount` minus the maximum fee). Run the steps with your wallet or an
`EVMRouteExecutor`.

**Attestation.** `waitForCctpAttestation` polls Circle's attestation API until
the burn is attested. It is bounded: every request and the whole wait end at
`timeoutMs` (default 30 minutes), and it throws on timeout or a malformed
response rather than return a partial result.

**What is refused.** Only native USDC (`usdcVariant: "native"` in the chain
registry) between chains with a CCTP domain. A different token, bridged USDC,
a chain without a domain, the same chain on both sides, or a testnet–mainnet
mix is refused; the error code is `no_routes_available` and the message
starts with `CCTP:`.

```ts
  const cctp = new CctpBridgeProvider(); // forwarding + fast transfer
  const quote = await cctp.estimate({
    amount,
    fromChain: { chainId: 11155111 },
    toChain: { chainId: 84532 },
    fromToken: usdc(11155111),
    toToken: usdc(84532),
    recipient,
  });
  // Two steps: approve(exact amount), then depositForBurnWithHook.
  let burnTx = "";
  for (const step of quote.steps) {
    if (step.transaction) burnTx = await send(step.transaction);
  }
  // Bounded (30 minutes by default): throws on timeout, never a partial result.
  await waitForCctpAttestation({ sourceChainId: 11155111, txHash: burnTx });
  return quote.outputAmount; // at least this much is minted to `recipient`
```

`new CctpBridgeProvider({ transfer: "standard" })` waits for hard finality
instead of Fast Transfer; `forward: false` builds a plain `depositForBurn`,
and you then submit the destination mint yourself with
`encodeCctpReceiveMessage`, paying gas there.

## Fixes

- `validateAuthorization` refuses a grant `period` with `start: 0`
  (`invalid grant period`), which the on-chain period enforcers refuse. This
  was listed as "not yet released" in the
  [0.10 guide](./upgrading-to-0.10.md#not-yet-released-period-start-must-be-greater-than-zero);
  it shipped in 0.11.0.

## Nothing else to change

Packages other than `@naculus/connect-core` (and the `@naculus/connect`
umbrella that re-exports it) are a version bump only.

## Other guides

- [Upgrading from 0.7 to 0.10](./upgrading-to-0.10.md)
- [Paying x402 from an external wallet](./x402-external-wallet.md)
- [Charging with x402 on your server](./x402-server.md)
- [Periodic authorization](./periodic-authorization.md)

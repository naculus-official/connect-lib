# Transaction simulation

Simulation answers "what will this transaction actually do" before the user
signs. `SimulationManager` picks a provider, runs the simulation, and returns a
`SimulationResult`.

**With the built-in provider, that result is narrower than its shape suggests.**
`SimulationResult` carries `balanceChanges`, `approvalChanges` and a
`riskAssessment` because a richer provider can fill them. `eth_call` cannot: it
executes the call and reports whether it reverts, so those arrays come back
empty and `riskAssessment.level` is `"unknown"`. Populating them needs
state-diff tracing (`debug_traceCall` and friends, which most public RPC
endpoints do not expose) or a third-party service.

This matters for the UI. A panel that renders "no balance changes, risk:
unknown" reads to a user as *this transaction is safe*, when it means *nothing
was analyzed*. Show the revert result, which is real, and say plainly that
token movement was not inspected — do not present an empty array as a finding.

## Providers

| Provider | Cost | What it can tell you |
|---|---|---|
| `eth_call` | free — uses the consumer's own RPC | whether the transaction reverts, and why |
| *(your own)* | yours | whatever you register |

`eth_call` is always registered and is the only built-in provider. It needs no
third-party account, no API key, and sends nothing off the consumer's own
infrastructure.

### Why there is no bundled third-party provider

A `BlowfishProvider` used to ship here. It was removed rather than repaired:

- **The vendor's domain registration had lapsed.** Shipping a hard dependency
  on an endpoint that may no longer exist is worse than shipping nothing.
- It never worked. The request path was pinned to `solana/mainnet` while the
  provider advertised ten EVM chains; the chain the caller was on never
  reached it, because `SimulationManager` did not pass `chainId` and the
  provider derived the chain from the dApp origin through a helper that
  ignored its argument and always answered Ethereum. Every simulation on every
  chain therefore hit the wrong endpoint, the manager fell back to `eth_call`,
  and the warning blamed the vendor's servers — so a consumer paying for scam
  detection silently got basic revert checking and no way to find out why.
- It was ~500 lines of bundle weight for a paid dependency in an SDK whose
  reason for existing is to avoid exactly that.

Registering a scam-detection service is a product decision with a recurring
cost and a privacy consequence — the provider receives the contents of
unsigned transactions. It belongs to the consumer, not to the SDK default.

## Registering your own provider

```ts
import { SimulationManager } from "@naculus/connect-core";
import type { SimulationProvider } from "@naculus/connect-core";

const myProvider: SimulationProvider = {
  name: "tenderly",
  supportedChains: [1, 137],
  isAvailable: (chainId) => [1, 137].includes(chainId),
  async simulate(tx, from, options) {
    // options.chainId is the chain the transaction targets.
    // Do not infer it from options.origin: the origin identifies the site,
    // not the network, and one URL may serve several chains.
    ...
  },
};

const manager = new SimulationManager({ rpcUrl });
manager.registerProvider("tenderly", myProvider);
```

In `auto` mode the manager prefers any registered provider that supports the
chain and falls back to `eth_call`. When a provider reports `unavailable`, the
fallback runs and its warnings are preserved in `riskAssessment.warnings`, so
the caller can tell a degraded result from a clean one.

## Decimals

`AssetChange.tokenDecimals` is `number | undefined`. It is deliberately not
defaulted to 18: assuming 18 for a 6-decimal token renders 1000 USDC as
0.000000001, which understates an outflow by 10^12 in exactly the screen a
user relies on to catch a drain. When the source does not report decimals,
show the raw amount and say the precision is unknown.

The same rule holds throughout the SDK. Decimals have three legitimate
sources — an on-chain `decimals()` call, a verified token list, or the
namespace constant for a native token. A hard-coded fallback is a fourth thing:
a guess.

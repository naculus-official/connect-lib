---
"@naculus/wallet-engine": patch
---

`simulateERC20Transfer` no longer fails whenever `decimals` is omitted.

Its decimals lookup read only the caller's `rpcUrl` argument, and nothing forwarded one — so the call threw "No RPC URL available for ERC-20 decimals lookup" even when the manager had been constructed with a perfectly good endpoint. The throw happened inside the method's own try, so it surfaced as `status: "unavailable"` with "Failed to prepare simulation" rather than as an error: a UI showed no preview and the user signed with nothing to check.

Verified by running it against a stubbed RPC before the fix; the default path failed every time.

`_erc20StaticCall` now falls back to the endpoint the manager was configured with — `EthCallProvider` exposes a readonly `rpcUrl` for that — and `simulateERC20Transfer` takes an optional trailing `rpcUrl`, so the per-call override that `simulate` already honoured is reachable from the ERC-20 path too.

A test asserting the old behaviour has been rewritten: it built a manager with an endpoint and asserted the lookup would refuse to use it, which encoded the bug as the specification.

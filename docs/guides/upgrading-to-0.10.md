# Upgrading from 0.7 to 0.10

0.8.0, 0.8.1, 0.9.0 and 0.10.0 shipped within two days. This page lists what
changed and what, if anything, you have to do. Everything is additive except
one fix in 0.10.0 that refuses a scope it used to widen silently.

Source: [CHANGELOG.md](../../CHANGELOG.md). The examples below are excerpts
from `docs/guides/examples/upgrading-*.ts`, which are typechecked with the rest
of the repository (`npx tsc --noEmit`).

## At a glance

### 0.8.0

| Change | Package | Required of you |
|---|---|---|
| Authorization model: `validateAuthorization`, `evaluateSpend`, `compileEvmSessionScope` / `compileSolanaSessionScope` / `compileMppSession` | `connect-core` | opt-in |
| `listAuthorizations` and `revokeListedAuthorization` | `connect-core` | opt-in |
| `SessionKeyScope` gains `tokenMaxPerTx` and `nativeTransfer` (optional, off by default) | `connect-core` | nothing |
| x402 and MPP fetch results gain `settlementBinding` | `payments-x402`, `payments-mpp` | nothing |
| Settlement verification: `verifyX402Settlement`, `verifyMppSettlement` | `connect-core`, `payments-x402`, `payments-mpp` | opt-in |

### 0.8.1

| Change | Package | Required of you |
|---|---|---|
| `SessionKeyInfo` can expose persisted EVM usage, so `listAuthorizations` reports EVM spend | `connect-core` | nothing |

### 0.9.0

| Change | Package | Required of you |
|---|---|---|
| `walletX402Signer`: pay x402 from an EIP-1193 wallet | `payments-x402` | opt-in |
| Switching to a chain the injected wallet lacks adds it (Base Sepolia included) | `connect-core`, `connector-evm-injected` | nothing |
| Unknown-chain errors keep their specific message (code still `chain_unsupported`) | `connect-core` | only if you match on the message text, see [below](#chain_unsupported-messages-are-specific-090) |

### 0.10.0

| Change | Package | Required of you |
|---|---|---|
| Periodic limits (`period` on a grant), enforced by the device | `connect-core` | opt-in |
| Periodic limits on chain (`mode: "eip7702"`, `requireOnChain`) | `connect-core` | opt-in |
| `buildDelegation` refuses limits an EIP-7702 delegation cannot express | `connect-core` | **action needed** for hand-built `eip7702` scopes, see [below](#eip-7702-delegations-refuse-limits-they-cannot-express-0100) |

## Action needed

### EIP-7702 delegations refuse limits they cannot express (0.10.0)

**What changed.** Since 0.8.0, `buildDelegation` silently ignored
`tokenMaxPerTx`, so the on-chain delegation had no per-transaction cap. It now
refuses, with `session_key_invalid_input`, a scope with `mode: "eip7702"` that
has:

- `tokenMaxPerTx` (no on-chain caveat for it yet) — the only newly refused
  field; before 0.10.0 it was dropped silently;
- a `periodLimits` entry for a token other than the single token allowance
  (periods are new in 0.10.0).

More than one entry in `tokenAllowances` was already refused before 0.10.0;
that is unchanged.

**Who is affected.** Only code that builds an `eip7702` `SessionKeyScope` by
hand and sets one of those. Scopes from the authorization compiler are not
affected: `compileEvmSessionScope` emits `tokenMaxPerTx` only for `offchain`
scopes, and in `mode: "eip7702"` refuses a per-payment cap the chain cannot
hold instead of emitting one. `offchain` scopes are unchanged and still enforce
`tokenMaxPerTx` on the device.

**What to do.** Either drop `tokenMaxPerTx` from the `eip7702` scope (the
token allowance, and a period limit if you set one, still bound it on chain;
see [when a per-payment cap is accepted on chain](./periodic-authorization.md#when-a-per-payment-cap-is-accepted-on-chain)),
or use `mode: "offchain"` if you need the per-transaction cap enforced, which
the device then does.

**How to detect it.** `createSessionKey` still accepts the scope; the refusal
comes from `SessionKeyManager.prepareDelegation` (or a direct
`buildDelegation` call). The error is a `WalletError` whose `code` is
`session_key_invalid_input`. Its `message` is the generic
"Session key signing input is invalid."; the specific reason is in
`error.details`, starting with
`Cannot express this scope as an EIP-7702 delegation:`, e.g.
`tokenMaxPerTx has no on-chain caveat yet`.

```ts
  try {
    return await keys.prepareDelegation(keyId, chainId);
  } catch (error) {
    // `WalletError.code` is typed without the session-key codes, hence the
    // widening to string.
    if (
      isWalletError(error) &&
      (error.code as string) === "session_key_invalid_input"
    ) {
      console.warn(error.details);
    }
    throw error;
  }
```

### `chain_unsupported` messages are specific (0.9.0)

Only if your code compares the **message** of a `chain_unsupported` error
from a session chain switch: it now carries the specific, chain-naming reason
instead of the generic text. The `code` is unchanged; match on `code`.

### Not yet released: period `start` must be greater than zero

On `dev` after 0.10.0 (CHANGELOG "Unreleased"): `validateAuthorization` refuses
a grant `period` with `start: 0` (`invalid grant period`), because the on-chain
period enforcers refuse it. Take `start` from chain time, as below, and it is
always positive.

## Opt-in features

### Authorization model (0.8.0, 0.8.1)

Declare once what a delegate may spend, validate it fail-closed, preview a
payment, compile it to an existing enforcer, then list and revoke across
managers. Design: [authorization-model.md](../design/authorization-model.md).

```ts
  const checked = validateAuthorization(authorization); // fail-closed
  if (!checked.ok) throw new Error(checked.reason);
  // Preview a payment with the same verdict the enforcer gives.
  const verdict = evaluateSpend(checked.authorization, {
    asset: ASSET,
    recipient: MERCHANT,
    amount: 5_000_000n,
    rail: "transfer",
    at: now,
    spentSoFar: 0n,
    countSoFar: 0,
  }); // { allow: true, grant: 0 }
  // Compile to the existing EVM session-key enforcer (refuses, never widens).
  const compiled = compileEvmSessionScope(checked.authorization, 8453);
  if (!compiled.ok) throw new Error(compiled.reason);
  const key = await keys.createSessionKey(compiled.scope, OWNER);
```

`compileSolanaSessionScope` and `compileMppSession` do the same for Solana
session keys and MPP sessions. `listAuthorizations` reads the managers you pass
(`evm`, `solana`, `mppVoucher`) into one view; legacy unrestricted-recipient
EVM keys and scopes outside the model are flagged, not hidden.
`revokeListedAuthorization` routes to the owning manager and reports
`onChainRevocationRequired: true` for Solana delegates, which still need an
owner-signed on-chain revocation; it never signs or broadcasts.

```ts
  for (const entry of await listAuthorizations({ evm: keys })) {
    if (entry.status !== "active") continue;
    if (!entry.grants.some((g) => g.recipients?.includes(recipient))) continue;
    const { onChainRevocationRequired } = await revokeListedAuthorization(
      { evm: keys },
      entry,
    );
    // true only for Solana delegates: the owner must still sign a revocation.
    if (onChainRevocationRequired) console.warn(entry.keyId);
  }
```

### Settlement verification (0.8.0)

Fetch is unchanged and never verifies. To check a receipt on chain, pass the
fetch result and an RPC endpoint to `verifyX402Settlement` or
`verifyMppSettlement`; they compare it with `settlementBinding`, what the
client signed. Design: [receipt-verification.md](../design/receipt-verification.md).

```ts
export async function isSettled(
  result: X402FetchResult | MppFetchResult,
  rpc: SettlementRpc, // a JSON-RPC endpoint for the chain that settled
): Promise<boolean> {
  const verification =
    "settlement" in result
      ? await verifyX402Settlement(result, rpc)
      : await verifyMppSettlement(result, rpc);
  // "pending" may be retried later; "failed", "mismatch" and "unavailable"
  // are not proof of payment.
  return verification.status === "verified";
}
```

A full `SettlementRpc` over `fetch` is in
[x402-external-wallet.md](./x402-external-wallet.md).

### `walletX402Signer` (0.9.0)

Pay x402 from MetaMask, Coinbase Wallet, Rabby, OKX or Phantom. The signer
switches to the typed-data chain, maps wallet rejection, and recovers the
signature against the requested account before paying; smart-contract wallet
signatures are not supported. Full walkthrough:
[x402-external-wallet.md](./x402-external-wallet.md); design:
[x402-external-wallet.md](../design/x402-external-wallet.md).

```ts
  const session = await connector.connect(wallet.id);
  const signer = walletX402Signer({
    provider: wallet.provider,
    address,
    // Since 0.9.0 this adds the chain (e.g. Base Sepolia) if the wallet lacks it.
    switchChain: (chainId) => connector.switchChain(session, chainId),
  });
  const pay = createX402Fetch({ signer, networks: ["eip155:84532"] });
  return pay("https://api.example.com/report");
```

### Periodic limits (0.10.0)

A grant takes an optional `period` (`amount` per fixed window of `seconds` from
`start`; unused amount is forfeited), on top of the per-payment, total and
count limits. The default EVM compile and Solana session keys enforce it on
the device (`enforcement: "device"`). `mode: "eip7702"` compiles it to a
period-transfer caveat (`enforcement: "on-chain"`), and `requireOnChain: true`
refuses any target that would only be device-enforced. Set `start` from chain
time, not the device clock. Full guide:
[periodic-authorization.md](./periodic-authorization.md); design:
[periodic-authorization.md](../design/periodic-authorization.md).

```ts
  // start from chain time (latest block), never Date.now(); it must be > 0.
  const start = Number((await client.getBlock()).timestamp);
  // ... grant with period: { amount: 10_000_000n, seconds: 30 * DAY, start },
  //     maxPerPayment equal to period.amount ...
  // User present: device enforcement ("device"). User away: the chain must
  // enforce it ("on-chain"); requireOnChain refuses anything device-only.
  return userAway
    ? compileEvmSessionScope(authorization, baseSepolia.id, {
        mode: "eip7702",
        requireOnChain: true,
      })
    : compileEvmSessionScope(authorization, baseSepolia.id);
```

## Chains (0.9.0)

- With `@naculus/connector-evm-injected`, switching to a chain the wallet has
  not added now adds it with `wallet_addEthereumChain`. The parameters come
  from the core chain registry, which includes Base Sepolia (the x402/MPP
  testnet) and add-chain metadata for Ethereum, Sepolia, Base, Arbitrum,
  Optimism and Polygon.
- Unknown-chain errors from the session switch keep their specific,
  chain-naming message; the code stays `chain_unsupported`.

## Other guides

- [Paying x402 from an external wallet](./x402-external-wallet.md)
- [Charging with x402 on your server](./x402-server.md)
- [Periodic authorization](./periodic-authorization.md)

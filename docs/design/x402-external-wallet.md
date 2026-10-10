# Paying x402 with an external wallet

Status: **approved 2026-10-04** — decision 1 accepted; decision 2 (a): refuse smart-contract wallet signatures for now with a clear error; decision 3 accepted. Prototype validated with five real wallets on Sepolia. Binding rules
from [authorization-boundary.md](./authorization-boundary.md) and
[authorization-model.md](./authorization-model.md) apply: signing bytes are
built by audited code, never by the caller; failures are fail-closed.

## Problem

`createX402Fetch` pays an x402 `exact` (EIP-3009) challenge only through an
`X402TypedDataSigner`, and the only shipped signer is
`sessionKeyX402Signer` (an embedded session key). An app whose user has
MetaMask, Rabby, OKX or Coinbase Wallet must hand-write a signer against the
raw EIP-1193 provider. The real-wallet matrix (2026-10-04) showed what that
hand-written code gets wrong:

- every tested wallet refuses EIP-712 data whose `domain.chainId` differs
  from the active chain (MetaMask: -32603 "must match the active chainId"), so
  the signer must switch chain first — and the switch may need
  `wallet_addEthereumChain` (fixed in a155ac8);
- the session advertises `eth_signTypedData_v4`, but no public API exposes it.

Smart-contract wallets add a second gap: `createPaymentPayload` accepts only a
65-byte ECDSA signature, so ERC-1271 / ERC-6492 signatures are rejected.

## Proposal

### 1. `walletX402Signer` (payments-x402)

```ts
interface Eip1193Like {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function walletX402Signer(options: {
  provider: Eip1193Like;
  address: `0x${string}`;
  /** Switch the wallet to `eip155:<id>`; the connector's switchChain (adds the chain when needed). */
  switchChain: (caip2: string) => Promise<void>;
}): X402TypedDataSigner;
```

`signTypedData(typedData)`:

1. reads the chain from `typedData.domain.chainId` (built by
   `buildTransferAuthorization` from the requirement — never from the caller);
2. asks `eth_chainId`; if different, calls `switchChain`, then re-reads
   `eth_chainId` and refuses if it still differs;
3. calls `eth_signTypedData_v4` with `[address, JSON.stringify(typedData)]`,
   adding the EIP-712 `types` (`EIP712Domain`, `TransferWithAuthorization`) —
   the request from `buildTransferAuthorization` carries none;
4. **recovers the signer** from the returned signature and refuses unless it
   equals `address` — a wallet that signed with another account, or a
   different payload, fails here, before anything is sent;
5. maps 4001 to `X402Error("user_rejected")` with no retry.

It depends only on an EIP-1193-shaped object and a switch function, not on
connector identity (dependency direction: payments-x402 → core).

### 2. appkit

- `useX402Signer()` (React) / `useX402Signer()` (Vue): thin shells that build
  `walletX402Signer` from the active EIP-6963 / WalletConnect session's provider
  and `useSwitchChain`; `usePaymentFetch` accepts it like any signer.
- Consent: the wallet's own typed-data prompt is the signing consent. Before
  it, the app may show `explainSpend` / `PaymentPreview` for the same amount
  and payee (already shipped).

### 3. Smart-contract wallets (decision 2)

USDC FiatToken v2.2 accepts a `bytes` signature (checked 2026-10-04: the Base
USDC implementation `0x2ce6…d779` has the
`transferWithAuthorization(…, bytes)` selector; other chains to be checked) in `transferWithAuthorization` and validates ERC-1271 for contract
holders. Allowing them means: accept non-65-byte signatures in
`createPaymentPayload` when the payer address has code (or a 6492 wrapper),
and verify in `verifyEip3009Settlement` via the token, not ecrecover. The
facilitator must support it too; most only do ECDSA today.

## Boundary

- No change to `sessionKeyX402Signer`, to `buildTransferAuthorization`, or to
  any session-key enforcement.
- The typed data is built only by `buildTransferAuthorization`; the new
  signer never accepts caller-built typed data from outside `createX402Fetch`.
- No new dependencies. Signature recovery comes from a `@naculus/connect-core`
  export (core already depends on `@noble/curves`); payments-x402 must not
  import `@noble/*` itself — that would be a phantom dependency the tester
  gate rejects.
- No automatic retry after a rejection or chain mismatch.

## Tests

- Unit (mock provider): chain switch before signing; refusal when the chain
  does not change; refusal when the recovered address differs; 4001 mapping.
- Real wallets: MetaMask, Rabby, OKX, Coinbase pay a
  local x402 server on Base Sepolia with Circle test USDC; the server's
  settlement is checked with `verifyEip3009Settlement`. Needs the test account
  funded with Base Sepolia ETH (gas for the facilitator only) and test USDC.

## Decisions to approve

1. **Add `walletX402Signer` + `useX402Signer`** as above (EOA wallets).
   Recommended.
2. **Smart-contract wallet signatures**: (a) refuse for now with a clear error
   (recommended until a facilitator we use verifies ERC-1271), or (b) accept
   and verify via the token.
3. Release as connect-lib/appkit minor, after the real-wallet payment run passes.

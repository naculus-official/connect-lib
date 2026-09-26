# @naculus/payments-mpp

Pay [MPP](https://mpp.dev) (Machine Payments Protocol) `evm` charges with a
policy-bound Naculus session key.

```ts
import { SessionKeyManager } from "@naculus/connect-core";
import { createMppFetch, sessionKeyMppSigner } from "@naculus/payments-mpp";

const signer = await sessionKeyMppSigner(manager, sessionId);
const pay = createMppFetch({ signer, chainIds: [8453] });

const { response, paid, receipt } = await pay("https://api.example.com/data");
```

What it does on a `402` with `WWW-Authenticate: Payment` challenges:

1. Parses every challenge (RFC 9110 auth-params; several may share one
   header) and refuses one that arrived through a redirect. The paid retry
   never follows a redirect.
2. Picks the first challenge it can pay: `method="evm"`, `intent="charge"`,
   `credentialTypes` including `"authorization"`, no `splits`, not expired,
   on an allowed chain (`chainIds`), for a token whose EIP-712 domain it
   knows. Every other method, intent and credential type (`permit2`,
   `transaction`, `hash`) is refused.
3. Builds the EIP-3009 `TransferWithAuthorization` the spec prescribes —
   `nonce = keccak256(id ‖ realm)`, `validAfter = 0`, `validBefore` = the
   challenge's `expires` (or now + 300 s) — and has the session key sign it.
   **Policy is enforced by the session key, not here**: give it
   `allowedRecipients` (payees), `tokenAllowances` (budget per token) and
   `allowedChainIds`. **Without `allowedRecipients` the key pays whatever
   `recipient` the server names**, up to the token budget.
4. Retries once with `Authorization: Payment …` (or `Payment-Authorization`
   when the challenge selects it). A second `402` is an error, not a second
   payment. A malformed `Payment-Receipt`, or one naming another challenge,
   leaves the paid response intact with `receipt: null`.

## Token domains

MPP challenges do not carry the token's EIP-712 name and version.
`USDC_DOMAINS` covers Circle USDC on Ethereum, Sepolia, Base, Base Sepolia,
Arbitrum One, Optimism and Polygon (each read from the token and checked
against its `DOMAIN_SEPARATOR()`). For another token, pass `tokenDomains`;
an entry there takes precedence over the built-in table.

Spec: tempoxyz/mpp-specs `draft-httpauth-payment-01`, `draft-evm-charge-00`.

## Solana charges

```ts
import { solanaPaymentRpc } from "@naculus/connect-core";

const pay = createMppFetch({
  signer, // optional: evm charges, paid by the session key
  solana: {
    signer: solanaRoles.signer,
    rpc: solanaPaymentRpc(rpcUrl),
    networks: ["mainnet"],
  },
});
```

`method="solana"` charges (pull mode, SPL tokens) are paid by the **connected
wallet**: one `TransferChecked` to the recipient's associated token account,
`externalId` as the memo. With `feePayer: true` the server's `feePayerKey`
pays the fee and co-signs; otherwise the payer pays it and signs alone. The
RPC must serve the challenge's cluster, and the mint must match the
challenge's `decimals` and `tokenProgram`. Native SOL, splits, push mode,
confidential transfers and `localnet` are refused. The blockhash always
comes from your RPC (the server's advisory `recentBlockhash` is ignored), and
the wallet's result is checked as for x402 — except that wallets adding
Lighthouse assertions (Phantom, Solflare) are refused, because MPP servers
reject such transactions.

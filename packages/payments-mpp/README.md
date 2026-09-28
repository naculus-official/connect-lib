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

A Solana session key (`solana: { sessionKey: { manager, id }, rpc }`, see the
payments-x402 README) pays `solana` charges without a prompt, within its
scope — and only charges whose fee the server sponsors (`feePayer: true`).

## Server: `@naculus/payments-mpp/server`

The other side of the same charges: issue challenges, verify credentials,
settle them and answer with a receipt or an RFC 9457 problem. The server's
keys are never held here — settlement goes through functions you pass in.

```ts
import {
  createChallenge,
  memoryReplayStore,
  paymentRequiredResponse,
  problemResponse,
  receiptHeaders,
  settleCredential,
  verifyCredential,
} from "@naculus/payments-mpp/server";

const offer = {
  method: "evm",
  request: {
    amount: "10000",
    currency: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    recipient: payee,
    methodDetails: { chainId: 8453, credentialTypes: ["authorization"] },
  },
};
const replay = memoryReplayStore(); // one process only; share it otherwise
const fresh = () => [
  createChallenge({
    realm: "api.example.com",
    intent: "charge",
    ...offer,
    expires: new Date(Date.now() + 5 * 60_000),
    secret,
  }),
];

async function handle(req: Request): Promise<Response> {
  const credential = req.headers.get("Authorization");
  if (!credential) return paymentRequiredResponse(fresh());
  try {
    const verified = await verifyCredential(credential, {
      secret,
      realm: "api.example.com",
      accept: [offer], // what this resource charges
      evm: { rpc }, // authorizationState + balanceOf
      replay,
    });
    const { header } = await settleCredential(verified, {
      replay,
      evm: { submit }, // sends transferWithAuthorization, awaits the receipt
    });
    return new Response(body, { headers: receiptHeaders(header) });
  } catch (error) {
    return problemResponse(error, fresh());
  }
}
```

- **Challenge ids** are HMAC-SHA256 over the bound parameters exactly as
  `draft-httpauth-payment-01` specifies (the spec's test vectors are
  reproduced in the tests); any edited parameter fails verification.
  `previousSecrets` keeps rotated secrets valid until their challenges
  expire.
- **`accept`** is required: a genuine challenge for a cheaper resource of the
  same server is refused.
- **EVM** (`type="authorization"`): `to`/`value` match the request, `nonce`
  is `keccak256(id ‖ realm)`, the validity window sits inside the challenge,
  the EIP-712 signature recovers to `from` (EOA signatures only), the token
  is in `USDC_DOMAINS` or `evm.tokenDomains`, and `rpc` reports the nonce
  unused and the balance sufficient.
- **Solana** (`type="transaction"`, pull mode, SPL; the request must name
  `tokenProgram`): the fee payer is the server's `feePayerKey` (slot empty)
  or the payer (fully signed); only ComputeBudget limit/price, one
  `TransferChecked` of exactly `amount`/`decimals` into the recipient's
  associated token account, and at most one memo (equal to `externalId` when
  there is one); a sponsored transaction never names the fee payer in an
  instruction and pays at most `solana.maxPriorityFeeLamports` (default
  10 000) in priority fees; the payer's signature verifies. Settlement calls
  `signAsFeePayer` (sponsored only), checks that only the fee payer's slot
  changed, simulates, sends and waits for confirmation through your `rpc`.
- **Replay**: settlement consumes the challenge id, and the EIP-3009 nonce or
  the Solana payer signature, before anything is sent. A shared store needs
  an atomic `consume`.

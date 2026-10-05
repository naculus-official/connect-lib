# Charging with x402 on your server

This guide shows how to put an HTTP resource behind an
[x402](https://github.com/coinbase/x402) v2 paywall with `requirePayment` and
`settlePayment` from `@naculus/payments-x402/server`, settling EIP-3009
(`exact` scheme) payments on an EVM chain yourself, with viem.

The code below is excerpted from
[examples/x402-server.ts](./examples/x402-server.ts), which is typechecked with
the rest of the repository (`npx tsc --noEmit`). The client side is in
[x402-external-wallet.md](./x402-external-wallet.md).

## How a paid request flows

1. A request arrives without `PAYMENT-SIGNATURE`. `requirePayment` answers
   with a `402` whose `PAYMENT-REQUIRED` header lists what you accept.
2. The client signs an EIP-3009 `TransferWithAuthorization` and retries with
   `PAYMENT-SIGNATURE`. `requirePayment` **verifies** it: signature, payee,
   amount, validity window, unused nonce, payer balance and a simulated
   transfer. Nothing has moved yet.
3. `settlePayment` **settles** it: it builds the `transferWithAuthorization`
   call and hands it to your `deps.submit`, which sends it from your
   facilitator account. The token moves from the payer to your `payTo`.
4. Only if the settlement succeeded do you serve the resource, with the
   settlement as the `PAYMENT-RESPONSE` header.

No private key is held by the library. Your facilitator key stays behind
`submit`; it pays gas (ETH), never receives the payment.

```sh
pnpm add @naculus/payments-x402 viem
```

## 1. Describe what you accept

```ts
const accepts: X402PaymentRequirements[] = [
  {
    scheme: "exact",
    network: "eip155:84532",
    amount: "10000", // atomic units; USDC has 6 decimals
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Circle test USDC
    payTo: "0x1111111111111111111111111111111111111111", // your address
    maxTimeoutSeconds: 120,
    // EIP-712 domain of the token, needed by the payer to sign.
    extra: { name: "USDC", version: "2" },
  },
];
```

- `network` is CAIP-2 (`eip155:<chain id>`), `amount` a decimal string in the
  token's smallest unit, `asset` the token contract.
- `extra.name` and `extra.version` are the token's EIP-712 domain and are
  required. Use the token's real values (read `name()` and `version()` on the
  contract, or the issuer's documentation); a wrong domain makes every
  signature fail verification.
- Every entry must be one this module can verify (`exact`, EIP-3009 on an
  EIP-155 chain, or SPL on a Solana cluster). Anything else throws when the
  challenge is built, rather than advertise a payment you would then refuse.

## 2. Wire the chain: `deps.rpc.evm.call` and `deps.submit`

```ts
const reader = createPublicClient({ chain: baseSepolia, transport: http() });

const facilitator = createWalletClient({
  account: privateKeyToAccount(process.env.FACILITATOR_KEY as Hex),
  chain: baseSepolia,
  transport: http(),
});

const deps: X402ServerDeps = {
  rpc: {
    evm: {
      async call({ chainId, to, data }) {
        if (chainId !== baseSepolia.id) throw new Error("Unsupported chain.");
        const result = await reader.call({ to, data });
        return result.data ?? "0x";
      },
    },
  },
  async submit({ chainId, to, data }) {
    if (chainId !== baseSepolia.id) throw new Error("Unsupported chain.");
    const hash = await facilitator.sendTransaction({ to, data });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("Settlement reverted.");
    return hash;
  },
};
```

The contract for each:

- **`rpc.evm.call({ chainId, to, data })`** is an `eth_call` at the latest
  block. Return the call's data; **reject when the call reverts** (viem's
  `call` does). Route by `chainId` to an RPC for that chain, and reject chains
  you do not serve. Verification uses it for the token's balance, the
  EIP-3009 nonce state and a simulated transfer.
- **`submit({ chainId, to, data })`** sends the settlement transaction from
  your facilitator account. **Resolve with the transaction hash only once the
  transaction has succeeded on chain**; throw on anything else (reverted,
  dropped, timed out). `settlePayment` reports `success: true` on that basis
  alone. Returning the hash as soon as it is broadcast would let you serve
  a payment that later reverts.

Other `deps`:

- `store`: the duplicate-settlement cache. The default is one in-memory store
  per process, which refuses the same payment twice within its TTL (at least
  120 s, longer for an authorization valid longer). **Running more than one
  instance? Pass a shared `X402SettlementStore`** (for example backed by
  Redis). Otherwise two instances can both try to settle the same payload:
  the chain lets only one transfer through, and the other burns gas on a
  reverted transaction.
- `now`: unix seconds, defaults to the system clock.
- Solana adds `rpc.solana`, `signAsFeePayer` and `confirmSolana`; see the
  [package README](../../packages/payments-x402/README.md#server-side-naculuspayments-x402server).

## 3. Gate, settle, serve

```ts
export async function handler(request: Request): Promise<Response> {
  const gate = await requirePayment(request, { accepts, deps });
  if (!gate.verified) return gate.response; // 402 + PAYMENT-REQUIRED, or 400

  // Verified is not paid. Settle first, then read `.success` on `settlement`,
  // never on the object settlePayment returns.
  const { settlement, header } = await settlePayment(gate.payment, deps);
  if (!settlement.success) {
    return new Response(
      JSON.stringify({ error: settlement.errorReason ?? "settlement failed" }),
      {
        status: 402,
        headers: {
          "content-type": "application/json",
          "PAYMENT-RESPONSE": header,
        },
      },
    );
  }
  return new Response(JSON.stringify({ report: "..." }), {
    headers: { "content-type": "application/json", "PAYMENT-RESPONSE": header },
  });
}
```

`requirePayment` works on a Fetch API `Request` (Node 18+, Deno, Bun,
Cloudflare Workers, Next.js route handlers, Hono). It returns either
`{ verified: false, response }`, the `402` (or `400` for a header that is not
base64 JSON) to send back as is, or `{ verified: true, payment }`.

`settlePayment` never throws. It returns `{ settlement, header }`:

- `settlement` is the x402 settlement response: `success`, `transaction` (the
  hash), `network`, `payer`, and on failure `errorReason`.
- `header` is `settlement`, encoded for the `PAYMENT-RESPONSE` header. Set it
  on the response either way; clients and `verifyX402Settlement` read it.

Serve the resource **only when `settlement.success` is `true`**.

### Pitfall: `.success` on the wrong object

`settlePayment` returns a wrapper, `{ settlement, header }`, not the settlement
itself. Code that reads `success` on the wrapper, for example
`const result = await settlePayment(...)` followed by
`if (!result.success) return refuse()`, sees `undefined` **every time**, so
every request looks failed, including the ones that were paid. The user's
money has moved, and they are refused the resource they paid for.

TypeScript catches this (`Property 'success' does not exist on type
'X402Settlement'`), but plain JavaScript, `any`, or a loosely typed wrapper
does not. Always destructure:
`const { settlement, header } = await settlePayment(...)`, then test
`settlement.success`.

### When settlement fails

`settlement.errorReason` says why. Common values:

| `errorReason` | Meaning |
|---|---|
| `duplicate_settlement` | This payment was already settled (or is being settled) by this store. |
| `invalid_exact_evm_payload_authorization_valid_before` | The authorization expired between verify and settle. |
| `unexpected_settle_error` | `submit` is missing, threw, or returned something that is not a transaction hash. |
| `invalid_payload` | The payment did not come from `verifyPayment` / `requirePayment`. |

A failure before anything could be broadcast releases the payment's claim, so
the client may retry. When `submit` threw after it may have broadcast, the
outcome is unknown: the claim is kept until its TTL so the same payment is not
sent twice. Check the chain (or your facilitator's records) before you decide
the user did not pay.

## Checklist

- [ ] `accepts` uses the token's real EIP-712 `name` and `version`.
- [ ] `rpc.evm.call` rejects on revert and on chains you do not serve.
- [ ] `submit` resolves only after the transaction succeeded on chain.
- [ ] More than one server instance: a shared `store`.
- [ ] `const { settlement, header } = await settlePayment(...)`; serve only
      when `settlement.success`; set `PAYMENT-RESPONSE: header`.
- [ ] Behind a proxy that rewrites the URL, pass `resource: { url }` to
      `requirePayment` with the public URL: clients refuse a challenge whose
      `resource.url` is on another origin than the one they requested.

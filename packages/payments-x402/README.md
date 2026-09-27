# @naculus/payments-x402

Pay [x402](https://github.com/coinbase/x402) v2 challenges with a
policy-bound Naculus session key.

```ts
import { SessionKeyManager } from "@naculus/connect-core";
import { createX402Fetch, sessionKeyX402Signer } from "@naculus/payments-x402";

const signer = await sessionKeyX402Signer(manager, sessionId);
const pay = createX402Fetch({ signer, networks: ["eip155:8453"] });

const { response, paid, settlement } = await pay("https://api.example.com/data");
```

What it does on a `402` with a `PAYMENT-REQUIRED` header:

1. Parses the challenge (fails closed on anything malformed) and refuses one
   that arrived through a redirect or whose `resource.url` is on another
   origin. The paid retry never follows a redirect.
2. Picks the first requirement it can pay: `exact` scheme, EIP-3009 transfer
   method, a single EIP-155 chain (optionally limited by `networks`). Permit2,
   Solana and other schemes are refused.
3. Builds the EIP-3009 `TransferWithAuthorization` and has the session key
   sign it. **Policy is enforced by the session key, not here**: give it
   `allowedRecipients` (payees), `tokenAllowances` (budget per token) and
   `allowedChainIds`. A key without a `tokenAllowances` entry for the token
   refuses to sign. **Without `allowedRecipients` the key pays whatever
   `payTo` the server names**, up to the token budget — set it for any key
   that talks to servers you do not control.
4. Retries the request once with `PAYMENT-SIGNATURE` and parses
   `PAYMENT-RESPONSE`. A second `402` is an error, never a second payment.

Nothing is broadcast: the server's facilitator settles on chain. The session
key's own address is the payer (`from`), so it must hold the tokens.

## Solana (`exact` on SVM)

```ts
import { solanaPaymentRpc } from "@naculus/connect-core";

const pay = createX402Fetch({
  signer, // optional: EVM requirements, paid by the session key
  solana: { signer: solanaRoles.signer, rpc: solanaPaymentRpc(rpcUrl) },
});
```

A Solana requirement is paid by the **connected wallet** (the Naculus
`SolanaSigner` role): one SPL `TransferChecked` to the payee's associated
token account, with the facilitator's `extra.feePayer` as fee payer, and the
seller's `extra.memo` or a random 16-byte memo. Every payment is a wallet
prompt; no session-key policy applies. Before signing, the RPC must serve the
requirement's cluster (genesis hash) and the mint must be an SPL Token /
Token-2022 mint. What the wallet returns is checked before it is sent — same
transfer, fee payer, blockhash and memo; only Lighthouse assertions may be
added; the payer's signature must verify.

### Promptless, with a Solana session key

```ts
import { SolanaSessionKeyManager, solanaPaymentRpc } from "@naculus/connect-core";

const rpc = solanaPaymentRpc(rpcUrl);
const keys = new SolanaSessionKeyManager({ encryptionKey }, storage);
const key = await keys.createSessionKey(
  { cluster, mint, budget, maxPerPayment, allowedRecipients, expiry },
  owner,
  rpc,
);
// Once: the owner's wallet signs ApproveChecked (delegate = the key).
const { transaction, recentBlockhash } = await keys.prepareApproval(key.id, rpc);
const signed = await solanaRoles.signer.signTransaction(transaction);
await rpc.sendTransaction?.(await keys.attachApproval(key.id, signed, recentBlockhash));

const pay = createX402Fetch({ solana: { sessionKey: { manager: keys, id: key.id }, rpc } });
```

The key pays only its cluster and mint, only allowed payees, within its
per-payment limit, budget (also capped on chain by the delegate approval),
expiry and count, and only when the facilitator pays the fee. Approving
replaces any delegate the owner's token account already had.
`keys.prepareRevocation(id, rpc)` builds the owner's `Revoke`.

## Server side (`@naculus/payments-x402/server`)

Challenge, verify and settle x402 payments in a resource server or a
facilitator. No private key is held here: EVM settlement goes to your
`submit`, Solana fee-payer signing to your `signAsFeePayer`.

```ts
import { requirePayment, settlePayment } from "@naculus/payments-x402/server";

const deps = {
  rpc: { evm: { call: ethCall }, solana: solanaPaymentRpc(rpcUrl) },
  submit: async ({ chainId, to, data }) => sendAndWait(chainId, to, data),
  signAsFeePayer: async (wire) => facilitatorKey.sign(wire),
};

export async function handler(request: Request): Promise<Response> {
  const gate = await requirePayment(request, { accepts, deps });
  if (!gate.verified) return gate.response; // 402 with PAYMENT-REQUIRED
  // Verified is not paid: serve only after a successful settlement.
  const { settlement, header } = await settlePayment(gate.payment, deps);
  if (!settlement.success) {
    return new Response("{}", { status: 402, headers: { "PAYMENT-RESPONSE": header } });
  }
  return new Response(data, { headers: { "PAYMENT-RESPONSE": header } });
}
```

`verifyPayment` requires `accepted` to equal one offered requirement exactly,
then applies the `exact` scheme rules (EIP-3009 signature, payee, amount,
validity window, unused nonce, balance and a simulated transfer on EVM; the
spec's facilitator rules on Solana). `settlePayment` only settles what
`verifyPayment` returned, and refuses the same payload twice within 120 s
(pass `store` to share that cache across processes). A claim is released
only when nothing can have been broadcast; after a broadcast whose outcome
is unknown it is kept until its TTL. On Solana the RPC must still serve the
verified cluster before signing, simulating and sending, and must answer
with the transaction's own signature. Permit2, ERC-7710 and EIP-1271 payers
are not supported.

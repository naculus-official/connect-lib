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

# @naculus/connector-solana-kit

Use a Naculus-connected Solana wallet with [`@solana/kit`](https://github.com/anza-xyz/kit) 8.

```ts
import { toKitSigners } from "@naculus/connector-solana-kit";

const { identity, transactionSigner, messageSigner, sendingSigner } =
  toKitSigners(connector.getSolanaRoles());

if (transactionSigner) {
  // Use it anywhere Kit takes a TransactionModifyingSigner, e.g. as the fee
  // payer of a transaction message, then signTransactionMessageWithSigners.
}
```

- `transactionSigner` (`TransactionModifyingSigner`) — the wallet may rewrite
  the message (fee payer, blockhash, priority fee), so the result is decoded
  as a new transaction and its lifetime is re-derived from what was signed.
- `messageSigner` (`MessagePartialSigner`) — signs the message bytes as given.
- `sendingSigner` (`TransactionSendingSigner`) — the wallet signs and sends.

Each is `null` when the wallet does not have that feature. They share one
address, so attach exactly one of them to a given transaction message (Kit
refuses two signers for the same address). The account's own
signature is verified against its address before it reaches Kit (a
signature from another key is refused), and a wallet's bytes are never
used to fill another account's signature slot. `@solana/kit` ^8 is a peer
dependency, so `@naculus/connector-solana` itself stays Kit-free.

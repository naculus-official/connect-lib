---
"@naculus/wallet-engine": minor
"@naculus/connector-embedded": minor
---

An embedded wallet can now own an ERC-4337 smart account.

`Signer` gains an optional `signHash`, implemented for EVM, which signs a 32-byte digest as an EIP-191 message. `signMessage` could not stand in: it encodes the string it is given, so a userOpHash passed as `"0x1234…"` was signed as those 66 characters rather than the 32 bytes they denote. The signature recovers the right key over the wrong digest, and a SimpleAccount — which applies `toEthSignedMessageHash` to the raw userOpHash — rejects it. That is why account abstraction previously refused embedded wallets outright.

Exposed as `Wallet.signHash` and `PocketConnector.signHash`.

Also extracts the private-key validation that was inlined three times in the EVM signer. The RLP helpers in the same directory were duplicated the same way and drifted until one copy rejected 18% of valid signatures.

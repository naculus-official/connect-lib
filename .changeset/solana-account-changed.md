---
"@naculus/connector-solana": minor
---

Solana in-wallet account switches are now tracked.

`accountChanged` had no branch that recorded a new account: `namespaces.solana.accounts` was written once during `connect()` and never again, and the handler could only null the session. Signing goes through the provider, so after a switch the wallet signed with the new key while the session still advertised the old address — a SIWx message built from that session asserted an address the returned signature did not belong to.

The handler now rewrites the session's CAIP-10 accounts, reads the payload defensively (public key object, base58 string, or accounts array), and treats anything that does not validate as a Solana address as a disconnect rather than writing it into the session.

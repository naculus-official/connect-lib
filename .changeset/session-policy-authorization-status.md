---
"@naculus/connect-core": minor
"@naculus/wallet-engine": patch
---

Expose non-secret session-policy authorization status and the exact signed
off-chain policy message through `SessionKeyInfo`, while keeping signatures and
private keys out of the public UI model. Keep wallet-engine's public session
metadata (including millisecond expiry timestamps) aligned with that shared
type so declaration builds remain publishable. Add a verifier boundary for
revalidating persisted off-chain authorization without exposing its signature
through the session list, including an atomic verify-and-sign boundary that
closes the cross-tab policy-change window. Build the browser entry against Web
Crypto so bundled cryptography cannot silently resolve to an empty Node
`crypto` shim in Vite.

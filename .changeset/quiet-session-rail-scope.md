---
"@naculus/connect-core": major
---

Session key scopes now enforce payment rails. `SessionKeyScope` gains `rails` (`"transfer" | "x402-exact" | "mpp-charge"`, exported as `SessionKeyRail`), and `compileEvmSessionScope` sets it from the grant, so a transfer-only grant can no longer sign an EIP-3009 `TransferWithAuthorization`.

Breaking: a scope without `rails` signs no EIP-3009 typed data. A hand-built `SessionKeyScope` used with `sessionKeyX402Signer` must add `rails: ["x402-exact"]`, and one used with `sessionKeyMppSigner` must add `rails: ["mpp-charge"]`. A scope that sets `rails` also refuses raw-digest signing (`signWithSessionKey`, `signWithVerifiedOffchainAuthorization`); `getSessionBundle`, like `signWithSessionKey`, now refuses to hand out the raw key when `rails` is set, since that key could sign a raw digest. A delegation redemption needs `"transfer"` in it. Scopes stored before this release have no `rails` and must be re-created to sign x402 or MPP charges.

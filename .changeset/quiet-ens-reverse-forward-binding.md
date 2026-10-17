---
"@naculus/connect-core": patch
---

ENS `lookupAddress` now forward-verifies the reverse (primary) name: it returns the name with `isPrimary: true` only when that name's forward `addr` resolves back to the queried address. A reverse record naming another account's ENS name, or a name whose forward resolution fails, now yields `null` (and is not cached by `NameResolver`) instead of being reported as the account's primary name. A reverse lookup now makes two extra RPC calls.

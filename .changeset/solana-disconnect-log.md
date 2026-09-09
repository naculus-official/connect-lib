---
"@naculus/connector-solana": patch
---

Log a failed provider disconnect instead of discarding it.

The local teardown has to happen either way — a user who asks to disconnect
must end up disconnected here even when the wallet refuses to hear it — so the
error is still not rethrown. It is no longer invisible.

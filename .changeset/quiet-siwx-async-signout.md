---
"@naculus/siwx": patch
---

`SiwxSessionManager` now discards an async `signIn`, `refresh` or `restore` that a later `signOut` or `signIn` overtook while it was still waiting on the signer or storage. That operation no longer writes storage, sets the in-memory session, fires `onSessionChange`, or schedules expiry. In that case `signIn` and `refresh` reject with "SIWx operation superseded by a newer signIn or signOut; result discarded". `restore` leaves the newer state unchanged and returns the current session. If the lifecycle changes while a write is already in flight, the manager removes that write afterwards, but only if storage still holds exactly that session. Sign-in, refresh and restore calls that nothing overtakes behave as before.

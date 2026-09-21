# CAIP-25 session lifecycle as a core abstraction

Status: design, step 1 of STATE.md thread 13. No code change.
Date: 2026-09-21.

## Why

CAIP-25 has grown from "WalletConnect namespace negotiation" into a
wallet-agnostic session model: `wallet_createSession`, `wallet_getSession`,
`wallet_revokeSession`, `wallet_sessionChanged`, and per-scope accounts,
methods, notifications and `scopedProperties`. Today Naculus speaks it only
inside `connector-walletconnect`. Injected (EIP-6963), embedded, Solana and
XRPL sessions are shaped by the same `UniversalWalletSession` but their
lifecycle is ad hoc: there is no core-level "the wallet changed what this
session may do" event, and nothing a consumer can call to read or revoke a
session in one way across connectors.

The daily-report benchmark scores this 6–7/10. The fix is not a new
connector; it is making the existing core session model carry the CAIP-25
lifecycle so every connector can produce it.

## What exists

| CAIP-25 concept | Naculus today | Where |
|---|---|---|
| Session identity | `UniversalWalletSession.id`, `topic?` (WC only) | `core/src/session.ts` |
| Scope per namespace (`chains`, `accounts`, `methods`, `events`) | `SessionNamespace` — same four fields, CAIP-2 / CAIP-10 strings | `core/src/session.ts` |
| Scope capabilities (`scopedProperties`) | `NamespaceCapabilities` (atomicBatch, paymasterService, permissions, serverSigning, open) | `core/src/session.ts` |
| Session properties (`sessionProperties`, expiry) | `auth?.expiresAt`, `expiry?`, `platform` | `core/src/session.ts` |
| Per-chain runtime state (RPC, fees, explorer) | `ChainSession`, `ActiveSessionBundle` | `core/src/session-manager/types.ts` |
| Create | `UniversalConnector.connect()`; WC builds required/optional namespaces | `connector.ts`, `walletconnect/namespaces.ts` |
| Get | `SessionManager.getActiveBundle()` / `getAllActiveSessions()` | `session-manager.ts` |
| Revoke | `SessionManager.disconnect()` / `disconnectChain()` → `connector.disconnect()` | `session-manager.ts` |
| Changed (wallet-initiated) | `accountsChanged`, `chainChanged` only, via `UniversalConnector.onAccountsChanged / onChainChanged`; `SessionManager` emits `sessionConnected / sessionDisconnected / chainChanged / chainSessionAdded / chainSessionRemoved / feesUpdated / accountsChanged` | `connector.ts`, `session-manager/events.ts` |
| Expiry (wallet-initiated) | WC `session_delete` / `session_expire` → connector's private `sessionExpiryHandler`; other connectors: nothing | `walletconnect/src/index.ts:1412-1420` |
| Scope update (wallet-initiated) | WC `session_update` → accounts diff only, applied into `lastSession` | `walletconnect/src/index.ts:1455+` |
| Persistence | `PersistedSessionData`; `isSessionExpired` fails closed on malformed dates (0.2.5) | `session-manager/persistence.ts`, `session.ts` |

Conclusion: the **data model is already CAIP-25-shaped**. `SessionNamespace`
maps 1:1 onto a CAIP-25 scope object, `NamespaceCapabilities` onto
`scopedProperties`. What is missing is the **lifecycle contract** — a
connector-neutral way for a wallet to say "this session's scope changed" or
"this session ended", and a core-level read/revoke that does not go through
`SessionManager`'s active-bundle assumption.

## The delta

1. **`UniversalConnector.onSessionChanged?`** — one optional hook next to
   `onAccountsChanged` / `onChainChanged`:
   ```ts
   onSessionChanged?(
     session: UniversalWalletSession,
     handler: (change: SessionChange) => void,
   ): () => void;

   type SessionChange =
     | { type: "scope"; namespaces: Record<Namespace, SessionNamespace> }
     | { type: "expiry"; expiresAt: string | null }
     | { type: "revoked"; reason: "wallet" | "expired" | "app" };
   ```
   WalletConnect maps `session_update` → `scope`, `session_extend` →
   `expiry`, `session_delete` / `session_expire` → `revoked`. Injected and
   embedded connectors initially emit nothing (their scope cannot change
   without a reconnect) — that is correct, not a gap.

2. **`SessionManager` consumes it.** New events `sessionScopeChanged`
   (payload: bundle, previous namespaces, next namespaces) and
   `sessionRevoked` (payload: connectorId, reason). A `scope` change that
   removes the active chain must fall through to the existing
   `chainSessionRemoved` / `switchChain` path rather than leave
   `activeChainId` pointing at a chain the wallet no longer grants. A
   `revoked` change runs the existing `disconnect()` teardown and persistence
   clear. This is where the fail-closed rule lives: **a scope the wallet
   narrowed is applied immediately; a scope the wallet widened is applied
   only for chains the app requested** (never silently accept new
   permissions).

3. **Core-level read/revoke that is not bundle-shaped.**
   `SessionManager.getSession(id)` and `revokeSession(id, reason?)` for
   consumers that hold a session id (appkit's `useSession`, SIWX auth
   session binding). Thin wrappers over what `getAllActiveSessions()` /
   `disconnect()` already do; exist so appkit stops reaching into bundles.

4. **Scope request in `connect()` input, connector-neutral.** Today only WC
   accepts required/optional namespaces. A `SessionScopeRequest` type in
   core (`required` / `optional` per namespace, same `SessionNamespace`
   shape minus `accounts`) that `connect(input)` may carry; WC translates it
   to `buildRequiredNamespaces` / `buildOptionalNamespaces`; EIP-6963
   validates the wallet's chain against `required` and refuses (or prompts
   `wallet_switchEthereumChain`) instead of returning a session on the wrong
   chain. Solana / XRPL ignore `methods` they do not model.

5. **Not in scope.** `wallet_createSession` as a JSON-RPC method Naculus
   *serves* (that is a wallet's job, not a connector SDK's); CAIP-27 request
   routing changes; any new persistence format. `PersistedSessionData` stays;
   revocation clears it as today.

## Boundary for step 2

- Files: `core/src/connector.ts` (additive optional hook + types),
  `core/src/session-manager/{events,session-manager,types}.ts`,
  `connector-walletconnect/src/index.ts` (map four SignClient events to
  `onSessionChanged`; keep `sessionExpiryHandler` until appkit is off it),
  tests beside each. `connector-evm-injected` only if step 4 is included.
- No new dependency. No change to `UniversalWalletSession` field types
  (additive `SessionScopeRequest` type only). No change to signing, chain
  ids, or persistence format.
- Invariants: dispatch stays on `session.walletType` / id prefix; chain ids
  stay CAIP-2; a wallet-widened scope is never auto-accepted; `revoked`
  always clears persistence; every new event has a test that a stale
  (previous-session) event is ignored.
- Public API: additive only → patch under the 0.x caret rule, but the
  behavior change in (2) — sessions now end when the wallet says so on
  every connector, not just WC — belongs in release notes as such.
- Review: `core/src/session*` is on the always-review list; steps 2–4 each
  get one Claude pass on the diff, security folded in.

## Order

Step 2 (hook + manager events + WC producer) is the whole value; 3 and 4
are conveniences that can follow in the same or a later patch. Estimated
size: ~300 lines core + ~120 lines WC + tests. Fits one Codex work package
with one review round.

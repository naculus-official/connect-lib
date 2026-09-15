# @naculus/connect-core

## 0.2.2

> These entries were written as changesets during 0.2.0 and 0.2.1 but never
> consumed at those releases, so they accumulated. They describe work shipped
> across 0.2.0, 0.2.1 and 0.2.2 rather than 0.2.2 alone, and are collected here
> because deleting them would have thrown away the only written record of what
> those releases contained.

### Minor Changes

- 6f156fe: One place that reads CAIP-2 and CAIP-10.
  
  `parseCaip10`, `namespaceOf`, `eip155Reference` and `isEvmAddress`, plus
  `parseChainId` and `validateChainId` now exported from the package root
  instead of only existing inside the session manager.
  
  This is the fourth hand-rolled CAIP parser in the workspace and the first one
  that is meant to be the last. The one it replaces in appkit was
  `chainId.startsWith("eip155:")` followed by
  `parseInt(chainId.split(":")[1], 10)`, which answers `5` for
  `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` — base58 starts with a digit often
  enough. It happened to be guarded everywhere it was used, so it was incapable
  rather than wrong, but the next caller would not have been so lucky.
  
  `eip155Reference` returns null rather than `NaN` or a partial parse: a caller
  comparing chain numbers needs a wrong answer to be impossible, not unlikely.
  `parseCaip10` returns null rather than throwing, because a session's account
  list is data from a wallet and one malformed entry should not take down the
  list around it.
- 5830df7: EIP-7702 delegation reading, and sponsorship as an execution requirement.
  
  `readDelegation` answers a question nothing here could: whether an ordinary
  address is currently able to execute like a contract account. A delegated EOA
  carries exactly 23 bytes of code — the `0xef0100` designator the spec fixes,
  then the 20-byte delegate — and that prefix reuses EIP-3541's reserved opcode
  space precisely so a delegation cannot be mistaken for deployed code.
  
  `delegated` is `boolean | null`. Null means the code was never read, which is
  not the same as an account with no code: treating a failed RPC as "no
  delegation" is how an account that can batch gets sent down the path for one
  that cannot. Delegating to the zero address, which the spec uses to clear a
  delegation, reads as not delegated.
  
  `planExecution` gains a sponsorship axis. It is not a weaker form of atomicity
  — it answers who pays, not whether the calls land together — so it is checked
  separately and can refuse on its own. A route that executes perfectly but
  charges a user who was promised sponsored gas is still the wrong route, and
  signing is too late to find out. A wallet that never answered the capability
  query is not refused on, for the same reason as atomicity: it is the authority
  on its own paymaster.
  
  `planExecution`'s third argument still accepts a bare `AtomicityRequirement`.
- 36c5e0d: `planExecution` — decide how to execute, and be able to say no.
  
  `chooseExecutionStrategy` answers the same question for the default case and
  has no way to express a refusal, so a caller that needed several calls to land
  together was silently downgraded to sending them one after another. For an
  approve batched with the swap it pays for, that leaves an approval standing to
  a contract the user never transacted with.
  
  `planExecution` takes an `AtomicityRequirement` and returns a strategy that can
  be `"refuse"`, together with whether the chosen route is genuinely
  all-or-nothing and a reason an application can show.
  
  The `discovered` flag on `AccountCapabilities` decides the interesting case. A
  wallet that answered "no" made a decision; a wallet with no way to answer did
  not. When atomicity is required and the wallet never told us, the batch is
  still attempted with the atomic flag set — the wallet is the authority and
  rejects cleanly if it cannot, which beats refusing on behalf of an older wallet
  that may well batch.
  
  A single call is reported as atomic on its own, and a batch larger than an
  advertised `maxBatchSize` is a refusal rather than a split, because splitting
  loses the guarantee that was the reason to batch.
- 648fe91: Expose non-secret session-policy authorization status and the exact signed
  off-chain policy message through `SessionKeyInfo`, while keeping signatures and
  private keys out of the public UI model. Keep wallet-engine's public session
  metadata (including millisecond expiry timestamps) aligned with that shared
  type so declaration builds remain publishable. Add a verifier boundary for
  revalidating persisted off-chain authorization without exposing its signature
  through the session list, including an atomic verify-and-sign boundary that
  closes the cross-tab policy-change window. Build the browser entry against Web
  Crypto so bundled cryptography cannot silently resolve to an empty Node
  `crypto` shim in Vite.
- 4974c91: Complete EIP-5792 with `wallet_showCallsStatus`.
  
  `UniversalConnector` gains an optional `showCallsStatus`, implemented by the three connectors that already support `sendCalls`. It asks the wallet to display a bundle to the user, so there is nothing to return; a wallet that refuses or has no such screen leaves the bundle exactly as it was, and the error says so rather than reading like the calls failed.
  
  All four methods of the spec are now present: `wallet_getCapabilities`, `wallet_sendCalls`, `wallet_getCallsStatus`, `wallet_showCallsStatus`.
- abf192a: Framework-neutral Solana RPC reads.
  
  `getSolanaBalance`, `getSignatureStatus`, `getLatestBlockhash`, and exact
  lamport arithmetic in `formatSol` / `parseSol`. No framework import, so a React
  hook and a Vue composable over this are each about ten lines and share every
  decision that took thought.
  
  Two of those decisions are worth naming. Amounts are `bigint` throughout: 0.1
  is not representable in binary floating point, and a balance wrong in its last
  digits is one a user stops trusting. `parseSol` refuses precision finer than a
  lamport rather than rounding an amount without saying so.
  
  `getSolanaBalance` reports whether the account exists as well as its balance. A
  never-funded address answers zero, which reads identically to an account that
  was emptied — they are not the same thing, and only one of them can receive a
  transfer without rent. `getSignatureStatus` likewise treats `"unknown"` as its
  own answer: a node with no record of a signature may never have seen it, or may
  have aged it out, and calling that a failure tells a user their transfer did not
  happen when it may well have.
- 90bb105: Sign and send Solana transactions, and export a key another wallet can read.
  
  **Solana transactions.** The application builds and serializes the transaction
  as it would for Phantom; what it cannot delegate is where the signature goes. A
  transaction carries a fixed-length signature array positionally matched to the
  accounts that must sign, so signing the right bytes and filling the wrong slot
  produces something the cluster rejects with nothing in the error saying why.
  
  `signSolanaTransaction` parses the wire format — compact-u16 count, signature
  array, legacy or versioned message, account keys — finds this wallet's slot,
  and fills it without disturbing a co-signer's. It refuses a transaction this
  key is not a required signer of rather than signing anyway and returning
  something that looks signed. Every fixture in the tests came out of
  `@solana/web3.js` v2; an earlier draft transcribed them by hand and was wrong
  by 32 bytes.
  
  `sendSolanaTransaction` submits over `solanaRpcUrl`, and refuses a transaction
  still missing a co-signature instead of spending a round trip on an opaque
  rejection. The embedded connector routes `signTransaction` and
  `sendTransaction` on the active namespace.
  
  **Three defects this exposed, all silent:**
  
  `connect()` always emitted one `eip155` namespace containing
  `wallet.address`. Once a wallet could hold a Solana account, activating it
  published a base58 Solana address as an EIP-155 account — a CAIP-10 string
  asserting an address exists on a chain it has never existed on. Namespaces are
  now built from the accounts actually held.
  
  `signMessage` never checked the account a caller named. An application asking
  for a signature "as 0x9858…" while Solana was active received an ed25519
  signature: well-formed, attributed to an EVM address, verifying against
  nothing. It now refuses, naming the account that would have signed.
  
  `setActiveNamespace` and `backfillAccounts` told nobody. The connector now
  implements `onAccountsChanged`, so a switch reaches the session rather than
  leaving an interface showing the account from connect time while a different
  key signs.
  
  **`exportPrivateKey(namespace)`.** The stored form is hex for both namespaces,
  which MetaMask reads and Phantom does not. Getting a usable Solana key
  previously meant reading the account, knowing the encoding, hex-decoding it and
  finding the base58 helper — an export a user has to convert by hand is the same
  as no export. `eip155` returns `0x` hex; `solana` returns the 64-byte base58
  Phantom takes. `exportSolanaKeypairJson()` returns the array `solana-keygen`
  writes.
  
  **`PassphraseGate` moved to `@naculus/connect-core`** so the Vue layer can use
  the same object as React. It is re-exported from
  `@naculus/connect-appkit-react`, so a React consumer sees no change.
- 4974c91: `UniversalConnector` gains `onAccountsChanged` and `onChainChanged`.
  
  Every namespace has a way for a wallet to report that the user switched accounts or chains — EIP-1193 `accountsChanged`, Solana's `accountChanged`, a WalletConnect `session_event` or `session_update` — and consumers had to know which. Only the injected EVM path was wired up anywhere, so a Solana or WalletConnect switch was silently ignored.
  
  Both methods return an unsubscribe function, and the contract is that the connector has already updated `session.namespaces` before subscribers run, so a consumer can read the session directly. An empty accounts array signals that the wallet is no longer authorizing the dApp.
  
  `connector-walletconnect` now handles `session_event` and `session_update` at all; it previously listened only for `session_delete` and `session_expire`, so an in-wallet account or chain switch never reached the session.

### Patch Changes

- 4974c91: Add an ed25519 signer, and replace a hand-written base58 that decoded some values one byte too long.
  
  `Ed25519Signer` signs for Solana. Two differences from the EVM signer are deliberate, because copying that behavior would produce signatures the chain rejects: there is no EIP-191 prefix, since Solana wallets sign the raw bytes, and there is no recovery id, since ed25519 verification takes the public key as an input and has nothing to recover. `signTransaction` refuses rather than pretending — `TransactionRequest` describes gas, nonce and EIP-1559 fees, none of which a Solana transaction has — and `signBytes` signs a message serialized by Solana tooling, which is the division every Solana wallet uses.
  
  `connect-core` had its own base58 encoder and decoder for SNS resolution. The decoder returned one byte too many whenever the decoded value was zero: `toString(16)` yields `"0"`, which pads to a byte, and that byte was added on top of the counted leading zeros — so the all-zeros Solana System Program ID decoded to 33 bytes instead of 32. Verified against `@scure/base` before replacing it.
  
  The failure mode is quiet. Those bytes are hashed into a program-derived address, so a length that is off by one does not error; it derives a different, valid-looking address, and a `.sol` name resolves to an account that is not the owner's. Both functions now come from `@scure/base`, and a regression test covers the lengths the old implementation got wrong.

## 0.1.1

### Patch Changes

- ci: verify 0.1.1 publish workflow

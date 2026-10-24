# Migration guide: 0.14 wallet storage and session-key rails

This guide covers applications using `@naculus/connector-embedded`, `@naculus/wallet-engine`, and session keys.

## Wallet storage now requires a passphrase

Every wallet storage configuration requires `encryptionPassphrase`, in browsers, Node, and with custom storage adapters. The wallet encrypts records before sending them to any adapter. Constructing a wallet without a passphrase throws `WalletError` with code `storage_unavailable`. A custom adapter does not bypass encryption.

Before:

```ts
const wallet = new PocketWallet({ storage });
```

After:

```ts
const wallet = new PocketWallet({
  storage,
  encryptionPassphrase: async () => await getWalletPassphrase(),
});
```

The passphrase callback can be invoked when encrypted data is loaded or saved. It must return a non-empty passphrase; cancel by throwing. Do not hard-code a production passphrase in client code.

`allowInsecureStorage` is deprecated and has no effect. It does not permit plaintext storage or waive the passphrase requirement; built-in storage always encrypts wallet records.

## IndexedDB and fallback behavior

With `storageType: "indexedDb"`, construction throws `storage_unavailable` if IndexedDB is unavailable. This explicit choice never falls back. An IndexedDB read/write/clear attempted after availability changes also throws `storage_unavailable`; in particular, `load()` does not return `null` to imply an empty wallet.

With automatic storage selection (the default), the wallet uses IndexedDB when available. If it is unavailable, the only built-in fallback is encrypted `localStorage`, and it still requires `encryptionPassphrase`. You can also select `storageType: "localStorage"` explicitly; this is encrypted but has a weaker browser storage security rating.

## Older wallet records and private keys

Earlier stored wallet records may include account private keys. New records persist the mnemonic and account namespace/address/derivation metadata only; account private keys are re-derived from the mnemonic when loading. An old version-1 record with a mnemonic can still load: the wallet migrates it in memory, re-derives the account, and verifies that its address matches. A successful load does not rewrite storage; the new record format is written on a later explicit save. A record with no mnemonic, malformed data, or an address that does not match derivation is rejected with an error. Keep a recovery phrase backup before upgrading.

## Raw-key import when a mnemonic wallet is stored

Raw-key import is rejected if storage contains a mnemonic wallet. To replace that stored wallet with a raw-key wallet, call the embedded connector's `wipe()` first, then import using `importFromPrivateKey()`:

```ts
await connector.wipe(); // Permanently clears the stored wallet record.
await connector.importFromPrivateKey(privateKey);
```

`wipe()` clears the wallet from memory and persistent wallet storage. This deletes the stored wallet, so only do it after the user has confirmed they have the recovery material they need. `disconnect()` only ends the connector session and does not clear the stored wallet.

Raw-key wallets have no mnemonic and cannot be persisted under the mnemonic-only storage contract.

## Session-key authorization rails

Every session-key scope and authorization grant must contain a non-empty `rails` array with distinct supported values: `"transfer"`, `"x402-exact"`, and/or `"mpp-charge"`. Missing, empty, duplicate, or unknown rails are rejected. Existing authorizations whose signed scope lacks a valid `rails` array fail authorization verification; old persisted session keys without valid rails are also rejected when validated or used. Users must receive a new scope and grant that explicitly state the intended rails.

Before:

```ts
const scope = {
  expiry,
  maxTotalValue,
};
```

After:

```ts
const scope = {
  expiry,
  maxTotalValue,
  rails: ["transfer", "x402-exact", "mpp-charge"],
};
```

Include only the rails the user is authorizing. EIP-3009 `TransferWithAuthorization` signing must name the matching rail: `x402-exact` for x402 exact payments or `mpp-charge` for MPP charges. A grant for one does not authorize the other, and `transfer` alone cannot authorize either EIP-3009 payment.

## Detecting and re-granting missing rails

When validating an existing off-chain authorization, call `verifyOffchainAuthorization(sessionId, expectedMessage, verifier)`. It returns `false` when the stored scope has missing or invalid rails, as well as when the signature/message is invalid. Prompt the user to create a replacement session key with its intended `rails`, then authorize it again with the wallet; a grant cannot be extended silently because the rails are part of the signed scope.

There is no `checkSessionKeyRailGrant` API in `connect-lib` on `origin/dev`. Use `verifyOffchainAuthorization` to check the existing grant and handle `false` as requiring re-grant.

## Not verified

- This guide was checked against `connect-lib` `origin/dev` at `5790b4225856fabfb05171ce593680314c12f111`. Fetching from GitHub was unavailable in this environment, so the remote was not refreshed during this task.
- No tests or build checks were run; this change adds documentation only.

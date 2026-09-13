# Multi-namespace embedded wallet — design draft

**Status: draft for review. No code has changed.**

The embedded wallet holds one secp256k1 keypair and can therefore hold funds on
EVM chains only. Solana derivation exists (`deriveSolanaKeypair`) and an
ed25519 signer exists (`Ed25519Signer`), but `PocketWallet` calls neither,
because `WalletData` has room for exactly one key.

The model this describes is the one Phantom uses and the one a card wallet on a
phone uses: one thing the user calls "my wallet", holding several accounts.

## What is already settled, and is not up for discussion

One seed derives **separate, independent keys per namespace**. This is not a
choice — BIP-44 puts the coin type in the path, so changing 60' to 501' changes
the HMAC input and therefore the key. Measured from the same phrase:

    EVM  m/44'/60'/0'/0/0   → 0x1ab42cc4…b12b727
    SVM  m/44'/501'/0'/0'   → 0x37df573b…48bb445

The derivation is one-way: holding the Solana key does not let anyone compute
the EVM key.

**A single key is never shared across curves.** Mechanically a 32-byte value
can serve as both a secp256k1 key and an ed25519 seed, but doing so would be a
Naculus-only scheme: every other wallet derives per coin type, so an exported
phrase would open different accounts elsewhere. That breaks the exit guarantee
this SDK makes, which is the one property it cannot trade away.

### What separation does and does not protect

| Leak | Consequence |
|---|---|
| The EVM private key | EVM assets only |
| The Solana private key | Solana assets only |
| **The mnemonic** | **Everything, on every namespace** |

Separate derived keys limit the blast radius of a leaked *key*. They do nothing
about a leaked *seed*, because every key comes from it. True isolation needs
separate mnemonics — which means the user backs up two phrases, and a lost
second phrase is a more likely loss than a leaked single derived key. Every
major wallet has made the same trade; this should too, and should say so rather
than implying an isolation it does not provide.

## Proposed shape

```ts
export type WalletNamespace = "eip155" | "solana";

export interface WalletAccount {
  namespace: WalletNamespace;
  /** secp256k1 key, or ed25519 seed, as hex. */
  privateKey: string;
  /** Checksummed 0x address, or base58 public key. */
  address: string;
  /**
   * The path this was derived at. Absent for a raw imported key, which has no
   * path — and that absence is meaningful: such a key cannot be recovered from
   * the mnemonic, so losing it loses the account.
   */
  derivationPath?: string;
}

export interface WalletData {
  /** Empty when the wallet was imported from a raw key. */
  mnemonic: string;
  accounts: WalletAccount[];
  createdAt: number;
  chainId?: string;
  /** Absent means version 1. See migration below. */
  version?: 2;
}
```

`privateKey` and `address` disappear from the top level. That is the breaking
part.

## Which namespaces an import enables

This is the part with a product decision in it, and the answer differs by what
was imported.

### From a mnemonic — enable both

A phrase deterministically produces an account on every namespace. Enabling
only one would hide funds the user already owns: they could send USDC to their
Solana address from elsewhere, and the wallet would show nothing.

### From a raw private key — enable only the namespace it belongs to

A raw key belongs to exactly one curve. Showing an account for the other
namespace would show an address the key cannot control and that the user has no
way to recover, which is worse than showing nothing.

Detection is mostly **verification, not heuristics**:

| Input | Verdict | How |
|---|---|---|
| `0x` + 64 hex | eip155 | Format is unambiguous; also check it is below the secp256k1 order |
| base58 decoding to 64 bytes | solana | **Verify** the last 32 bytes equal the ed25519 public key of the first 32. If they do, this is certain, not inferred |
| JSON array of 64 numbers | solana | Solana CLI keypair file; same verification |
| 32 bytes, no other signal, invalid as secp256k1 | solana | A key above the curve order cannot be secp256k1 |
| 32 bytes, no other signal, valid as secp256k1 | **ambiguous** | Ask |

The last row is the only genuinely ambiguous case, and the honest response is
to ask rather than pick. Choosing wrongly creates an account the user cannot
use and does not know is empty.

The 64-byte check is worth stressing: `publicKey === ed25519(secret)` either
holds or it does not. That is a proof, and it is why this can be a
one-question-fewer flow rather than a guess dressed up as convenience.

## Migration from version 1

Stored records have `privateKey` and `address` at the top level and no
`version`. They are all EVM, since that is the only thing the wallet could
produce.

```
version absent  →  accounts: [{
                     namespace: "eip155",
                     privateKey, address,
                     derivationPath: stored ?? "m/44'/60'/0'/0/0",
                   }]
                   version: 2
```

Rules for the migration:

- **Read-only until the user acts.** Rewriting storage on load turns a
  successful read into a write that can fail halfway; migrate on the next
  explicit save.
- **Derive the Solana account only when a mnemonic is present.** A wallet
  imported from a raw key has none, so it stays single-namespace forever, which
  is correct.
- **Never discard the original record until the new one has been read back.**
  This is the one step where a bug costs a user their wallet.
- The migration must be reversible in the sense that a v2 record still contains
  everything a v1 reader needed, so a rollback does not strand anyone.

## API impact

`getWalletData()` changes shape — that is the break. Convenience accessors keep
the common path short:

```ts
wallet.account("eip155")   // WalletAccount | null
wallet.account("solana")
wallet.address             // the active namespace's address
```

`signMessage` and `signTransaction` route by the active namespace. The ed25519
signer already refuses `signTransaction` with a `TransactionRequest`, so a
Solana transaction goes through `signBytes` after being serialized by Solana
tooling — the same division every Solana wallet uses.

## XRPL

Not included, and the reason is not maturity of the chain.

- **XRPL EVM sidechain** is an eip155 chain. It needs a registry entry and
  nothing else: coin type 60, the same key, the same address. If the goal is
  XRPL exposure, this is available today for the cost of one configuration
  line.
- **XRPL natively** needs a decision the other two did not: it supports both
  secp256k1 and ed25519 for account keys, so "derive an XRPL account" is
  underspecified until someone picks. Its addresses are base58 with Ripple's
  own alphabet plus a checksum, and `connector-xrpl` holds no keys today — it
  asks Xaman to sign — so this would be new custody surface rather than an
  extension of existing custody.

Recommendation: take the sidechain, leave native XRPL until there is a user
asking for it.

## Open questions for review

1. Is the breaking change to `WalletData` acceptable now, before 0.2.0 is
   published? It is far cheaper here than after.
2. For the ambiguous 32-byte import: ask the user, or refuse and require a
   prefixed or 64-byte form?
3. Should a Solana account appear for a wallet created before this change, once
   migrated? It is derivable from the stored mnemonic, but it would appear
   without the user asking for it.

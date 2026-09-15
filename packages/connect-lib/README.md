# @naculus/connect

Convenience umbrella package — install one package, use the core API directly,
and access every bundled connector through a collision-free namespace.

## Install

```sh
npm install @naculus/connect
```

Equivalent to installing all of:

| Package | Description |
|------|------|
| `@naculus/connect-core` | Core interfaces and ConnectorManager |
| `@naculus/connector-walletconnect` | WalletConnect v2 bridge |
| `@naculus/connector-evm-injected` | EVM browser-injected wallet |
| `@naculus/connector-embedded` | Embedded non-custodial wallet |
| `@naculus/connector-passkeys` | WebAuthn Passkeys wallet |
| `@naculus/connector-solana` | Solana wallet |
| `@naculus/connector-xrpl` | XRPL wallet |
| `@naculus/siwx` | CAIP-122 cross-chain verification |
| `@naculus/wallet-engine` | Key engine (BIP39, signing) |

## Usage

```ts
import { ConnectorManager, embedded, walletConnect } from "@naculus/connect";

const manager = new ConnectorManager();
const pocket = embedded.createPocketConnector({
  chainId: "eip155:11155111",
  rpcUrl: "https://ethereum-sepolia.publicnode.com",
});
const wc = walletConnect.createWalletConnectConnector({
  projectId: "your-project-id",
  metadata: {
    name: "Example",
    description: "Example dapp",
    url: "https://example.com",
    icons: [],
  },
});
```

The root also exports the complete `@naculus/connect-core` API. Connector
namespaces are `coinbase`, `embedded`, `evmInjected`, `passkeys`, `safe`,
`solana`, `walletConnect`, and `xrpl`; `siwx` and `walletEngine` expose the
authentication and key-engine APIs.

You can still install individual packages when bundle size or dependency
surface matters more than the single-package convenience.

## Standards

<!-- Kept in step with the table in the repository README. This file is the one
     published to npm, and it is the only description most people will read. -->

| Standard | Status | Package |
|------|------|------|
| EIP-1193 (Provider API) | ✅ | connector-evm-injected |
| EIP-6963 (Multi Injected Provider Discovery) | ✅ | connector-evm-injected |
| EIP-4361 / CAIP-122 (SIWx) | ✅ | siwx |
| ERC-1271 (contract-account signatures) | ✅ | siwx |
| ERC-6492 (pre-deployment signatures) | ✅ | siwx |
| EIP-5792 (wallet calls) | ✅ | core, connector-evm-injected, connector-walletconnect, connector-coinbase |
| ERC-4337 (smart accounts) | ✅ | core |
| EIP-7702 (delegation, read) | ✅ | core |
| Solana Wallet Standard (discovery + signer roles) | ✅ | connector-solana |
| WalletConnect v2 (CAIP-25) | ✅ | connector-walletconnect |

### Decide how to execute before you send

EIP-5792 is implemented in full — `wallet_getCapabilities`, `wallet_sendCalls`,
`wallet_getCallsStatus`, `wallet_showCallsStatus` — so an application can ask
what a wallet can do rather than learn it from a rejection.

```ts
import { readAtomicSupport, planExecution } from "@naculus/connect";

const atomic = readAtomicSupport(capabilities, "eip155:1");

if (atomic === "supported") {
  // one batch, all or nothing
} else if (atomic === "unsupported") {
  // sequential: an approve can land and the swap it was for can still fail
} else {
  // "unknown" — the wallet was never asked, or the query failed or is in
  // flight. EIP-5792 is explicit that absence is not a denial, so this is a
  // third answer rather than a second "no".
}
```

`planExecution` turns that, plus a sponsorship requirement, into a route — and
returns `"refuse"` when nothing available can satisfy what was asked for,
instead of picking the closest thing and hoping.

EIP-7702 delegation is readable through `readDelegation`, which answers
`true`, `false` or `null`: an account whose code was never fetched is not the
same as an account with no delegation.

### Ask a Solana wallet which role it can fill

The same idea on the other namespace. `connector.getRoles(session)` splits a
connected account into `identity`, `signer` and `payer`, and returns `null` for
a role the wallet declared it cannot fill — so a co-signing flow finds out
before it opens a dialog, not at the approval prompt. See
[`@naculus/connector-solana`](https://www.npmjs.com/package/@naculus/connector-solana#signer-roles).

## License

MIT

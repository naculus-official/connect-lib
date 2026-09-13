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

## License

MIT

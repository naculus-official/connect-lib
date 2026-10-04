# Paying x402 from an external wallet

This guide shows how to pay an [x402](https://github.com/coinbase/x402) v2
resource from the user's own browser wallet (MetaMask, Coinbase Wallet, Rabby,
OKX, Phantom, or any other EIP-6963 wallet). It uses `walletX402Signer` and
`createX402Fetch` from `@naculus/payments-x402` (0.9.0 or later), and
optionally checks the receipt with `verifyX402Settlement`.

Design and rationale: [x402-external-wallet.md](../design/x402-external-wallet.md).
The code below is excerpted from
[examples/x402-external-wallet.ts](./examples/x402-external-wallet.ts), which
is typechecked with the rest of the repository (`npx tsc --noEmit`).

## What you get

- A `402 Payment Required` answer with a `PAYMENT-REQUIRED` header is paid
  **once**: the wallet signs an EIP-3009 `TransferWithAuthorization` for the
  token, and the request is retried with `PAYMENT-SIGNATURE`. A second `402`
  is an error, never a second payment.
- Each payment is one wallet prompt (the wallet's typed-data signature screen).
  No session key, no stored policy: the user consents to every payment.
- Nothing is broadcast by the client. The server's facilitator submits the
  transfer and pays the gas; the user needs the token (for example USDC), not
  ETH.

Only the x402 `exact` scheme with EIP-3009 on EIP-155 chains is paid this way.
For promptless payments under a spending policy, use a session key
(`sessionKeyX402Signer`, see the
[package README](../../packages/payments-x402/README.md)).

## 1. Connect the wallet

```sh
pnpm add @naculus/payments-x402 @naculus/connect-core @naculus/connector-evm-injected
```

Let the user pick a wallet from EIP-6963 discovery and connect it:

```ts
import { parseCaip10, type SettlementRpc } from "@naculus/connect-core";
import {
  createEIP6963Connector,
  type DiscoveredWallet,
} from "@naculus/connector-evm-injected";
import {
  createX402Fetch,
  verifyX402Settlement,
  walletX402Signer,
  X402Error,
} from "@naculus/payments-x402";

const connector = createEIP6963Connector();

export function listWallets(): DiscoveredWallet[] {
  return connector.getDiscoveredWallets();
}

export async function connectAndBuildPay(wallet: DiscoveredWallet) {
  const session = await connector.connect(wallet.id);
  const account = session.namespaces.eip155?.accounts[0];
  const address = account ? parseCaip10(account)?.address : undefined;
  if (!address) throw new Error("The wallet returned no EVM account.");
  // ...
```

## 2. Build the signer

```ts
  const signer = walletX402Signer({
    provider: wallet.provider,
    address: address as `0x${string}`,
    switchChain: (chainId) => connector.switchChain(session, chainId),
  });
```

`walletX402Signer` needs only an EIP-1193 `request` function, the paying
address, and a function that switches the wallet to a CAIP-2 chain
(`"eip155:84532"`). It does not care which connector you use; with
WalletConnect, pass that session's provider and switch function instead.

### The wallet must be on the payment chain

Every wallet tested refuses to sign EIP-712 data whose `domain.chainId` is not
its active chain (MetaMask: `-32603 "must match the active chainId"`). So,
before asking for the signature, the signer:

1. reads `eth_chainId`;
2. if it is not the chain in the payment's typed data, calls your
   `switchChain`. The EIP-6963 connector's `switchChain` sends
   `wallet_switchEthereumChain`, and when the wallet does not know the chain
   (error `4902`, also when Rabby or MetaMask Mobile wrap it in `-32603`) it
   first adds it with `wallet_addEthereumChain`, using the metadata from the
   core chain registry (Ethereum, Sepolia, Base, Base Sepolia, Arbitrum,
   Optimism, Polygon);
3. reads `eth_chainId` again and refuses with
   `X402Error("invalid_input")` if the wallet is still on another chain.

The wallet may show the user a "switch network" (or "add network") prompt
before the signature prompt. That is expected.

## 3. Pay with `createX402Fetch`

```ts
  return createX402Fetch({
    signer,
    networks: ["eip155:84532"], // Base Sepolia; pay nothing else
    approve: (requirement) =>
      // Last word before the wallet prompt: here, at most 1 USDC (6 decimals).
      BigInt(requirement.amount) <= 1_000_000n,
  });
}
```

```ts
  const pay = await connectAndBuildPay(wallet);
  try {
    const result = await pay("https://api.example.com/report");
    // result.response   — the paid response
    // result.paid       — the requirement that was paid, or null without a 402
    // result.settlement — the server's PAYMENT-RESPONSE, or null
```

- `networks` limits the chains you will pay on. Leave it out only if any chain
  the server offers is acceptable.
- `approve` is your last word before the wallet prompt: return `false` to
  decline, which throws `X402Error("payment_rejected")`. Use it to cap amounts
  or to show your own confirmation (for example the amount and payee) before
  the wallet's screen.
- The challenge must come from the requested origin, without a redirect, and
  the paid retry never follows a redirect.

### Use the signer only through `createX402Fetch`

`createX402Fetch` builds the typed data itself, from the server's challenge,
with `buildTransferAuthorization`. **Do not call `signer.signTypedData`
yourself** with typed data you built: the signer is a thin adapter over the
wallet, not a policy or consent boundary, and it adds the EIP-3009 `types` to
whatever it is given. Calling it directly is unsupported.

## 4. Handle the outcomes

All refusals are `X402Error` with a `code`:

| `code` | When | What to do |
|---|---|---|
| `user_rejected` | The user rejected the signature prompt (wallet error `4001`). | Treat as a cancel. Nothing was signed or paid. Do not retry by yourself. |
| `payment_rejected` | Your `approve` returned `false`, or the server answered the paid retry with another `402`. | Show the reason; do not retry automatically. |
| `invalid_input` | The wallet stayed on another chain; the wallet returned a signature that is not 65 bytes (contract wallet); or the signature recovers to another account. | Show the message. Nothing was sent to the server. |
| `invalid_challenge` / `no_acceptable_requirement` | The `402` was malformed, redirected, for another origin, or offers nothing you can pay. | Not payable with this client. |

```ts
  } catch (error) {
    if (error instanceof X402Error && error.code === "user_rejected") {
      return null; // The user closed the wallet prompt. Do not retry by itself.
    }
    throw error;
  }
```

A rejected **chain switch** is not a payment rejection: it fails inside your
`switchChain`, and that function's error is passed through unchanged (the
EIP-6963 connector reports it as a `WalletError` with code
`chain_unsupported`).

### Contract wallets are refused for now

Smart-contract wallets (ERC-1271, or ERC-6492 for undeployed accounts) return
signatures that are not 65-byte ECDSA. The signer refuses them with
`X402Error("invalid_input", "Smart-contract wallet signatures are not supported yet.")`
before anything is sent. Until facilitators verify ERC-1271 signatures,
contract-wallet users need another way to pay. Before the signature is
returned, the signer also recovers the signer address and refuses anything that
is not exactly `address` (only `v = 27/28`, low-`s` secp256k1 is accepted), so a
wallet that signed with another account or a different payload fails here.

## 5. Verify the settlement (optional)

`createX402Fetch` never waits for the chain. The `PAYMENT-RESPONSE` header is
the server's claim. To check it yourself, call `verifyX402Settlement` with an
RPC for the payment chain:

```ts
    if (result.paid) {
      const verification = await verifyX402Settlement(
        result,
        jsonRpc("https://sepolia.base.org"),
      );
      if (verification.status !== "verified") {
        // "pending" can be retried later; anything else is not proof of payment.
        console.warn("Settlement not verified:", verification);
      }
    }
```

The statuses are `"verified"` (the exact `Transfer` and the signed
`AuthorizationUsed` nonce are on chain, sufficiently confirmed), `"pending"`
(check again later), and `"failed"`, `"mismatch"` or `"unavailable"`, none of
which is proof of payment.

The second argument is any `SettlementRpc` (from `@naculus/connect-core`): an
object with `request(method, params)` that serves the payment's chain. The
example's `jsonRpc(url)` is a ten-line JSON-RPC version; a viem client's
`request` works too. Verification uses `result.settlementBinding`, the
token, payer, payee, amount and nonce the wallet signed, so a server cannot
point it at another transfer.

## React and Vue

`@naculus/connect-appkit-react` and `@naculus/connect-appkit-vue` provide
`useX402Signer()`, which builds this signer from the connected EIP-6963 or
WalletConnect session and its `switchChain`. The rules above apply unchanged.

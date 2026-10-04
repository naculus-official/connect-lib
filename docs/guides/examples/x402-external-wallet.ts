// Example for docs/guides/x402-external-wallet.md. Typechecked by the root
// `tsc --noEmit`; not shipped in any package.
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

// 1. Connect the wallet the user picked (MetaMask, Coinbase Wallet, Rabby,
//    OKX, Phantom, ...). Every one of them announces itself over EIP-6963.
const connector = createEIP6963Connector();

export function listWallets(): DiscoveredWallet[] {
  return connector.getDiscoveredWallets();
}

export async function connectAndBuildPay(wallet: DiscoveredWallet) {
  const session = await connector.connect(wallet.id);
  const account = session.namespaces.eip155?.accounts[0];
  const address = account ? parseCaip10(account)?.address : undefined;
  if (!address) throw new Error("The wallet returned no EVM account.");

  // 2. The signer. `switchChain` is the connector's own switch: it asks
  //    wallet_switchEthereumChain and, when the wallet does not know the
  //    chain (4902), adds it with wallet_addEthereumChain first.
  const signer = walletX402Signer({
    provider: wallet.provider,
    address: address as `0x${string}`,
    switchChain: (chainId) => connector.switchChain(session, chainId),
  });

  // 3. The only supported way to use the signer: hand it to createX402Fetch,
  //    which builds the EIP-3009 typed data from the server's challenge.
  return createX402Fetch({
    signer,
    networks: ["eip155:84532"], // Base Sepolia; pay nothing else
    approve: (requirement) =>
      // Last word before the wallet prompt: here, at most 1 USDC (6 decimals).
      BigInt(requirement.amount) <= 1_000_000n,
  });
}

// A JSON-RPC endpoint for the chain the payment settled on.
function jsonRpc(url: string): SettlementRpc {
  let id = 0;
  return {
    async request<T = unknown>(method: string, params?: readonly unknown[]) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      const body = (await response.json()) as {
        result?: T;
        error?: { message: string };
      };
      if (body.error) throw new Error(body.error.message);
      return body.result as T;
    },
  };
}

export async function buyReport(wallet: DiscoveredWallet): Promise<unknown> {
  const pay = await connectAndBuildPay(wallet);
  try {
    const result = await pay("https://api.example.com/report");
    // result.response   — the paid response
    // result.paid       — the requirement that was paid, or null without a 402
    // result.settlement — the server's PAYMENT-RESPONSE, or null
    if (!result.response.ok) {
      throw new Error(`Server answered ${result.response.status}.`);
    }
    if (result.paid) {
      // 4. Optional, explicit: check the receipt on chain yourself.
      const verification = await verifyX402Settlement(
        result,
        jsonRpc("https://sepolia.base.org"),
      );
      if (verification.status !== "verified") {
        // "pending" can be retried later; anything else is not proof of payment.
        console.warn("Settlement not verified:", verification);
      }
    }
    return await result.response.json();
  } catch (error) {
    if (error instanceof X402Error && error.code === "user_rejected") {
      return null; // The user closed the wallet prompt. Do not retry by itself.
    }
    throw error;
  }
}

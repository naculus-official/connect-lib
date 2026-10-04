// Example for docs/guides/upgrading-to-0.10.md (walletX402Signer, 0.9.0+).
// Typechecked by the root `tsc --noEmit`; not shipped in any package.
import {
  createEIP6963Connector,
  type DiscoveredWallet,
} from "@naculus/connector-evm-injected";
import { createX402Fetch, walletX402Signer } from "@naculus/payments-x402";

const connector = createEIP6963Connector();

export async function payFromWallet(
  wallet: DiscoveredWallet,
  address: `0x${string}`,
) {
  const session = await connector.connect(wallet.id);
  const signer = walletX402Signer({
    provider: wallet.provider,
    address,
    // Since 0.9.0 this adds the chain (e.g. Base Sepolia) if the wallet lacks it.
    switchChain: (chainId) => connector.switchChain(session, chainId),
  });
  const pay = createX402Fetch({ signer, networks: ["eip155:84532"] });
  return pay("https://api.example.com/report");
}

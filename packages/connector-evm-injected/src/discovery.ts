import type { Eip6963EthereumProvider } from "./types";

export const EIP6963_ANNOUNCE_EVENT = "eip6963:announceProvider";
export const EIP6963_REQUEST_EVENT = "eip6963:requestProvider";

export function isMetaMaskInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return (
    (window as unknown as { ethereum?: { isMetaMask?: boolean } }).ethereum
      ?.isMetaMask ?? false
  );
}

export function isCoinbaseWalletInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return (
    (window as unknown as { ethereum?: { isCoinbaseWallet?: boolean } })
      .ethereum?.isCoinbaseWallet ?? false
  );
}

declare global {
  interface Window {
    ethereum?: Eip6963EthereumProvider & {
      isMetaMask?: boolean;
      isCoinbaseWallet?: boolean;
      removeListener?: (
        event: string,
        handler: (...args: unknown[]) => void,
      ) => void;
    };
  }
}

export interface EIP6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

export interface EIP6963Provider {
  info: EIP6963ProviderInfo;
  provider: Eip6963EthereumProvider;
}

export type Eip6963EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener: (
    event: string,
    handler: (...args: unknown[]) => void,
  ) => void;
  isMetaMask?: boolean;
  isCoinbaseWallet?: boolean;
};

export interface DiscoveredWallet {
  id: string;
  name: string;
  icon: string;
  rdns: string;
  provider: Eip6963EthereumProvider;
}

export interface EIP6963Session {
  wallet: DiscoveredWallet;
  accounts: string[];
  chains: string[];
  methods: string[];
  events: string[];
}

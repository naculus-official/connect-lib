import type {
  Namespace,
  SessionNamespace,
  UniversalConnector,
  UniversalWalletSession,
} from "@naculus/connect-core";
import { extractAccounts, WalletError } from "@naculus/connect-core";
import {
  type WalletConnectConfig,
  WalletConnectConnector,
} from "@naculus/connector-walletconnect";
import {
  type Account,
  type Chain,
  createClient,
  custom,
  type Transport,
} from "viem";
import {
  ChainNotConfiguredError,
  type Connector,
  type CreateConnectorFn,
  SwitchChainNotSupportedError,
} from "wagmi";

export type { WalletConnectConfig };

/**
 * Naculus Wagmi-compatible Connector
 *
 * Wraps the native @naculus/connector-walletconnect into a wagmi `Connector`
 * so RainbowKit and any wagmi-based dApp can use it directly.
 *
 * @example
 * ```typescript
 * import { createNaculusConnector } from "@naculus/connector-wagmi";
 * import { createConfig, http } from "wagmi";
 * import { mainnet, polygon } from "wagmi/chains";
 *
 * const naculusConnector = createNaculusConnector({
 *   projectId: "your-project-id",
 *   metadata: { name: "My DApp", description: "...", url: "...", icons: [] },
 * });
 *
 * const config = createConfig({
 *   chains: [mainnet, polygon],
 *   connectors: [naculusConnector],
 *   transports: { [mainnet.id]: http(), [polygon.id]: http() },
 * });
 * ```
 */
export function createNaculusConnector(
  config: WalletConnectConfig & { chains?: Chain[] },
): CreateConnectorFn {
  return (wagmiParams) => {
    const chains =
      wagmiParams.chains ?? config.chains ?? ([] as readonly Chain[]);

    // Build CAIP-10 namespace from wagmi chains
    const eip155Methods = [
      "eth_accounts",
      "eth_requestAccounts",
      "personal_sign",
      "eth_sign",
      "eth_signTransaction",
      "eth_sendTransaction",
      "eth_sendRawTransaction",
      "eth_signTypedData_v4",
      "wallet_switchEthereumChain",
    ];
    const eip155Events = ["accountsChanged", "chainChanged", "disconnect"];
    const eip155Chains = chains.map((c: Chain) => `eip155:${c.id}`);

    // Track session internally
    let currentSession: UniversalWalletSession | undefined;
    let currentChainId: number | undefined;

    const emitter = wagmiParams.emitter;

    // Wagmi connector shape
    const wagmiConnector: Connector = {
      id: "naculus",
      name: "Naculus",
      type: "walletconnect" as Connector["type"],

      // @ts-expect-error  — ponytail: wagmi v3 generic return type; runtime unchanged
      async connect(parameters?: {
        chainId?: number;
        isReconnecting?: boolean;
        withCapabilities?: boolean;
      }): Promise<{
        accounts: readonly `0x${string}`[];
        chainId: number;
      }> {
        const connector = new WalletConnectConnector({
          projectId: config.projectId,
          metadata: config.metadata,
        });

        const wcChains = parameters?.chainId
          ? [`eip155:${parameters?.chainId}`]
          : eip155Chains.length > 0
            ? eip155Chains
            : ["eip155:1"];

        const session = await connector.connect({
          requiredNamespaces: {
            eip155: {
              chains: wcChains,
              methods: eip155Methods,
              events: eip155Events,
            },
          },
        });

        currentSession = session;
        currentChainId = parameters?.chainId ?? (chains.length > 0 ? chains[0].id : 1);

        const accounts = extractAccounts(session.namespaces).map(
          (a: string) => {
            const addr = a.split(":").pop();
            return `0x${addr!.replace(/^0x/, "")}` as `0x${string}`;
          },
        );

        emitter.emit("connect", { accounts, chainId: currentChainId ?? 1 });

        return {
          accounts,
          chainId: currentChainId,
        };
      },

      async disconnect(): Promise<void> {
        if (currentSession) {
          const connector = new WalletConnectConnector({
            projectId: config.projectId,
            metadata: config.metadata,
          });
          await connector.disconnect(currentSession);
          currentSession = undefined;
          currentChainId = undefined;
          emitter.emit("disconnect");
        }
      },

      async getAccounts(): Promise<readonly `0x${string}`[]> {
        if (!currentSession) return [];
        const accounts = extractAccounts(currentSession.namespaces).map(
          (a: string) => {
            const addr = a.split(":").pop();
            return `0x${addr!.replace(/^0x/, "")}` as `0x${string}`;
          },
        );
        return accounts;
      },

      async getChainId(): Promise<number> {
        if (currentChainId) return currentChainId;
        // Fallback: try to determine from session
        if (currentSession?.namespaces.eip155?.chains[0]) {
          const chainStr = currentSession.namespaces.eip155.chains[0];
          return Number(chainStr.split(":")[1]);
        }
        return chains.length > 0 ? chains[0].id : 1;
      },

      async isAuthorized(): Promise<boolean> {
        return currentSession !== undefined;
      },

      async switchChain({ chainId }: { chainId: number }): Promise<Chain> {
        const chain = [...chains].find(c => c.id === chainId);
        if (!chain) {
          throw new ChainNotConfiguredError();
        }

        if (currentSession) {
          const connector = new WalletConnectConnector({
            projectId: config.projectId,
            metadata: config.metadata,
          });
          try {
            await connector.switchChain(currentSession, `eip155:${chainId}`);
          } catch {
            throw new SwitchChainNotSupportedError({ connector: connector as any });
          }
        }

        currentChainId = chainId;

        emitter.emit("change", { chainId });

        return chain;
      },

      async onAccountsChanged(accounts: string[]): Promise<void> {
        if (accounts.length === 0) {
          emitter.emit("disconnect");
          return;
        }
        emitter.emit("change", { accounts: accounts as `0x${string}`[] });
      },

      onChainChanged(chainId: string): void {
        const newChainId = Number(chainId);
        if (!isNaN(newChainId)) {
          currentChainId = newChainId;
          emitter.emit("change", { chainId: newChainId });
        }
      },

      async onDisconnect(_error?: Error): Promise<void> {
        emitter.emit("disconnect");
      },

      async getProvider(): Promise<unknown> {
        const connector = new WalletConnectConnector({
          projectId: config.projectId,
          metadata: config.metadata,
        });
        return {
          connector,
          request: async ({
            method,
            params,
          }: {
            method: string;
            params?: unknown[];
          }) => {
            const session = currentSession;
            if (!session) {
              throw new WalletError("session_expired", "No active session.");
            }
            return connector.request({
              method,
              params: params ?? [],
            }) as Promise<unknown>;
          },
          on: () => {},
          removeListener: () => {},
        };
      },

      async setup(): Promise<void> {
        // Nothing to set up
      },
    };

    return wagmiConnector as unknown as ReturnType<CreateConnectorFn>;
  };
}

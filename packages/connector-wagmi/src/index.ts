import type { UniversalWalletSession } from "@naculus/connect-core";
import { WalletError } from "@naculus/connect-core";
import {
  type WalletConnectConfig,
  WalletConnectConnector,
} from "@naculus/connector-walletconnect";
import type { Chain } from "viem";
import {
  ChainNotConfiguredError,
  type Connector,
  type CreateConnectorFn,
  SwitchChainNotSupportedError,
} from "wagmi";

export type { WalletConnectConfig };

function extractEvmAccounts(
  session: UniversalWalletSession,
): readonly `0x${string}`[] {
  const accounts = session.namespaces.eip155?.accounts ?? [];
  return accounts.flatMap((account) => {
    const [namespace, , address] = account.split(":");
    if (
      namespace !== "eip155" ||
      !address ||
      !/^0x[a-fA-F0-9]{40}$/.test(address)
    )
      return [];
    return [`0x${address.replace(/^0x/i, "")}` as `0x${string}`];
  });
}

function assertChainId(chainId: number): number {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new WalletError(
      "chain_unsupported",
      `Invalid EIP-155 chain ID: ${chainId}`,
    );
  }
  return chainId;
}

function parseEip155ChainId(chainId: string): number {
  if (!/^eip155:[1-9][0-9]*$/.test(chainId)) {
    throw new WalletError(
      "chain_unsupported",
      `Invalid EIP-155 chain ID: ${chainId}`,
    );
  }
  const value = BigInt(chainId.slice("eip155:".length));
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new WalletError(
      "chain_unsupported",
      `EIP-155 chain ID exceeds wagmi's numeric range: ${chainId}`,
    );
  }
  return Number(value);
}

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
    let activeConnector: WalletConnectConnector | undefined;

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
        if (parameters?.chainId !== undefined)
          assertChainId(parameters.chainId);
        const connector = new WalletConnectConnector({
          projectId: config.projectId,
          metadata: config.metadata,
        });

        const requestedChainId = parameters?.chainId;
        if (requestedChainId === undefined && eip155Chains.length === 0) {
          throw new WalletError(
            "chain_unsupported",
            "Configure at least one EIP-155 chain before connecting.",
          );
        }
        if (
          requestedChainId !== undefined &&
          eip155Chains.length > 0 &&
          !eip155Chains.includes(`eip155:${requestedChainId}`)
        ) {
          throw new ChainNotConfiguredError();
        }
        const wcChains =
          requestedChainId !== undefined
            ? [`eip155:${requestedChainId}`]
            : eip155Chains;

        const session = await connector.connect({
          requiredNamespaces: {
            eip155: {
              chains: wcChains,
              methods: eip155Methods,
              events: eip155Events,
            },
          },
        });

        const sessionChains = session.namespaces.eip155?.chains ?? [];
        const selectedChain =
          requestedChainId !== undefined
            ? `eip155:${requestedChainId}`
            : sessionChains[0];
        if (!selectedChain || !sessionChains.includes(selectedChain)) {
          throw new WalletError(
            "namespace_mismatch",
            "WalletConnect session did not approve a requested EIP-155 chain.",
          );
        }
        const parsedChainId = parseEip155ChainId(selectedChain);
        currentSession = session;
        activeConnector = connector;
        currentChainId = parsedChainId;

        const accounts = extractEvmAccounts(session);

        emitter.emit("connect", { accounts, chainId: currentChainId });

        return {
          accounts,
          chainId: currentChainId,
        };
      },

      async disconnect(): Promise<void> {
        if (currentSession) {
          const connector =
            activeConnector ??
            new WalletConnectConnector({
              projectId: config.projectId,
              metadata: config.metadata,
            });
          await connector.disconnect(currentSession);
          currentSession = undefined;
          activeConnector = undefined;
          currentChainId = undefined;
          emitter.emit("disconnect");
        }
      },

      async getAccounts(): Promise<readonly `0x${string}`[]> {
        if (!currentSession) return [];
        const accounts = extractEvmAccounts(currentSession);
        return accounts;
      },

      async getChainId(): Promise<number> {
        if (currentChainId !== undefined) return currentChainId;
        // Fallback: try to determine from session
        if (currentSession?.namespaces.eip155?.chains[0]) {
          const chainStr = currentSession.namespaces.eip155.chains[0];
          return parseEip155ChainId(chainStr);
        }
        throw new WalletError(
          "session_expired",
          "No active WalletConnect session.",
        );
      },

      async isAuthorized(): Promise<boolean> {
        return currentSession !== undefined;
      },

      async switchChain({ chainId }: { chainId: number }): Promise<Chain> {
        assertChainId(chainId);
        const chain = [...chains].find((c) => c.id === chainId);
        if (!chain) {
          throw new ChainNotConfiguredError();
        }

        if (currentSession) {
          const connector =
            activeConnector ??
            new WalletConnectConnector({
              projectId: config.projectId,
              metadata: config.metadata,
            });
          try {
            await connector.switchChain(currentSession, `eip155:${chainId}`);
          } catch {
            throw new SwitchChainNotSupportedError({
              connector: connector as any,
            });
          }
        }

        currentChainId = chainId;

        emitter.emit("change", { chainId });

        return chain;
      },

      async onAccountsChanged(accounts: string[]): Promise<void> {
        accounts = accounts.filter((account) =>
          /^0x[a-fA-F0-9]{40}$/.test(account),
        );
        if (accounts.length === 0) {
          currentSession = undefined;
          activeConnector = undefined;
          currentChainId = undefined;
          emitter.emit("disconnect");
          return;
        }

        const namespace = currentSession?.namespaces.eip155;
        if (namespace) {
          const chainReference = namespace.chains[0]?.split(":")[1];
          if (!chainReference) return;
          namespace.accounts = accounts.map(
            (account) => `eip155:${chainReference}:${account}`,
          );
        }
        emitter.emit("change", { accounts: accounts as `0x${string}`[] });
      },

      onChainChanged(chainId: string): void {
        try {
          if (
            !/^(?:0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)|[1-9][0-9]*)$/.test(chainId)
          )
            return;
          const newChainId = Number(BigInt(chainId));
          if (Number.isSafeInteger(newChainId) && newChainId > 0) {
            currentChainId = newChainId;
            emitter.emit("change", { chainId: newChainId });
          }
        } catch {
          // Ignore malformed provider events; never persist a guessed chain.
        }
      },

      async onDisconnect(_error?: Error): Promise<void> {
        currentSession = undefined;
        activeConnector = undefined;
        currentChainId = undefined;
        emitter.emit("disconnect");
      },

      async getProvider(): Promise<unknown> {
        const providerConnector =
          activeConnector ??
          new WalletConnectConnector({
            projectId: config.projectId,
            metadata: config.metadata,
          });
        return {
          connector: providerConnector,
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
            const requestConnector = activeConnector;
            if (!requestConnector) {
              throw new WalletError("session_expired", "No active connector.");
            }
            return requestConnector.request({
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

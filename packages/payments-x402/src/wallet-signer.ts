import { recoverTypedDataSigner } from "@naculus/connect-core";
import type { X402TypedDataSigner } from "./evm-exact";
import { X402Error } from "./wire";

export interface X402Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface WalletX402SignerOptions {
  provider: X402Eip1193Provider;
  address: `0x${string}`;
  /** Switch the wallet to a canonical EIP-155 CAIP-2 chain. */
  switchChain: (chainId: string) => Promise<void>;
}

const TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * An x402 EIP-3009 signer backed by an external EIP-1193 wallet.
 *
 * Use this signer only with `createX402Fetch`, which supplies typed data built
 * by `buildTransferAuthorization`. Calling `signTypedData` with arbitrary
 * caller-built data is unsupported: this adapter does not provide an
 * independent policy or consent boundary.
 */
export function walletX402Signer(
  options: WalletX402SignerOptions,
): X402TypedDataSigner {
  const { provider, address, switchChain } = options;
  return {
    address,
    async signTypedData(request) {
      const expectedChain = request.domain.chainId;
      const chainId = await provider.request({ method: "eth_chainId" });
      if (Number(chainId) !== expectedChain) {
        await switchChain(`eip155:${expectedChain}`);
        const after = await provider.request({ method: "eth_chainId" });
        if (Number(after) !== expectedChain) {
          throw new X402Error(
            "invalid_input",
            `Wallet is on chain ${Number(after)}; the payment needs ${expectedChain}.`,
          );
        }
      }

      let result: unknown;
      try {
        result = await provider.request({
          method: "eth_signTypedData_v4",
          params: [address, JSON.stringify({ ...request, types: TYPES })],
        });
      } catch (cause) {
        if ((cause as { code?: unknown } | null)?.code === 4001) {
          throw new X402Error(
            "user_rejected",
            "The wallet rejected the payment.",
          );
        }
        throw cause;
      }

      if (typeof result !== "string" || result.length !== 132) {
        throw new X402Error(
          "invalid_input",
          "Smart-contract wallet signatures are not supported yet.",
        );
      }
      const signer = recoverTypedDataSigner(request, result);
      if (signer?.toLowerCase() !== address.toLowerCase()) {
        throw new X402Error(
          "invalid_input",
          signer
            ? `The wallet signed as ${signer}, not ${address}.`
            : "The wallet's signature could not be verified (only v = 27/28, low-s secp256k1 is accepted).",
        );
      }
      return result as `0x${string}`;
    },
  };
}

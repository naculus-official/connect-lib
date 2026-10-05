// Example for docs/guides/x402-server.md. Typechecked by the root
// `tsc --noEmit`; not shipped in any package.
import {
  requirePayment,
  settlePayment,
  type X402PaymentRequirements,
  type X402ServerDeps,
} from "@naculus/payments-x402/server";
import { createPublicClient, createWalletClient, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// What this resource costs: 0.01 USDC on Base Sepolia, paid to `payTo`.
const accepts: X402PaymentRequirements[] = [
  {
    scheme: "exact",
    network: "eip155:84532",
    amount: "10000", // atomic units; USDC has 6 decimals
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Circle test USDC
    payTo: "0x1111111111111111111111111111111111111111", // your address
    maxTimeoutSeconds: 120,
    // EIP-712 domain of the token, needed by the payer to sign.
    extra: { name: "USDC", version: "2" },
  },
];

// A read client for the chain you accept. `call` must reject when the call
// reverts (viem's does) and must be routed by `chainId`: add one client per
// chain if you accept several.
const reader = createPublicClient({ chain: baseSepolia, transport: http() });

// The facilitator account pays gas for transferWithAuthorization. It holds
// ETH, not the payment: the USDC moves from the payer straight to `payTo`.
const facilitator = createWalletClient({
  account: privateKeyToAccount(process.env.FACILITATOR_KEY as Hex),
  chain: baseSepolia,
  transport: http(),
});

const deps: X402ServerDeps = {
  rpc: {
    evm: {
      async call({ chainId, to, data }) {
        if (chainId !== baseSepolia.id) throw new Error("Unsupported chain.");
        const result = await reader.call({ to, data });
        return result.data ?? "0x";
      },
    },
  },
  // Resolve with the hash only once the transaction succeeded on chain;
  // throw on anything else. settlePayment reports success on that basis.
  async submit({ chainId, to, data }) {
    if (chainId !== baseSepolia.id) throw new Error("Unsupported chain.");
    const hash = await facilitator.sendTransaction({ to, data });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("Settlement reverted.");
    return hash;
  },
};

export async function handler(request: Request): Promise<Response> {
  const gate = await requirePayment(request, { accepts, deps });
  if (!gate.verified) return gate.response; // 402 + PAYMENT-REQUIRED, or 400

  // Verified is not paid. Settle first, then read `.success` on `settlement`,
  // never on the object settlePayment returns.
  const { settlement, header } = await settlePayment(gate.payment, deps);
  if (!settlement.success) {
    return new Response(
      JSON.stringify({ error: settlement.errorReason ?? "settlement failed" }),
      {
        status: 402,
        headers: {
          "content-type": "application/json",
          "PAYMENT-RESPONSE": header,
        },
      },
    );
  }
  return new Response(JSON.stringify({ report: "..." }), {
    headers: { "content-type": "application/json", "PAYMENT-RESPONSE": header },
  });
}

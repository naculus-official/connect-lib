import {
  type SessionKeyTypedDataRequest,
  sessionKeyAddress,
  typedDataDigest,
} from "@naculus/connect-core";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it, vi } from "vitest";
import {
  createX402Fetch,
  decodeHeader,
  encodeHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  walletX402Signer,
  type X402Eip1193Provider,
  type X402PaymentRequirements,
} from "./index";

const KEY = new Uint8Array(32).fill(4);
const OTHER_KEY = new Uint8Array(32).fill(7);
const ADDRESS = sessionKeyAddress(
  `0x${bytesToHex(secp256k1.getPublicKey(KEY, true))}`,
);
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const PAYEE = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C" as const;

const request: SessionKeyTypedDataRequest = {
  domain: {
    name: "USDC",
    version: "2",
    chainId: 84532,
    verifyingContract: TOKEN,
  },
  primaryType: "TransferWithAuthorization",
  message: {
    from: ADDRESS,
    to: PAYEE,
    value: "10000",
    validAfter: "1799999400",
    validBefore: "1800000060",
    nonce: `0x${"ab".repeat(32)}`,
  },
};

function signRequest(
  typedData: SessionKeyTypedDataRequest,
  key = KEY,
): `0x${string}` {
  const raw = secp256k1.sign(
    hexToBytes(typedDataDigest(typedData).slice(2)),
    key,
    { prehash: false, format: "recovered" },
  );
  return `0x${bytesToHex(raw.subarray(1))}${((raw[0] as number) + 27).toString(16)}`;
}

function sign(key = KEY): `0x${string}` {
  return signRequest(request, key);
}

function provider(
  chains: string[],
  signature:
    | unknown
    | ((request: SessionKeyTypedDataRequest) => unknown) = sign(),
): X402Eip1193Provider & { request: ReturnType<typeof vi.fn> } {
  return {
    request: vi.fn(
      async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_chainId") return chains.shift() ?? "0x14a34";
        if (method === "eth_signTypedData_v4") {
          const typedData = JSON.parse(String(params?.[1]));
          const { types: _types, ...unsigned } = typedData;
          return typeof signature === "function"
            ? signature(unsigned)
            : signature;
        }
        throw new Error(`Unexpected method ${method}`);
      },
    ),
  };
}

describe("walletX402Signer", () => {
  it("signs the specified typed data on the right chain", async () => {
    const wallet = provider(["0x14a34"]);
    const switchChain = vi.fn();

    await expect(
      walletX402Signer({
        provider: wallet,
        address: ADDRESS,
        switchChain,
      }).signTypedData(request),
    ).resolves.toBe(sign());
    expect(switchChain).not.toHaveBeenCalled();
    expect(wallet.request).toHaveBeenLastCalledWith({
      method: "eth_signTypedData_v4",
      params: [ADDRESS, expect.any(String)],
    });
    const typedData = JSON.parse(wallet.request.mock.calls[1][0].params[1]);
    expect(typedData).toEqual({
      ...request,
      types: {
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
      },
    });
  });

  it("switches before signing when another chain is active", async () => {
    const wallet = provider(["0x1", "0x14a34"]);
    const switchChain = vi.fn().mockResolvedValue(undefined);
    await walletX402Signer({
      provider: wallet,
      address: ADDRESS,
      switchChain,
    }).signTypedData(request);
    expect(switchChain).toHaveBeenCalledWith("eip155:84532");
    expect(wallet.request.mock.calls.map(([args]) => args.method)).toEqual([
      "eth_chainId",
      "eth_chainId",
      "eth_signTypedData_v4",
    ]);
  });

  it("refuses when switching does not change the active chain", async () => {
    const wallet = provider(["0x1", "0x1"]);
    await expect(
      walletX402Signer({
        provider: wallet,
        address: ADDRESS,
        switchChain: vi.fn(),
      }).signTypedData(request),
    ).rejects.toMatchObject({ name: "X402Error", code: "invalid_input" });
    expect(wallet.request).toHaveBeenCalledTimes(2);
  });

  it("refuses a signature from another account", async () => {
    await expect(
      walletX402Signer({
        provider: provider(["0x14a34"], sign(OTHER_KEY)),
        address: ADDRESS,
        switchChain: vi.fn(),
      }).signTypedData(request),
    ).rejects.toThrow(/The wallet signed as 0x[0-9a-fA-F]{40}, not /);
  });

  it("maps provider error 4001 without retrying", async () => {
    const wallet = provider(["0x14a34"]);
    wallet.request.mockResolvedValueOnce("0x14a34").mockRejectedValueOnce({
      code: 4001,
    });
    await expect(
      walletX402Signer({
        provider: wallet,
        address: ADDRESS,
        switchChain: vi.fn(),
      }).signTypedData(request),
    ).rejects.toMatchObject({ name: "X402Error", code: "user_rejected" });
    expect(wallet.request).toHaveBeenCalledTimes(2);
  });

  it("refuses non-65-byte smart-contract wallet signatures", async () => {
    await expect(
      walletX402Signer({
        provider: provider(["0x14a34"], "0x1234"),
        address: ADDRESS,
        switchChain: vi.fn(),
      }).signTypedData(request),
    ).rejects.toThrow(/Smart-contract wallet signatures are not supported yet/);
  });

  it("pays end to end through createX402Fetch", async () => {
    const requirement: X402PaymentRequirements = {
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: TOKEN,
      payTo: PAYEE,
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    };
    const seen: Request[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const incoming = input as Request;
      seen.push(incoming);
      if (!incoming.headers.has(PAYMENT_SIGNATURE_HEADER)) {
        return new Response(null, {
          status: 402,
          headers: {
            [PAYMENT_REQUIRED_HEADER]: encodeHeader({
              x402Version: 2,
              resource: { url: "https://api.example.com/data" },
              accepts: [requirement],
            }),
          },
        });
      }
      return new Response("paid");
    });
    const result = await createX402Fetch({
      signer: walletX402Signer({
        provider: provider(
          ["0x14a34"],
          (typedData: SessionKeyTypedDataRequest) => signRequest(typedData),
        ),
        address: ADDRESS,
        switchChain: vi.fn(),
      }),
      fetch: fetch as typeof globalThis.fetch,
    })("https://api.example.com/data");

    expect(await result.response.text()).toBe("paid");
    const payload = decodeHeader(
      seen[1].headers.get(PAYMENT_SIGNATURE_HEADER) ?? "",
    ) as { payload: { signature: string; authorization: { from: string } } };
    expect(payload.payload.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(payload.payload.authorization.from).toBe(ADDRESS);
  });
});

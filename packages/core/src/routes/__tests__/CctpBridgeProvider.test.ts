import { describe, expect, it, vi } from "vitest";
import { CCTP_V2 } from "../constants";
import {
  CctpBridgeProvider,
  cctpMaxFee,
  cctpMintRecipient,
  encodeCctpApprove,
  encodeCctpDepositForBurn,
  encodeCctpReceiveMessage,
  waitForCctpAttestation,
} from "../providers/CctpBridgeProvider";

// Independent oracle: produced by viem's encodeFunctionData against Circle's
// TokenMessengerV2 / MessageTransmitterV2 ABIs, outside this test run (viem
// is stubbed in vitest). The hand-written encoder must match byte for byte.
// approve(TokenMessengerV2 testnet, 1_050_000)
// depositForBurnWithHook(1_050_000, 6, pad(RECIPIENT), Sepolia USDC, 0, 50_000, 1000, FORWARD)
// depositForBurn(same, no hook); receiveMessage(0xab x45, 0xcd x65)
// viem keeps the checksum case inside bytes32; compare case-insensitively.
const VECTORS = {
  approve:
    "0x095ea7b30000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa0000000000000000000000000000000000000000000000000000000000100590",
  withHook:
    "0x779b432d00000000000000000000000000000000000000000000000000000000001005900000000000000000000000000000000000000000000000000000000000000006000000000000000000000000f24863dBA9260d88620cb0573b3C02860287e62b0000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c72380000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c35000000000000000000000000000000000000000000000000000000000000003e800000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000020636374702d666f72776172640000000000000000000000000000000000000000",
  plain:
    "0x8e0250ee00000000000000000000000000000000000000000000000000000000001005900000000000000000000000000000000000000000000000000000000000000006000000000000000000000000f24863dBA9260d88620cb0573b3C02860287e62b0000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c72380000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c35000000000000000000000000000000000000000000000000000000000000003e8",
  receive:
    "0x57ecfd28000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000002dababababababababababababababababababababababababababababababababababababababababababababab000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000041cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd00000000000000000000000000000000000000000000000000000000000000",
} as const;
const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const RECIPIENT = "0xf24863dBA9260d88620cb0573b3C02860287e62b";

describe("CCTP calldata", () => {
  it("approve matches viem and is never unlimited", () => {
    expect(encodeCctpApprove(CCTP_V2.tokenMessenger.testnet, 1_050_000n)).toBe(
      VECTORS.approve,
    );
    expect(() =>
      encodeCctpApprove(CCTP_V2.tokenMessenger.testnet, (1n << 256n) - 1n),
    ).toThrow(/exact/);
    expect(() =>
      encodeCctpApprove(CCTP_V2.tokenMessenger.testnet, 0n),
    ).toThrow();
  });

  it("depositForBurnWithHook matches viem, forwarding hook included", () => {
    const params = {
      amount: 1_050_000n,
      destinationDomain: 6,
      mintRecipient: RECIPIENT,
      burnToken: SEPOLIA_USDC,
      maxFee: 50_000n,
      minFinalityThreshold: 1000,
    };
    expect(
      encodeCctpDepositForBurn({
        ...params,
        hookData: CCTP_V2.forwardHookData,
      }).toLowerCase(),
    ).toBe(VECTORS.withHook.toLowerCase());
    expect(encodeCctpDepositForBurn(params).toLowerCase()).toBe(
      VECTORS.plain.toLowerCase(),
    );
  });

  it("receiveMessage matches viem for odd-length bytes", () => {
    const message = `0x${"ab".repeat(45)}` as const;
    const attestation = `0x${"cd".repeat(65)}` as const;
    expect(encodeCctpReceiveMessage(message, attestation)).toBe(
      VECTORS.receive,
    );
  });

  it("pads the mint recipient and refuses zero or invalid addresses", () => {
    expect(cctpMintRecipient(RECIPIENT)).toBe(
      `0x${"0".repeat(24)}${RECIPIENT.slice(2).toLowerCase()}`,
    );
    expect(() =>
      cctpMintRecipient("0x0000000000000000000000000000000000000000"),
    ).toThrow(/zero/);
    expect(() => cctpMintRecipient("not-an-address")).toThrow();
  });

  it("refuses a maxFee that eats the whole burn", () => {
    expect(() =>
      encodeCctpDepositForBurn({
        amount: 100n,
        destinationDomain: 6,
        mintRecipient: RECIPIENT,
        burnToken: SEPOLIA_USDC,
        maxFee: 100n,
        minFinalityThreshold: 1000,
      }),
    ).toThrow(/maxFee/);
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const FEES = [
  {
    finalityThreshold: 1000,
    minimumFee: 1.3,
    forwardFee: { low: "40000", med: "50000", high: "60000" },
  },
  {
    finalityThreshold: 2000,
    minimumFee: 0,
    forwardFee: { low: "40000", med: "50000", high: "60000" },
  },
];

describe("CctpBridgeProvider.estimate", () => {
  const usdc = (chainId: number, address: string) => ({
    chainId,
    address,
    decimals: 6,
    symbol: "USDC",
  });
  const base = {
    amount: 2_000_000n,
    fromChain: { chainId: 11155111 },
    toChain: { chainId: 84532 },
    fromToken: usdc(11155111, SEPOLIA_USDC),
    toToken: usdc(84532, BASE_SEPOLIA_USDC),
    recipient: RECIPIENT,
  };

  it("quotes fast forwarding and builds approve + burn steps", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(FEES));
    const quote = await new CctpBridgeProvider({ fetch: fetchMock }).estimate(
      base,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/0/6?forward=true",
    );
    const maxFee = cctpMaxFee(2_000_000n, {
      finalityThreshold: 1000,
      minimumFee: 1.3,
      forwardFee: 50_000n,
    });
    expect(maxFee).toBe(50_260n);
    expect(quote.outputAmount).toBe(2_000_000n - maxFee);
    expect(quote.steps).toHaveLength(2);
    expect(quote.steps[0].transaction?.to).toBe(SEPOLIA_USDC);
    expect(quote.steps[0].transaction?.data).toBe(
      encodeCctpApprove(CCTP_V2.tokenMessenger.testnet, 2_000_000n),
    );
    expect(quote.steps[1].transaction).toMatchObject({
      to: CCTP_V2.tokenMessenger.testnet,
      chainId: 11155111,
    });
    expect(quote.steps[1].transaction?.data.slice(0, 10)).toBe(
      VECTORS.withHook.slice(0, 10),
    );
  });

  it.each([
    ["no recipient", { recipient: undefined }, /recipient/],
    [
      "a non-USDC token",
      { fromToken: usdc(11155111, RECIPIENT) },
      /native USDC/,
    ],
    [
      "testnet to mainnet",
      {
        toChain: { chainId: 8453 },
        toToken: usdc(8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
      },
      /testnet and mainnet/,
    ],
    [
      "a chain without a domain",
      { toChain: { chainId: 56 }, toToken: usdc(56, BASE_SEPOLIA_USDC) },
      /./,
    ],
    ["an amount below the fees", { amount: 50_000n }, /cover the fees/],
  ])("refuses %s", async (_name, override, pattern) => {
    const provider = new CctpBridgeProvider({
      fetch: async () => jsonResponse(FEES),
    });
    await expect(provider.estimate({ ...base, ...override })).rejects.toThrow(
      pattern,
    );
  });

  it("refuses a malformed fee quote rather than assuming zero", async () => {
    const provider = new CctpBridgeProvider({
      fetch: async () => jsonResponse([{ finalityThreshold: 1000 }]),
    });
    await expect(provider.estimate(base)).rejects.toThrow(/fee/);
  });

  it("uses Standard transfer from a chain without Fast Transfer (Polygon)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(FEES));
    const polygonUsdc = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
    const quote = await new CctpBridgeProvider({ fetch: fetchMock }).estimate({
      ...base,
      fromChain: { chainId: 137 },
      fromToken: usdc(137, polygonUsdc),
      toChain: { chainId: 8453 },
      toToken: usdc(8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    });
    expect(quote.steps[1].transaction?.data).toContain(
      (2000).toString(16).padStart(64, "0"),
    );
  });
});

describe("waitForCctpAttestation", () => {
  const txHash = `0x${"11".repeat(32)}`;

  it("polls through 404 and pending until complete", async () => {
    const responses = [
      jsonResponse({}, 404),
      jsonResponse({ messages: [{ status: "pending_confirmations" }] }),
      jsonResponse({
        messages: [
          { status: "complete", message: "0xabcd", attestation: "0xef01" },
        ],
      }),
    ];
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        responses.shift() as Response,
    );
    const result = await waitForCctpAttestation({
      sourceChainId: 11155111,
      txHash,
      fetch: fetchMock,
      sleep: async () => {},
    });
    expect(result).toMatchObject({
      status: "complete",
      message: "0xabcd",
      attestation: "0xef01",
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://iris-api-sandbox.circle.com/v2/messages/0?transactionHash=${txHash}`,
    );
  });

  it("times out instead of resolving partially", async () => {
    await expect(
      waitForCctpAttestation({
        sourceChainId: 11155111,
        txHash,
        timeoutMs: 1,
        intervalMs: 10,
        fetch: async () =>
          jsonResponse({ messages: [{ status: "pending_confirmations" }] }),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/not complete/);
  });

  it("refuses a complete entry without bytes, and server errors", async () => {
    await expect(
      waitForCctpAttestation({
        sourceChainId: 11155111,
        txHash,
        fetch: async () => jsonResponse({ messages: [{ status: "complete" }] }),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/message bytes/);
    await expect(
      waitForCctpAttestation({
        sourceChainId: 11155111,
        txHash,
        fetch: async () => jsonResponse({}, 500),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/500/);
  });
});

describe("CCTP review fixes (2026-10-05)", () => {
  it("M1: ceils the protocol fee to a whole base unit", () => {
    expect(
      cctpMaxFee(1n, {
        finalityThreshold: 1000,
        minimumFee: 1.3,
        forwardFee: 0n,
      }),
    ).toBe(1n);
    expect(
      cctpMaxFee(1_000_000n, {
        finalityThreshold: 1000,
        minimumFee: 1.3,
        forwardFee: 0n,
      }),
    ).toBe(130n);
    expect(() =>
      cctpMaxFee(1n, {
        finalityThreshold: 1000,
        minimumFee: 1.234,
        forwardFee: 0n,
      }),
    ).toThrow(/hundredths/);
  });

  it("M2: a request that never settles is aborted at the deadline", async () => {
    let aborted = false;
    const hanging = (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    await expect(
      waitForCctpAttestation({
        sourceChainId: 11155111,
        txHash: `0x${"22".repeat(32)}`,
        timeoutMs: 50,
        intervalMs: 10,
        fetch: hanging as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/not complete within 50 ms/);
    expect(aborted).toBe(true);
  });

  it("L1: refuses a transaction with more than one CCTP message", async () => {
    await expect(
      waitForCctpAttestation({
        sourceChainId: 11155111,
        txHash: `0x${"33".repeat(32)}`,
        fetch: async () =>
          jsonResponse({
            messages: [
              { status: "complete", message: "0xaa", attestation: "0xbb" },
              { status: "complete", message: "0xcc", attestation: "0xdd" },
            ],
          }),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/more than one/);
  });

  it("L2: refuses values outside uint32", () => {
    const base = {
      amount: 1_000_000n,
      destinationDomain: 6,
      mintRecipient: RECIPIENT,
      burnToken: SEPOLIA_USDC,
      maxFee: 1n,
      minFinalityThreshold: 1000,
    };
    expect(() =>
      encodeCctpDepositForBurn({ ...base, destinationDomain: 0x1_0000_0000 }),
    ).toThrow(/domain/);
    expect(() =>
      encodeCctpDepositForBurn({ ...base, minFinalityThreshold: -1 }),
    ).toThrow(/minFinalityThreshold/);
    expect(() =>
      encodeCctpDepositForBurn({ ...base, destinationDomain: 0xffff_ffff }),
    ).not.toThrow();
  });
});

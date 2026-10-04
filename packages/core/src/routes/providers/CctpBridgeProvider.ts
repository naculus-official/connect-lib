/**
 * Circle CCTP V2: burn native USDC on the source chain, Circle mints native
 * USDC on the destination (docs/design/cctp-bridge.md). With the Forwarding
 * Service (default) Circle also submits the destination mint, so the user
 * needs no gas there.
 *
 * This provider only quotes and builds calldata. It never signs or sends:
 * the steps run through EVMRouteExecutor or the app's wallet.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { isValidAddress } from "../../address-validation";
import { CHAINS } from "../../chain-registry";
import { CCTP_V2 } from "../constants";
import type { BridgeProvider, Route, RouteQuote, Token } from "../types";
import { RouteEngineError } from "../types";

type Hex = `0x${string}`;

function selector(signature: string): string {
  return bytesToHex(keccak_256(utf8ToBytes(signature))).slice(0, 8);
}

const APPROVE = selector("approve(address,uint256)");
const DEPOSIT_FOR_BURN = selector(
  "depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)",
);
const DEPOSIT_FOR_BURN_WITH_HOOK = selector(
  "depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)",
);
const RECEIVE_MESSAGE = selector("receiveMessage(bytes,bytes)");
const UINT256_MAX = (1n << 256n) - 1n;
const ZERO_WORD = "0".repeat(64);

function refuse(message: string): never {
  throw new RouteEngineError("no_routes_available", `CCTP: ${message}`);
}

function word(value: bigint): string {
  if (typeof value !== "bigint" || value < 0n || value > UINT256_MAX) {
    refuse("a value is not a uint256");
  }
  return value.toString(16).padStart(64, "0");
}

function addressWord(address: string, what: string): string {
  if (!isValidAddress(address, "eip155"))
    refuse(`${what} is not an EVM address`);
  return address.slice(2).toLowerCase().padStart(64, "0");
}

/** A dynamic `bytes` argument's tail: length word + data right-padded to 32. */
function bytesTail(hex: string): string {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) refuse("bytes are not hex");
  const data = hex.slice(2).toLowerCase();
  const padded = data.padEnd(Math.ceil(data.length / 64) * 64, "0");
  return word(BigInt(data.length / 2)) + padded;
}

/** `bytes32` mint recipient: a non-zero EVM address, left-padded. */
export function cctpMintRecipient(recipient: string): Hex {
  const padded = addressWord(recipient, "the mint recipient");
  if (padded === ZERO_WORD) refuse("the mint recipient is the zero address");
  return `0x${padded}`;
}

/** USDC `approve(TokenMessengerV2, amount)` — exact, never unlimited. */
export function encodeCctpApprove(spender: string, amount: bigint): Hex {
  if (amount <= 0n || amount === UINT256_MAX) {
    refuse("approve amount must be exact and positive");
  }
  return `0x${APPROVE}${addressWord(spender, "the spender")}${word(amount)}`;
}

export interface CctpBurnParams {
  amount: bigint;
  destinationDomain: number;
  mintRecipient: string;
  burnToken: string;
  maxFee: bigint;
  minFinalityThreshold: number;
  /** Forwarding Service hook, or omitted for a plain depositForBurn. */
  hookData?: Hex;
}

export function encodeCctpDepositForBurn(p: CctpBurnParams): Hex {
  if (p.amount <= 0n) refuse("burn amount must be positive");
  if (p.maxFee < 0n || p.maxFee >= p.amount) {
    refuse("maxFee must be below the burn amount");
  }
  if (!Number.isInteger(p.destinationDomain) || p.destinationDomain < 0) {
    refuse("invalid destination domain");
  }
  const head = [
    word(p.amount),
    word(BigInt(p.destinationDomain)),
    cctpMintRecipient(p.mintRecipient).slice(2),
    addressWord(p.burnToken, "the burn token"),
    ZERO_WORD, // destinationCaller = 0: anyone (or the Forwarding Service) mints
    word(p.maxFee),
    word(BigInt(p.minFinalityThreshold)),
  ];
  if (p.hookData === undefined) {
    return `0x${DEPOSIT_FOR_BURN}${head.join("")}`;
  }
  const offset = word(BigInt((head.length + 1) * 32));
  return `0x${DEPOSIT_FOR_BURN_WITH_HOOK}${head.join("")}${offset}${bytesTail(p.hookData)}`;
}

/** MessageTransmitterV2 `receiveMessage(message, attestation)` (no forwarding). */
export function encodeCctpReceiveMessage(message: Hex, attestation: Hex): Hex {
  const first = bytesTail(message);
  const second = bytesTail(attestation);
  const head = word(64n) + word(BigInt(64 + first.length / 2));
  return `0x${RECEIVE_MESSAGE}${head}${first}${second}`;
}

// ─── Fees and attestation (Circle Iris API) ───────────────────────────

type Fetch = typeof fetch;

export interface CctpFeeQuote {
  finalityThreshold: number;
  /** Protocol fee in basis points (may be fractional). */
  minimumFee: number;
  /** Forwarding Service fee in USDC base units (`med` level). */
  forwardFee: bigint;
}

function network(chainId: number): "mainnet" | "testnet" {
  return CCTP_V2.testnetChainIds.includes(chainId) ? "testnet" : "mainnet";
}

function domainOf(chainId: number): number {
  const domain = CCTP_V2.domains[chainId];
  if (domain === undefined) refuse(`chain ${chainId} has no CCTP domain`);
  return domain;
}

export async function fetchCctpFee(
  fromChainId: number,
  toChainId: number,
  finalityThreshold: number,
  options: { forward: boolean; fetch?: Fetch },
): Promise<CctpFeeQuote> {
  const base = CCTP_V2.irisApi[network(fromChainId)];
  const url = `${base}/v2/burn/USDC/fees/${domainOf(fromChainId)}/${domainOf(toChainId)}${options.forward ? "?forward=true" : ""}`;
  const response = await (options.fetch ?? fetch)(url);
  if (!response.ok) refuse(`fee quote failed (${response.status})`);
  const body: unknown = await response.json();
  const entry = Array.isArray(body)
    ? body.find(
        (e) =>
          typeof e === "object" &&
          e !== null &&
          (e as { finalityThreshold?: unknown }).finalityThreshold ===
            finalityThreshold,
      )
    : undefined;
  const minimumFee = (entry as { minimumFee?: unknown } | undefined)
    ?.minimumFee;
  if (
    typeof minimumFee !== "number" ||
    !Number.isFinite(minimumFee) ||
    minimumFee < 0
  ) {
    refuse(`no valid fee quote for finality ${finalityThreshold}`);
  }
  let forwardFee = 0n;
  if (options.forward) {
    const med = (entry as { forwardFee?: { med?: unknown } }).forwardFee?.med;
    if (
      (typeof med !== "number" && typeof med !== "string") ||
      !/^\d+$/.test(String(med))
    ) {
      refuse("no valid forwarding fee in the quote");
    }
    forwardFee = BigInt(String(med));
  }
  return { finalityThreshold, minimumFee, forwardFee };
}

/** maxFee covering the protocol fee (bps of the burn) and the forward fee. */
export function cctpMaxFee(amount: bigint, quote: CctpFeeQuote): bigint {
  const protocol =
    (amount * BigInt(Math.ceil(quote.minimumFee * 100))) / 1_000_000n;
  return protocol + quote.forwardFee;
}

export interface CctpAttestation {
  status: "complete";
  message: Hex;
  attestation: Hex;
  /** Raw message entry, including forwarding fields when present. */
  raw: Record<string, unknown>;
}

/**
 * Poll Iris until the burn's attestation is complete. Bounded: throws on
 * timeout or a malformed response; never resolves with a partial result.
 */
export async function waitForCctpAttestation(options: {
  sourceChainId: number;
  txHash: string;
  timeoutMs?: number;
  intervalMs?: number;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<CctpAttestation> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(options.txHash)) refuse("invalid tx hash");
  const base = CCTP_V2.irisApi[network(options.sourceChainId)];
  const url = `${base}/v2/messages/${domainOf(options.sourceChainId)}?transactionHash=${options.txHash}`;
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  const intervalMs = options.intervalMs ?? 5_000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await (options.fetch ?? fetch)(url);
    if (response.ok) {
      const body = (await response.json()) as { messages?: unknown };
      const entry = Array.isArray(body.messages) ? body.messages[0] : undefined;
      if (typeof entry === "object" && entry !== null) {
        const m = entry as Record<string, unknown>;
        if (m.status === "complete") {
          const hex = /^0x([0-9a-fA-F]{2})+$/;
          if (
            typeof m.message !== "string" ||
            !hex.test(m.message) ||
            typeof m.attestation !== "string" ||
            !hex.test(m.attestation)
          ) {
            refuse("complete attestation without message bytes");
          }
          return {
            status: "complete",
            message: m.message as Hex,
            attestation: m.attestation as Hex,
            raw: m,
          };
        }
      }
    } else if (response.status !== 404) {
      refuse(`attestation request failed (${response.status})`);
    }
    if (Date.now() + intervalMs > deadline) {
      refuse(`attestation not complete within ${timeoutMs} ms`);
    }
    await sleep(intervalMs);
  }
}

export { CCTP_V2 } from "../constants";

// ─── Provider ─────────────────────────────────────────────────────────

export interface CctpBridgeProviderConfig {
  /** Circle mints on the destination for a fee (default true). */
  forward?: boolean;
  /** Fast (default, seconds) or Standard (hard finality) transfer. */
  transfer?: "fast" | "standard";
  fetch?: Fetch;
}

function nativeUsdc(chainId: number, token: Token, side: string): string {
  const usdc = CHAINS[chainId]?.usdcAddress;
  if (!usdc || CHAINS[chainId]?.usdcVariant !== "native") {
    refuse(`chain ${chainId} has no native USDC in the registry`);
  }
  if (
    token.chainId !== chainId ||
    token.address.toLowerCase() !== usdc.toLowerCase()
  ) {
    refuse(`the ${side} token is not native USDC on chain ${chainId}`);
  }
  return usdc;
}

export class CctpBridgeProvider implements BridgeProvider {
  readonly name = "cctp";
  private readonly config: CctpBridgeProviderConfig;

  constructor(config: CctpBridgeProviderConfig = {}) {
    this.config = config;
  }

  /**
   * `amount` is what leaves the user's wallet (burned). The recipient
   * receives at least `amount - maxFee` (`outputAmount`); Circle may charge
   * less than maxFee.
   */
  async estimate(params: {
    amount: bigint;
    fromChain: { chainId: number };
    toChain: { chainId: number };
    fromToken: Token;
    toToken: Token;
    recipient?: string;
  }): Promise<RouteQuote> {
    const from = params.fromChain.chainId;
    const to = params.toChain.chainId;
    if (from === to) refuse("source and destination are the same chain");
    if (network(from) !== network(to)) refuse("mixes testnet and mainnet");
    const sourceUsdc = nativeUsdc(from, params.fromToken, "source");
    nativeUsdc(to, params.toToken, "destination");
    if (!params.recipient) refuse("a recipient is required");
    const forward = this.config.forward ?? true;
    const fast =
      (this.config.transfer ?? "fast") === "fast" &&
      !CCTP_V2.fastSourceUnsupported.includes(from);
    const finality = fast ? CCTP_V2.finality.fast : CCTP_V2.finality.standard;
    const quote = await fetchCctpFee(from, to, finality, {
      forward,
      fetch: this.config.fetch,
    });
    const maxFee = cctpMaxFee(params.amount, quote);
    if (params.amount <= maxFee) refuse("amount does not cover the fees");
    const tokenMessenger = CCTP_V2.tokenMessenger[network(from)] as Hex;
    const approve = encodeCctpApprove(tokenMessenger, params.amount);
    const burn = encodeCctpDepositForBurn({
      amount: params.amount,
      destinationDomain: domainOf(to),
      mintRecipient: params.recipient,
      burnToken: sourceUsdc,
      maxFee,
      minFinalityThreshold: finality,
      ...(forward ? { hookData: CCTP_V2.forwardHookData as Hex } : {}),
    });
    const outputAmount = params.amount - maxFee;
    return {
      totalCost: 0n,
      outputAmount,
      estimatedTimeMs: fast ? 60_000 : 20 * 60_000,
      slippage: 0,
      provider: this.name,
      steps: [
        {
          type: "transfer",
          fromToken: params.fromToken,
          toToken: params.fromToken,
          amount: params.amount,
          estimatedGas: 60_000n,
          description: `Approve exactly ${params.amount} USDC base units for CCTP TokenMessengerV2`,
          transaction: { to: sourceUsdc as Hex, data: approve, chainId: from },
        },
        {
          type: "bridge",
          fromToken: params.fromToken,
          toToken: params.toToken,
          amount: params.amount,
          estimatedGas: 200_000n,
          description: `Burn on CCTP domain ${domainOf(from)}; ${forward ? "Circle mints" : "mint with receiveMessage"} at least ${outputAmount} on domain ${domainOf(to)} (max fee ${maxFee})`,
          transaction: { to: tokenMessenger, data: burn, chainId: from },
        },
      ],
    };
  }

  async execute(_route: Route): Promise<{ txHash: string }> {
    throw new RouteEngineError(
      "execution_failed",
      "CCTP steps run through RouteEngine.executeRoute with an EVMRouteExecutor; then waitForCctpAttestation",
    );
  }
}

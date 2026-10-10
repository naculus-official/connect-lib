import {
  assertSolanaCluster,
  assertTrustedChannelProgram,
  buildOpenChannelTransaction,
  buildRequestCloseChannelTransaction,
  buildSealChannelTransaction,
  buildWithdrawPayerChannelTransaction,
  type ChannelMintAccount,
  type ChannelVoucherKeyManager,
  deriveChannelPda,
  isValidAddress,
  parseSolanaTransaction,
  readMint,
  SOLANA_DEVNET,
  SOLANA_MAINNET,
  SOLANA_PROGRAMS,
  type SolanaPaymentRpc,
  type TrustedChannelProgram,
  verifySignedChannelOpen,
  verifySolanaSignature,
} from "@naculus/connect-core";
import type { MppSolanaSigner } from "./solana-charge";
import {
  encodeCredential,
  isRecord,
  type MppChallenge,
  MppError,
  type MppReceipt,
  PAYMENT_RECEIPT_HEADER,
  parsePaymentChallenges,
  parsePaymentReceipt,
  WWW_AUTHENTICATE_HEADER,
} from "./wire";

const U64_MAX = (1n << 64n) - 1n;
const DEFAULT_MINIMUM_GRACE_PERIOD_SECONDS = 3_600;
const NETWORKS: Readonly<Record<string, string>> = {
  mainnet: SOLANA_MAINNET,
  devnet: SOLANA_DEVNET,
};

export interface MppSessionRpc extends SolanaPaymentRpc {
  /** Check the server-provided blockhash against the app's RPC. */
  isBlockhashValid(blockhash: string): Promise<boolean>;
}

export interface MppSessionPolicy {
  /** Exact server/payee the app permits. */
  recipient: string;
  /**
   * SPL mint the app pays with. The challenge must name exactly this mint;
   * every other limit here is in base units of it.
   */
  mint: string;
  /** Exact price per metered unit, in token base units. */
  amount: bigint;
  /** Initial token deposit. */
  deposit: bigint;
  /** Local lifetime spend ceiling; must not exceed the deposit. */
  maxCumulative: bigint;
  /** Local ceiling for one voucher update. */
  maxDelta: bigint;
  /** Unix seconds. Must outlast the channel grace period. */
  expiresAt: number;
  /** Defaults to one hour. */
  minimumGracePeriodSeconds?: number;
}

export interface MppSessionFetchOptions {
  rpc: MppSessionRpc;
  signer: MppSolanaSigner;
  keyManager: ChannelVoucherKeyManager;
  policy: MppSessionPolicy;
  /** Explicit address + deployment pin for a custom reviewed program. */
  trustProgram?: TrustedChannelProgram;
  fetch?: typeof fetch;
  /** The only broadcast path used by forceClose(). */
  sendTransaction?: (transaction: Uint8Array) => Promise<string>;
}

export interface MppSessionRequestInit extends RequestInit {
  /** Units consumed by this request. Mutually exclusive with meter.add(). */
  units?: bigint;
}

export interface MppSessionMeter {
  add(units: bigint): void;
  readonly pending: bigint;
}

export interface MppOpenChannel {
  cluster: string;
  channelId: string;
  payer: string;
  payee: string;
  mint: string;
  channelProgram: string;
  deposit: bigint;
  gracePeriodSeconds: number;
  openSlot: bigint;
  salt: bigint;
}

export interface MppSessionSettlementBinding {
  cluster: string;
  channelId: string;
  channelProgram: string;
  expectedSettled: string;
  afterForcedClose?: boolean;
}

export interface MppSessionFetchResult {
  response: Response;
  receipt: MppReceipt | null;
  channel: MppOpenChannel | null;
  /** Present on cooperative close once the final voucher was sent. */
  settlementBinding?: MppSessionSettlementBinding;
}

export interface MppForceCloseResult {
  requestCloseTxHash: string;
  settlementBinding: MppSessionSettlementBinding;
  /** Seal the channel once its grace period has elapsed, then withdraw the payer's remainder. */
  withdrawPayer(): Promise<string>;
}

export interface MppSessionFetch {
  (
    input: RequestInfo | URL,
    init?: MppSessionRequestInit,
  ): Promise<MppSessionFetchResult>;
  readonly meter: MppSessionMeter;
  readonly channels: readonly MppOpenChannel[];
  close(): Promise<MppSessionFetchResult>;
  forceClose(): Promise<MppForceCloseResult>;
}

interface SessionRequest {
  amount: bigint;
  currency: string;
  recipient: string;
  cluster: string;
  channelProgram: string;
  recentBlockhash: string;
  recentSlot: bigint;
  decimals: number;
  tokenProgram?: string;
  feePayerKey?: string;
  gracePeriodSeconds: number;
  minimumDeposit: bigint;
}

function fail(
  code: "invalid_challenge" | "invalid_input",
  message: string,
): never {
  throw new MppError(code, message);
}

function decimal(value: unknown, name: string, allowZero = false): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    return fail(
      "invalid_challenge",
      `${name} is not a decimal integer string.`,
    );
  }
  const parsed = BigInt(value);
  if ((!allowZero && parsed === 0n) || parsed > U64_MAX) {
    return fail(
      "invalid_challenge",
      `${name} is not a ${allowZero ? "u64" : "positive u64"}.`,
    );
  }
  return parsed;
}

function address(value: unknown, name: string): string {
  if (typeof value !== "string" || !isValidAddress(value, "solana")) {
    return fail("invalid_challenge", `${name} is not a Solana address.`);
  }
  return value;
}

function readSessionRequest(challenge: MppChallenge): SessionRequest {
  if (
    challenge.params.method !== "solana" ||
    challenge.params.intent !== "session"
  ) {
    return fail(
      "invalid_challenge",
      "The challenge is not a Solana session challenge.",
    );
  }
  const request = challenge.request;
  const details = request.methodDetails;
  if (!isRecord(details))
    fail("invalid_challenge", "methodDetails is missing.");
  const network = details.network;
  if (network !== "mainnet" && network !== "devnet") {
    fail("invalid_challenge", `network ${String(network)} is not supported.`);
  }
  if (details.channelId !== undefined) {
    fail("invalid_challenge", "Resuming an existing channel is not supported.");
  }
  if (
    details.voucherSigner !== undefined &&
    details.voucherSigner !== "client"
  ) {
    fail("invalid_challenge", "Only client-signed vouchers are supported.");
  }
  if (details.operator !== undefined) {
    fail(
      "invalid_challenge",
      "operator is forbidden for client-signed vouchers.",
    );
  }
  if (
    details.distributionSplits !== undefined &&
    (!Array.isArray(details.distributionSplits) ||
      details.distributionSplits.length !== 0)
  ) {
    fail(
      "invalid_challenge",
      "Only the single challenge recipient may receive settlement.",
    );
  }
  const decimals = details.decimals;
  if (
    !Number.isInteger(decimals) ||
    (decimals as number) < 0 ||
    (decimals as number) > 9
  ) {
    fail("invalid_challenge", "methodDetails.decimals is not 0 to 9.");
  }
  const grace = details.gracePeriodSeconds;
  if (
    !Number.isInteger(grace) ||
    (grace as number) <= 0 ||
    (grace as number) > 0xffff_ffff
  ) {
    fail("invalid_challenge", "gracePeriodSeconds is not a positive u32.");
  }
  const tokenProgram = details.tokenProgram;
  if (
    tokenProgram !== undefined &&
    tokenProgram !== SOLANA_PROGRAMS.token &&
    tokenProgram !== SOLANA_PROGRAMS.token2022
  ) {
    fail("invalid_challenge", "tokenProgram is not a supported token program.");
  }
  const feePayer = details.feePayer;
  if (feePayer !== undefined && typeof feePayer !== "boolean") {
    fail("invalid_challenge", "feePayer is not a boolean.");
  }
  const feePayerKey = details.feePayerKey;
  if (feePayer === true) address(feePayerKey, "feePayerKey");
  else if (feePayerKey !== undefined) {
    fail("invalid_challenge", "feePayerKey requires feePayer=true.");
  }
  return {
    amount: decimal(request.amount, "amount"),
    currency: address(request.currency, "currency"),
    recipient: address(request.recipient, "recipient"),
    cluster: NETWORKS[network] as string,
    channelProgram: address(details.channelProgram, "channelProgram"),
    recentBlockhash: address(details.recentBlockhash, "recentBlockhash"),
    recentSlot: decimal(details.recentSlot, "recentSlot", true),
    decimals: decimals as number,
    ...(tokenProgram !== undefined
      ? { tokenProgram: tokenProgram as string }
      : {}),
    ...(feePayer === true ? { feePayerKey: feePayerKey as string } : {}),
    gracePeriodSeconds: grace as number,
    minimumDeposit:
      request.minimumDeposit === undefined
        ? 0n
        : decimal(request.minimumDeposit, "minimumDeposit", true),
  };
}

function base58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let result = "";
  while (value > 0n) {
    result = alphabet[Number(value % 58n)] + result;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = `1${result}`;
  }
  return result || "1";
}

function signedVoucher(
  signed: Awaited<ReturnType<ChannelVoucherKeyManager["signVoucher"]>>,
  signer: string,
): Record<string, unknown> {
  return {
    voucher: {
      channelId: signed.voucher.channelId,
      cumulativeAmount: signed.voucher.cumulativeAmount.toString(),
      expiresAt: Number(signed.voucher.expiresAt),
    },
    signer,
    signature: base58(signed.signature),
    signatureType: "ed25519",
  };
}

function verifyOwnerSignedTransaction(
  unsigned: Uint8Array,
  signed: Uint8Array,
  owner: string,
): Uint8Array {
  const wanted = parseSolanaTransaction(unsigned);
  const got = parseSolanaTransaction(signed);
  if (
    wanted.message.length !== got.message.length ||
    wanted.message.some((byte, index) => byte !== got.message[index])
  ) {
    fail("invalid_input", "The wallet changed the force-close transaction.");
  }
  if (!verifySolanaSignature(got, owner)) {
    fail(
      "invalid_input",
      "The wallet did not sign the force-close transaction.",
    );
  }
  return signed;
}

// draft-solana-session-00 Channel IDL: discriminator/version/bump/status are
// four u8s; closureStartedAt follows salt, deposit, and two u64 watermarks.
function readClosingChannel(
  account: { data: Uint8Array } | null,
): bigint | null {
  if (!account) {
    fail("invalid_input", "Channel missing.");
  }
  const { data } = account;
  if (
    data.length <= 3 ||
    (data[3] !== 1 && (data[3] !== 2 || data.length < 44))
  ) {
    fail("invalid_input", "Unknown status.");
  }
  if (data[3] === 1) return null;
  return new DataView(data.buffer, data.byteOffset).getBigInt64(36, true);
}

function receiptFor(response: Response, channelId: string): MppReceipt {
  const receipt = parsePaymentReceipt(
    response.headers.get(PAYMENT_RECEIPT_HEADER),
  );
  if (
    receipt?.method !== "solana" ||
    receipt.intent !== "session" ||
    receipt.reference !== channelId
  ) {
    fail(
      "invalid_challenge",
      "The server did not return a matching Solana session receipt.",
    );
  }
  return receipt;
}

function withoutUnits(init?: MppSessionRequestInit): RequestInit | undefined {
  if (!init) return undefined;
  const { units: _units, ...requestInit } = init;
  return requestInit;
}

/**
 * Create an MPP Solana-session fetch client.
 *
 * Voucher expiry is app-selected and must exceed the forced-close grace
 * window. @solana/mpp uses a year-2100 default and its server rejects a
 * voucher that cannot survive settlement; keeping expiry in the sealed WP2a
 * policy preserves a finite delegated-key lifetime without changing WP2a.
 */
export function createMppSessionFetch(
  options: MppSessionFetchOptions,
): MppSessionFetch {
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const { policy, rpc, signer, keyManager } = options;
  if (
    policy.amount <= 0n ||
    policy.deposit <= 0n ||
    policy.maxCumulative <= 0n ||
    policy.maxCumulative > policy.deposit ||
    policy.maxDelta <= 0n ||
    policy.maxDelta > policy.maxCumulative ||
    !Number.isSafeInteger(policy.expiresAt) ||
    typeof policy.mint !== "string" ||
    !isValidAddress(policy.mint, "solana")
  ) {
    fail("invalid_input", "The session policy limits are invalid.");
  }

  let pendingUnits = 0n;
  let active:
    | {
        channel: MppOpenChannel;
        challenge: MppChallenge;
        keyId?: string;
        keyAddress: string;
        mintAccount: ChannelMintAccount;
        lastVoucher: Record<string, unknown> | null;
        endpoint: Request;
      }
    | undefined;
  let opening: Promise<MppSessionFetchResult> | undefined;
  const channels: MppOpenChannel[] = [];

  const meter: MppSessionMeter = {
    add(units) {
      if (
        typeof units !== "bigint" ||
        units <= 0n ||
        pendingUnits > U64_MAX - units
      ) {
        fail("invalid_input", "Meter units must be a positive u64.");
      }
      pendingUnits += units;
    },
    get pending() {
      return pendingUnits;
    },
  };

  async function paidRequest(
    request: Request,
    challenge: MppChallenge,
    payload: Record<string, unknown>,
    channel: MppOpenChannel,
  ): Promise<MppSessionFetchResult> {
    const credential = encodeCredential({
      challenge: challenge.params,
      payload,
    });
    const headers = new Headers(request.headers);
    headers.set(credential.header, credential.value);
    const response = await send(
      new Request(request, { headers, redirect: "error" }),
    );
    if (response.status === 402) {
      throw new MppError(
        "payment_rejected",
        "The server rejected the session credential.",
      );
    }
    const receipt = receiptFor(response, channel.channelId);
    return { response, receipt, channel };
  }

  const performFetch = async (
    input: RequestInfo | URL,
    init?: MppSessionRequestInit,
  ): Promise<MppSessionFetchResult> => {
    const units = init?.units;
    if (units !== undefined && (typeof units !== "bigint" || units <= 0n)) {
      fail("invalid_input", "Request units must be a positive bigint.");
    }
    if (units !== undefined && pendingUnits !== 0n) {
      fail(
        "invalid_input",
        "Use either request units or meter.add(), not both.",
      );
    }
    const request = new Request(input, withoutUnits(init));
    if (active) {
      if (!active.keyId) {
        fail(
          "invalid_input",
          "The channel open was not acknowledged; use forceClose for recovery.",
        );
      }
      const metered = units ?? pendingUnits;
      if (metered <= 0n)
        fail("invalid_input", "No metered units were reported.");
      if (units === undefined) pendingUnits -= metered;
      let signed: Awaited<ReturnType<typeof keyManager.signVoucher>>;
      try {
        signed = await keyManager.signVoucher(active.keyId, {
          channelId: active.channel.channelId,
          units: metered,
        });
      } catch (error) {
        if (units === undefined) pendingUnits += metered;
        throw error;
      }
      const voucher = signedVoucher(signed, active.keyAddress);
      active.lastVoucher = voucher;
      active.endpoint = request.clone();
      const result = await paidRequest(
        request,
        active.challenge,
        {
          action: "voucher",
          channelId: active.channel.channelId,
          voucher,
        },
        active.channel,
      );
      return result;
    }

    if (units !== undefined) {
      fail(
        "invalid_input",
        "Request units apply only after the channel is open.",
      );
    }

    const first = await send(request.clone());
    if (first.status !== 402)
      return { response: first, receipt: null, channel: null };
    void first.body?.cancel().catch(() => {});
    if (
      first.redirected ||
      (first.url && new URL(first.url).origin !== new URL(request.url).origin)
    ) {
      fail(
        "invalid_challenge",
        "Payment challenge arrived through a redirect.",
      );
    }
    const parsed = parsePaymentChallenges(
      first.headers.get(WWW_AUTHENTICATE_HEADER),
    );
    const challenge = parsed.challenges.find(
      (candidate) =>
        candidate.params.method === "solana" &&
        candidate.params.intent === "session",
    );
    if (!challenge)
      fail("invalid_challenge", "No Solana session challenge was offered.");
    if (
      challenge.expiresAt !== undefined &&
      challenge.expiresAt <= Date.now()
    ) {
      fail("invalid_challenge", "The Solana session challenge has expired.");
    }
    const session = readSessionRequest(challenge);
    // Before any RPC, key or signature: the policy limits are base units of
    // the policy mint, so a challenge for another token is out of policy.
    if (session.currency !== policy.mint) {
      fail(
        "invalid_challenge",
        "The challenged mint is not the app policy mint.",
      );
    }

    await assertSolanaCluster(rpc, session.cluster);
    const trusted = await assertTrustedChannelProgram(
      rpc,
      session.cluster,
      options.trustProgram,
    );
    if (session.channelProgram !== trusted.address) {
      fail(
        "invalid_challenge",
        "The challenge channelProgram is not the app-trusted program.",
      );
    }
    if (!(await rpc.isBlockhashValid(session.recentBlockhash))) {
      fail(
        "invalid_challenge",
        "The challenged recentBlockhash is not valid on the app RPC.",
      );
    }
    const mint = await rpc.getAccountInfo(session.currency);
    if (!mint)
      fail("invalid_challenge", "The challenged mint account does not exist.");
    const mintDetails = readMint(mint.owner, mint.data);
    if (
      mintDetails.decimals !== session.decimals ||
      (session.tokenProgram &&
        session.tokenProgram !== mintDetails.tokenProgram)
    ) {
      fail(
        "invalid_challenge",
        "The challenge does not match the mint account.",
      );
    }
    const minimumGrace =
      policy.minimumGracePeriodSeconds ?? DEFAULT_MINIMUM_GRACE_PERIOD_SECONDS;
    if (
      session.recipient !== policy.recipient ||
      session.amount !== policy.amount ||
      session.gracePeriodSeconds < minimumGrace ||
      policy.deposit < session.minimumDeposit
    ) {
      fail(
        "invalid_challenge",
        "The session challenge exceeds the app policy.",
      );
    }
    const now = Math.floor(Date.now() / 1000);
    if (policy.expiresAt < now + session.gracePeriodSeconds) {
      fail(
        "invalid_input",
        "Voucher expiry must outlast the forced-close settlement window.",
      );
    }

    const created = await keyManager.create({
      cluster: session.cluster,
      channelProgram: trusted.address,
      payer: signer.address,
      mint: session.currency,
      payee: session.recipient,
      pricePerUnit: policy.amount,
      maxCumulative: policy.maxCumulative,
      maxDelta: policy.maxDelta,
      expiry: policy.expiresAt,
    });
    const saltBytes = crypto.getRandomValues(new Uint8Array(8));
    const salt = new DataView(saltBytes.buffer).getBigUint64(0, true);
    const openSlot = session.recentSlot;
    const openInput = {
      programAddress: trusted.address,
      feePayer: session.feePayerKey ?? signer.address,
      payer: signer.address,
      payee: session.recipient,
      mint: session.currency,
      authorizedSigner: created.address,
      salt,
      openSlot,
      mintAccount: {
        address: session.currency,
        owner: mint.owner,
        data: mint.data,
      },
      deposit: policy.deposit,
      gracePeriod: session.gracePeriodSeconds,
      recentBlockhash: session.recentBlockhash,
    };
    const derived = deriveChannelPda(openInput);
    let handedToServer = false;
    try {
      const signed = await signer.signTransaction(
        buildOpenChannelTransaction(openInput),
      );
      const transaction = verifySignedChannelOpen(signed, openInput);
      const channel: MppOpenChannel = {
        cluster: session.cluster,
        channelId: derived.channelId,
        payer: signer.address,
        payee: session.recipient,
        mint: session.currency,
        channelProgram: trusted.address,
        deposit: policy.deposit,
        gracePeriodSeconds: session.gracePeriodSeconds,
        openSlot,
        salt,
      };
      const credential = encodeCredential({
        challenge: challenge.params,
        payload: {
          action: "open",
          channelId: channel.channelId,
          payer: channel.payer,
          payee: channel.payee,
          mint: channel.mint,
          authorizedSigner: created.address,
          salt: salt.toString(),
          depositAmount: policy.deposit.toString(),
          gracePeriodSeconds: channel.gracePeriodSeconds,
          openSlot: openSlot.toString(),
          transaction,
        },
      });
      const headers = new Headers(request.headers);
      headers.set(credential.header, credential.value);
      active = {
        channel,
        challenge,
        keyId: created.id,
        keyAddress: created.address,
        mintAccount: openInput.mintAccount,
        lastVoucher: null,
        endpoint: request.clone(),
      };
      channels.push(channel);
      const responsePromise = send(
        new Request(request, { headers, redirect: "error" }),
      );
      handedToServer = true;
      const response = await responsePromise;
      if (response.status === 402)
        throw new MppError(
          "payment_rejected",
          "The server rejected the channel open.",
        );
      const receipt = receiptFor(response, channel.channelId);
      await keyManager.bindChannel(created.id, {
        channelId: channel.channelId,
        deposit: policy.deposit,
        openSlot,
        salt,
      });
      return { response, receipt, channel };
    } catch (error) {
      await keyManager.revoke(created.id).catch(() => {});
      if (handedToServer && active?.channel.channelId === derived.channelId) {
        active.keyId = undefined;
        const failure =
          error instanceof MppError
            ? error
            : new MppError(
                "invalid_challenge",
                "Channel open failed after the signed transaction was sent.",
              );
        Object.assign(failure, { channelId: derived.channelId });
        throw failure;
      }
      if (active?.channel.channelId === derived.channelId) {
        active = undefined;
        const index = channels.findIndex(
          ({ channelId }) => channelId === derived.channelId,
        );
        if (index >= 0) channels.splice(index, 1);
      }
      throw error;
    }
  };

  const sessionFetch = async (
    input: RequestInfo | URL,
    init?: MppSessionRequestInit,
  ): Promise<MppSessionFetchResult> => {
    if (opening) {
      await opening;
      return performFetch(input, init);
    }
    if (active) return performFetch(input, init);
    const current = performFetch(input, init);
    opening = current;
    try {
      return await current;
    } finally {
      if (opening === current) opening = undefined;
    }
  };

  Object.defineProperties(sessionFetch, {
    meter: { value: meter },
    channels: { get: () => channels.map((channel) => ({ ...channel })) },
    close: {
      value: async () => {
        const snapshot = active;
        if (!snapshot) fail("invalid_input", "There is no open channel.");
        const keyId = snapshot.keyId;
        const finalVoucher = snapshot.lastVoucher;
        if (!keyId)
          fail(
            "invalid_input",
            "The channel open was not acknowledged; use forceClose for recovery.",
          );
        if (!finalVoucher)
          fail("invalid_input", "A final voucher is required before close.");
        const result = await paidRequest(
          snapshot.endpoint.clone(),
          snapshot.challenge,
          {
            action: "close",
            channelId: snapshot.channel.channelId,
            voucher: finalVoucher,
          },
          snapshot.channel,
        );
        const voucher = finalVoucher.voucher as {
          cumulativeAmount: string;
        };
        const settlementBinding: MppSessionSettlementBinding = {
          cluster: snapshot.channel.cluster,
          channelId: snapshot.channel.channelId,
          channelProgram: snapshot.channel.channelProgram,
          expectedSettled: voucher.cumulativeAmount,
        };
        await keyManager.revoke(keyId);
        // A delayed close owns only its original channel, never a replacement.
        const index = channels.indexOf(snapshot.channel);
        if (index >= 0) channels.splice(index, 1);
        if (active === snapshot) active = undefined;
        return { ...result, settlementBinding };
      },
    },
    forceClose: {
      value: async () => {
        if (!active) fail("invalid_input", "There is no open channel.");
        if (!options.sendTransaction)
          fail(
            "invalid_input",
            "forceClose requires app-supplied sendTransaction.",
          );
        const snapshot = active;
        const lastVoucher = snapshot.lastVoucher?.voucher as
          | { cumulativeAmount?: unknown }
          | undefined;
        const settlementBinding: MppSessionSettlementBinding = {
          cluster: snapshot.channel.cluster,
          channelId: snapshot.channel.channelId,
          channelProgram: snapshot.channel.channelProgram,
          expectedSettled:
            typeof lastVoucher?.cumulativeAmount === "string"
              ? lastVoucher.cumulativeAmount
              : "0",
          afterForcedClose: true,
        };
        const signAndSend = async (transaction: Uint8Array) => {
          const signed = await signer.signTransaction(transaction);
          return options.sendTransaction?.(
            verifyOwnerSignedTransaction(transaction, signed, signer.address),
          ) as Promise<string>;
        };
        const requestCloseTxHash = await signAndSend(
          buildRequestCloseChannelTransaction({
            programAddress: snapshot.channel.channelProgram,
            feePayer: signer.address,
            payer: signer.address,
            channelId: snapshot.channel.channelId,
            recentBlockhash: await rpc.getLatestBlockhash(),
          }),
        );
        if (snapshot.keyId) await keyManager.revoke(snapshot.keyId);
        channels.splice(0, channels.length);
        active = undefined;
        return {
          requestCloseTxHash,
          settlementBinding,
          withdrawPayer: async () => {
            const closureStartedAt = readClosingChannel(
              await rpc.getAccountInfo(snapshot.channel.channelId),
            );
            if (closureStartedAt !== null) {
              const retryAfter =
                closureStartedAt + BigInt(snapshot.channel.gracePeriodSeconds);
              if (BigInt(Math.floor(Date.now() / 1_000)) < retryAfter) {
                fail(
                  "invalid_input",
                  `grace period has not elapsed; retry after ${retryAfter}`,
                );
              }
              await signAndSend(
                buildSealChannelTransaction({
                  programAddress: snapshot.channel.channelProgram,
                  feePayer: signer.address,
                  channelId: snapshot.channel.channelId,
                  recentBlockhash: await rpc.getLatestBlockhash(),
                }),
              );
            }
            return signAndSend(
              buildWithdrawPayerChannelTransaction({
                programAddress: snapshot.channel.channelProgram,
                feePayer: signer.address,
                payer: signer.address,
                channelId: snapshot.channel.channelId,
                mintAccount: snapshot.mintAccount,
                recentBlockhash: await rpc.getLatestBlockhash(),
              }),
            );
          },
        };
      },
    },
  });
  return sessionFetch as MppSessionFetch;
}

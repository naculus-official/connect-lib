import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import { SOLANA_MAINNET } from "../constants";
import {
  type ChannelVoucherKeyInfo,
  ChannelVoucherKeyManager,
} from "../session-keys/channel-voucher-keys";
import { SessionKeyManager } from "../session-keys/SessionKeyManager";
import {
  type SolanaSessionKeyInfo,
  SolanaSessionKeyManager,
} from "../session-keys/solana-session-keys";
import {
  type SessionKeyTypedDataRequest,
  sessionKeyAddress,
} from "../session-keys/typed-data";
import type {
  SessionKeyScope,
  SessionKeyTransaction,
} from "../session-keys/types";
import type { SolanaPaymentRpc } from "../solana-payment";
import { MemoryStorageAdapter } from "../storage";
import {
  type Authorization,
  compileEvmSessionScope,
  compileMppSession,
  compileSolanaSessionScope,
  evaluateSpend,
  type ListedAuthorization,
  listAuthorizations,
  revokeListedAuthorization,
  validateAuthorization,
} from ".";

const EVM_OWNER = "0x742D35CC6634C0532925a3B844Bc9E7595F2bD18";
const TOKEN = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const EVM_PAYEE = "0x1111111111111111111111111111111111111111";
const OTHER_EVM = "0x2222222222222222222222222222222222222222";
const OTHER_TOKEN = "0x3333333333333333333333333333333333333333";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_PAYEE = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const OTHER_SOL = "3XZXfFJHF5ox3yPop16oqYfSWxLpkjsEuvTe2S67G2rj";
const PAYER = "9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu";
const PROGRAM = "CHNLxDScvchfR2c9YJtDi2tt4LRtkvDVdnFf7bgXDEH";
const NOW = 2_000_000_000;
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";

function solanaRpc(): SolanaPaymentRpc {
  const mint = new Uint8Array(82);
  mint[44] = 6;
  mint[45] = 1;
  return {
    getGenesisHash: async () => MAINNET_GENESIS,
    getLatestBlockhash: async () => BLOCKHASH,
    getAccountInfo: async (address) =>
      address === MINT
        ? {
            owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            data: mint,
          }
        : null,
  };
}

function evmAuthorization(over: Partial<Authorization> = {}): Authorization {
  return {
    version: 1,
    principal: `eip155:1:${EVM_OWNER}`,
    grants: [
      {
        asset: `eip155:1/erc20:${TOKEN}`,
        recipients: [EVM_PAYEE],
        maxPerPayment: 1_000n,
        maxTotal: 1_000n,
        maxCount: 5,
        rails: ["transfer", "x402-exact"],
      },
    ],
    notBefore: NOW - 100,
    expiresAt: NOW + 100,
    ...over,
  };
}

function solanaAuthorization(over: Partial<Authorization> = {}): Authorization {
  return {
    version: 1,
    principal: `${SOLANA_MAINNET}:${PAYER}`,
    grants: [
      {
        asset: `${SOLANA_MAINNET}/token:${MINT}`,
        recipients: [SOL_PAYEE],
        maxPerPayment: 400n,
        maxTotal: 1_000n,
        maxCount: 5,
        rails: ["transfer", "mpp-charge", "x402-exact"],
      },
    ],
    expiresAt: NOW + 100,
    ...over,
  };
}

function invalidGrant(over: Record<string, unknown>) {
  const base = evmAuthorization();
  return { ...base, grants: [{ ...base.grants[0], ...over }] };
}

describe("validateAuthorization", () => {
  it.each([
    ["unknown version", { ...evmAuthorization(), version: 2 }],
    ["unknown top-level field", { ...evmAuthorization(), extra: true }],
    [
      "invalid principal",
      { ...evmAuthorization(), principal: "eip155:1:nope" },
    ],
    ["empty grants", { ...evmAuthorization(), grants: [] }],
    [
      "invalid time window",
      { ...evmAuthorization(), notBefore: NOW, expiresAt: NOW },
    ],
    ["unknown grant field", invalidGrant({ extra: true })],
    ["empty recipients", invalidGrant({ recipients: [] })],
    ["invalid recipient", invalidGrant({ recipients: ["nope"] })],
    ["non-bigint amount", invalidGrant({ maxTotal: 1 })],
    ["zero amount", invalidGrant({ maxPerPayment: 0n })],
    [
      "per payment over total",
      invalidGrant({ maxPerPayment: 2n, maxTotal: 1n }),
    ],
    ["invalid count", invalidGrant({ maxCount: 0 })],
    [
      "zero period amount",
      invalidGrant({ period: { amount: 0n, seconds: 1, start: 1 } }),
    ],
    [
      "period amount over total",
      invalidGrant({ period: { amount: 1_001n, seconds: 1, start: 1 } }),
    ],
    [
      "non-positive period seconds",
      invalidGrant({ period: { amount: 1n, seconds: 0, start: 1 } }),
    ],
    [
      "negative period start",
      invalidGrant({ period: { amount: 1n, seconds: 1, start: -1 } }),
    ],
    [
      "zero period start",
      invalidGrant({ period: { amount: 1n, seconds: 1, start: 0 } }),
    ],
    [
      "period on MPP rail",
      invalidGrant({
        rails: ["mpp-session"],
        period: { amount: 1n, seconds: 1, start: 1 },
      }),
    ],
    ["empty rails", invalidGrant({ rails: [] })],
    ["unknown rail", invalidGrant({ rails: ["wire"] })],
    ["invalid asset namespace", invalidGrant({ asset: "cosmos:1/token:x" })],
    ["invalid native asset", invalidGrant({ asset: "eip155:1/slip44:61" })],
    ["invalid token address", invalidGrant({ asset: "eip155:1/erc20:nope" })],
    [
      "duplicate recipient",
      invalidGrant({ recipients: [EVM_PAYEE, EVM_PAYEE] }),
    ],
    ["duplicate rail", invalidGrant({ rails: ["transfer", "transfer"] })],
  ])("refuses %s", (_name, value) => {
    expect(validateAuthorization(value)).toMatchObject({ ok: false });
  });

  it("requires a period start after zero, as the on-chain enforcer does", () => {
    expect(
      validateAuthorization(
        invalidGrant({ period: { amount: 1n, seconds: 1, start: 0 } }),
      ),
    ).toEqual({ ok: false, reason: "invalid grant period" });
    expect(
      validateAuthorization(
        invalidGrant({ period: { amount: 1n, seconds: 1, start: 1 } }),
      ),
    ).toMatchObject({ ok: true });
  });

  it("canonicalizes EVM assets, recipients, and principal", () => {
    const value = evmAuthorization({
      principal: `eip155:1:${EVM_OWNER.toLowerCase()}`,
      grants: [
        {
          ...evmAuthorization().grants[0],
          asset: `eip155:1/erc20:${TOKEN.toLowerCase()}`,
          recipients: [EVM_PAYEE.toLowerCase()],
        },
      ],
    });
    const result = validateAuthorization(value);
    expect(result.ok && result.authorization).toMatchObject({
      principal: `eip155:1:${EVM_OWNER}`,
      grants: [{ asset: `eip155:1/erc20:${TOKEN}`, recipients: [EVM_PAYEE] }],
    });
  });

  it("refuses grants whose asset, recipient, and rail overlap", () => {
    const value = evmAuthorization();
    value.grants.push({ ...value.grants[0], maxTotal: 2_000n });
    expect(validateAuthorization(value)).toEqual({
      ok: false,
      reason: "overlapping grants",
    });
  });
});

describe("evaluateSpend", () => {
  it.each([
    ["expired", { at: NOW + 100 }],
    ["not-yet-valid", { at: NOW - 101 }],
    ["no-matching-grant", { asset: "eip155:1/slip44:60" }],
    ["recipient-not-allowed", { recipient: OTHER_EVM }],
    ["over-per-payment", { amount: 1_001n }],
    ["over-total", { spentSoFar: 500n, amount: 501n }],
    ["over-count", { countSoFar: 5 }],
    ["rail-not-allowed", { rail: "mpp-charge" }],
  ] as const)("returns %s", (reason, over) => {
    expect(
      evaluateSpend(evmAuthorization(), {
        asset: `eip155:1/erc20:${TOKEN}`,
        recipient: EVM_PAYEE,
        amount: 100n,
        rail: "transfer",
        at: NOW,
        spentSoFar: 0n,
        countSoFar: 0,
        ...over,
      }),
    ).toEqual({ allow: false, reason });
  });

  it.each([
    ["at start", NOW, 99n, true],
    ["last second", NOW + 9, 99n, true],
    ["next period", NOW + 10, 0n, true],
    ["before start", NOW - 1, 0n, false],
    ["over period", NOW, 100n, false],
  ] as const)(
    "enforces a fixed window %s",
    (_name, at, periodSpentSoFar, allow) => {
      const authorization = evmAuthorization({
        notBefore: undefined,
        grants: [
          {
            ...evmAuthorization().grants[0],
            period: { amount: 100n, seconds: 10, start: NOW },
          },
        ],
      });
      expect(
        evaluateSpend(authorization, {
          asset: `eip155:1/erc20:${TOKEN}`,
          recipient: EVM_PAYEE,
          amount: 1n,
          rail: "transfer",
          at,
          spentSoFar: 0n,
          countSoFar: 0,
          periodSpentSoFar,
        }).allow,
      ).toBe(allow);
    },
  );

  it("refuses missing period usage rather than assuming zero", () => {
    const authorization = evmAuthorization({
      notBefore: undefined,
      grants: [
        {
          ...evmAuthorization().grants[0],
          period: { amount: 100n, seconds: 10, start: NOW },
        },
      ],
    });
    expect(
      evaluateSpend(authorization, {
        asset: `eip155:1/erc20:${TOKEN}`,
        recipient: EVM_PAYEE,
        amount: 1n,
        rail: "transfer",
        at: NOW,
        spentSoFar: 0n,
        countSoFar: 0,
      }),
    ).toEqual({ allow: false, reason: "period-limit-exceeded" });
  });
});

describe("compilers", () => {
  it.each([
    ["notBefore", evmAuthorization(), 1],
    ["missing chain", evmAuthorization(), 2],
    ["unsupported rail", invalidGrant({ rails: ["mpp-charge"] }), 1],
    [
      "different recipients",
      evmAuthorization({
        grants: [
          evmAuthorization().grants[0],
          {
            asset: "eip155:1/slip44:60",
            recipients: [OTHER_EVM],
            maxPerPayment: 1n,
            maxTotal: 1n,
            maxCount: 5,
            rails: ["transfer"],
          },
        ],
      }),
      1,
    ],
  ])("EVM refuses %s", (_name, value, chain) => {
    const input = value as Authorization;
    if (_name !== "notBefore") delete input.notBefore;
    expect(compileEvmSessionScope(input, chain as number)).toMatchObject({
      ok: false,
    });
  });

  it("EVM compiles an explicit ERC-20-only scope", () => {
    const value = evmAuthorization({
      notBefore: undefined,
    });
    expect(compileEvmSessionScope(value, 1)).toMatchObject({
      ok: true,
      scope: {
        mode: "offchain",
        allowedChainIds: [1],
        maxValuePerTx: 0n,
        maxTotalValue: 0n,
        allowedContracts: [TOKEN],
        allowedMethods: ["0xa9059cbb"],
        tokenAllowances: { [TOKEN]: 1_000n },
      },
    });
  });

  it("EVM compiles native grants to recipient-bounded empty-calldata transfers", () => {
    const value = evmAuthorization({
      notBefore: undefined,
      grants: [
        {
          asset: "eip155:1/slip44:60",
          recipients: [EVM_PAYEE],
          maxPerPayment: 3n,
          maxTotal: 9n,
          rails: ["transfer"],
        },
      ],
    });
    expect(compileEvmSessionScope(value, 1)).toEqual({
      ok: true,
      enforcement: "device",
      scope: {
        expiry: NOW + 100,
        maxValuePerTx: 3n,
        maxTotalValue: 9n,
        allowedContracts: [],
        allowedChainIds: [1],
        allowedRecipients: [EVM_PAYEE],
        nativeTransfer: "empty-calldata-to-recipients",
        mode: "offchain",
      },
    });
  });

  it("reports enforcement and applies the requireOnChain target matrix", () => {
    const period = { amount: 100n, seconds: 10, start: NOW };
    const evm = evmAuthorization({
      notBefore: undefined,
      grants: [
        { ...evmAuthorization().grants[0], period, rails: ["transfer"] },
      ],
    });
    const solana = solanaAuthorization({
      grants: [{ ...solanaAuthorization().grants[0], period }],
    });
    expect(compileEvmSessionScope(evm, 1)).toMatchObject({
      ok: true,
      enforcement: "device",
      scope: { periodLimits: { [TOKEN]: period } },
    });
    expect(
      compileEvmSessionScope(evm, 1, {
        mode: "eip7702",
        requireOnChain: true,
      }),
    ).toMatchObject({
      ok: true,
      enforcement: "on-chain",
      scope: {
        mode: "eip7702",
        periodLimits: { [TOKEN]: period },
      },
    });
    expect(compileSolanaSessionScope(solana, SOLANA_MAINNET)).toMatchObject({
      ok: true,
      enforcement: "device",
      scope: { period },
    });
    expect(
      compileEvmSessionScope(evm, 1, { requireOnChain: true }),
    ).toMatchObject({ ok: false });
    expect(
      compileSolanaSessionScope(solana, SOLANA_MAINNET, {
        requireOnChain: true,
      }),
    ).toMatchObject({ ok: false });
    expect(
      compileMppSession(mppAuthorization(), SOLANA_MAINNET, context(), {
        requireOnChain: true,
      }),
    ).toMatchObject({ ok: false });
  });

  it.each([
    [
      "a zero period start",
      evmAuthorization({
        notBefore: undefined,
        grants: [
          {
            ...evmAuthorization().grants[0],
            period: { amount: 1n, seconds: 1, start: 0 },
            rails: ["transfer"],
          },
        ],
      }),
      1,
    ],
    [
      "multiple tokens",
      evmAuthorization({
        notBefore: undefined,
        grants: [
          evmAuthorization().grants[0],
          {
            ...evmAuthorization().grants[0],
            asset: `eip155:1/erc20:${OTHER_EVM}`,
          },
        ],
      }),
      1,
    ],
    [
      "tokenMaxPerTx",
      evmAuthorization({
        notBefore: undefined,
        grants: [
          {
            ...evmAuthorization().grants[0],
            maxPerPayment: 1n,
          },
        ],
      }),
      1,
    ],
    [
      "an unsupported framework chain",
      evmAuthorization({
        principal: `eip155:56:${EVM_OWNER}`,
        notBefore: undefined,
        grants: [
          {
            ...evmAuthorization().grants[0],
            asset: `eip155:56/erc20:${TOKEN}`,
            rails: ["transfer"],
          },
        ],
      }),
      56,
    ],
  ])("refuses on-chain EVM compilation with %s", (_name, value, chainId) => {
    expect(
      compileEvmSessionScope(value, chainId, {
        mode: "eip7702",
        requireOnChain: true,
      }),
    ).toMatchObject({ ok: false });
  });

  it("compiles a subscription on chain when the period bounds each payment", () => {
    // 10 per 30 days, 120 in total: no caveat caps a single transfer, but the
    // period caveat makes one above 10 impossible, so per-payment 10 holds.
    const period = { amount: 10n, seconds: 2_592_000, start: NOW };
    const value = evmAuthorization({
      notBefore: undefined,
      grants: [
        {
          ...evmAuthorization().grants[0],
          maxPerPayment: 10n,
          maxTotal: 120n,
          period,
          rails: ["transfer"],
        },
      ],
    });
    const compiled = compileEvmSessionScope(value, 1, {
      mode: "eip7702",
      requireOnChain: true,
    });
    expect(compiled).toMatchObject({ ok: true, enforcement: "on-chain" });
    if (!compiled.ok) throw new Error("unreachable");
    expect(compiled.scope.tokenMaxPerTx).toBeUndefined();
    expect(compiled.scope.periodLimits).toEqual({ [TOKEN]: period });
    // A per-payment cap tighter than the period cannot be honoured on chain.
    expect(
      compileEvmSessionScope(
        evmAuthorization({
          notBefore: undefined,
          grants: [{ ...value.grants[0], maxPerPayment: 5n }],
        }),
        1,
        { mode: "eip7702", requireOnChain: true },
      ),
    ).toMatchObject({ ok: false });
  });

  it("EVM compiles a lower ERC-20 per-payment limit", () => {
    const value = evmAuthorization({
      notBefore: undefined,
      grants: [
        {
          ...evmAuthorization().grants[0],
          maxPerPayment: 250n,
          maxTotal: 1_000n,
        },
      ],
    });
    expect(compileEvmSessionScope(value, 1)).toMatchObject({
      ok: true,
      scope: {
        tokenAllowances: { [TOKEN]: 1_000n },
        tokenMaxPerTx: { [TOKEN]: 250n },
      },
    });
  });

  it.each([
    ["notBefore", SOLANA_MAINNET, solanaAuthorization({ notBefore: NOW - 1 })],
    ["invalid cluster", "solana:nope", solanaAuthorization()],
    ["no grant", SOLANA_MAINNET, evmAuthorization()],
    [
      "unsupported rail",
      SOLANA_MAINNET,
      invalidSolGrant({ rails: ["mpp-session"] }),
    ],
    [
      "u64 overflow",
      SOLANA_MAINNET,
      invalidSolGrant({ maxPerPayment: 1n << 64n, maxTotal: 1n << 64n }),
    ],
  ])("Solana refuses %s", (_name, cluster, value) => {
    expect(
      compileSolanaSessionScope(value as Authorization, cluster),
    ).toMatchObject({ ok: false });
  });

  it.each([
    ["no mpp grant", solanaAuthorization(), context()],
    [
      "several recipients",
      mppAuthorization({ recipients: [SOL_PAYEE, OTHER_SOL] }),
      context(),
    ],
    ["count", mppAuthorization({ maxCount: 1 }), context()],
    [
      "mixed rails",
      mppAuthorization({ rails: ["mpp-session", "transfer"] }),
      context(),
    ],
    ["small deposit", mppAuthorization(), context({ deposit: 999n })],
    ["invalid context", mppAuthorization(), context({ payer: "nope" })],
  ])("MPP refuses %s", (_name, value, compileContext) => {
    expect(
      compileMppSession(value as Authorization, SOLANA_MAINNET, compileContext),
    ).toMatchObject({ ok: false });
  });
});

function invalidSolGrant(over: Record<string, unknown>): Authorization {
  const value = solanaAuthorization();
  return {
    ...value,
    grants: [{ ...value.grants[0], ...over }] as Authorization["grants"],
  };
}

function mppAuthorization(
  grantOver: Record<string, unknown> = {},
): Authorization {
  return invalidSolGrant({
    maxCount: undefined,
    rails: ["mpp-session"],
    ...grantOver,
  });
}

function context(over: Record<string, unknown> = {}) {
  return {
    channelProgram: PROGRAM,
    payer: PAYER,
    pricePerUnit: 1n,
    deposit: 1_000n,
    ...over,
  } as {
    channelProgram: string;
    payer: string;
    pricePerUnit: bigint;
    deposit: bigint;
  };
}

describe("authorization listing", () => {
  it("round-trips every compiler through its manager", async () => {
    vi.setSystemTime(new Date(NOW * 1_000));

    const evmValue = evmAuthorization({ notBefore: undefined });
    const evmCompiled = compileEvmSessionScope(evmValue, 1);
    expect(evmCompiled.ok).toBe(true);
    if (!evmCompiled.ok) return;
    const evm = new SessionKeyManager(undefined, new MemoryStorageAdapter());
    await evm.createSessionKey(evmCompiled.scope, EVM_OWNER);

    const solanaValue = solanaAuthorization();
    const solanaCompiled = compileSolanaSessionScope(
      solanaValue,
      SOLANA_MAINNET,
    );
    expect(solanaCompiled.ok).toBe(true);
    if (!solanaCompiled.ok) return;
    const solana = new SolanaSessionKeyManager(
      {
        encryptionKey: "listing-test",
        pbkdf2Iterations: 1_000,
        unsafeAllowWeakKdf: true,
      },
      new MemoryStorageAdapter(),
    );
    await solana.createSessionKey(solanaCompiled.scope, PAYER, solanaRpc());

    const mppValue = mppAuthorization();
    const mppCompiled = compileMppSession(mppValue, SOLANA_MAINNET, context());
    expect(mppCompiled.ok).toBe(true);
    if (!mppCompiled.ok) return;
    const mppVoucher = new ChannelVoucherKeyManager(
      {
        encryptionKey: "listing-test",
        pbkdf2Iterations: 1_000,
        unsafeAllowWeakKdf: true,
        channelProgramOverrides: { [SOLANA_MAINNET]: PROGRAM },
      },
      new MemoryStorageAdapter(),
    );
    await mppVoucher.create(mppCompiled.scope.voucher);

    const listed = await listAuthorizations({ evm, solana, mppVoucher });
    expect(listed).toHaveLength(3);
    expect(listed.map((entry) => entry.enforcer)).toEqual([
      "evm-session",
      "solana-session",
      "mpp-voucher",
    ]);
    expect(listed[0]?.grants).toEqual(evmValue.grants);
    expect(listed[1]?.grants).toEqual(solanaValue.grants);
    expect(listed[2]?.grants).toEqual(mppValue.grants);
    expect(listed[0]).toMatchObject({
      principal: evmValue.principal,
      status: "active",
      flags: [],
    });
    expect(listed[1]).toMatchObject({
      principal: solanaValue.principal,
      status: "pending",
      spent: { [`${SOLANA_MAINNET}/token:${MINT}`]: 0n },
      flags: [],
    });
    expect(listed[2]).toMatchObject({
      principal: mppValue.principal,
      status: "active",
      spent: { [`${SOLANA_MAINNET}/token:${MINT}`]: 0n },
      flags: [],
    });
    vi.useRealTimers();
  });

  it("omits a token whose per-payment cap it cannot state, and a zero-address principal", async () => {
    const entryFor = {
      id: "zero-cap",
      publicKey: `0x${"11".repeat(33)}`,
      status: "active" as const,
      createdAt: 0,
      expiresAt: NOW * 1_000,
      useCount: 0,
      signerAddress:
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
      scope: {
        expiry: NOW,
        allowedChainIds: [1],
        allowedContracts: [TOKEN as `0x${string}`],
        allowedMethods: ["0xa9059cbb"],
        allowedRecipients: [EVM_PAYEE as `0x${string}`],
        tokenAllowances: { [TOKEN]: 100n } as Record<`0x${string}`, bigint>,
        tokenMaxPerTx: { [TOKEN]: 0n } as Record<`0x${string}`, bigint>,
        maxValuePerTx: 0n,
        maxTotalValue: 0n,
        mode: "offchain" as const,
      },
    };
    const evm = {
      listSessions: vi.fn().mockResolvedValue([entryFor]),
    } as unknown as SessionKeyManager;
    const [entry] = await listAuthorizations({ evm });
    expect(entry.grants).toEqual([]);
    expect(entry.flags).toContain("not-expressible");
    expect(entry).not.toHaveProperty("principal");
  });

  it("lists persisted EVM token and native spend under each grant asset", async () => {
    const lowerToken = TOKEN.toLowerCase() as `0x${string}`;
    const raw = {
      id: "spent-evm",
      publicKey: `0x${"11".repeat(33)}`,
      status: "active" as const,
      createdAt: 0,
      expiresAt: NOW * 1_000,
      useCount: 3,
      signerAddress: EVM_OWNER as `0x${string}`,
      usage: {
        valueSpent: 25n,
        tokenSpent: { [lowerToken]: 75n },
        txCount: 3,
      },
      scope: {
        expiry: NOW,
        allowedChainIds: [1],
        allowedContracts: [TOKEN as `0x${string}`],
        allowedMethods: ["0xa9059cbb"],
        allowedRecipients: [EVM_PAYEE as `0x${string}`],
        tokenAllowances: { [TOKEN]: 100n } as Record<`0x${string}`, bigint>,
        maxValuePerTx: 20n,
        maxTotalValue: 50n,
        nativeTransfer: "empty-calldata-to-recipients" as const,
        mode: "offchain" as const,
      },
    };
    const evm = {
      listSessions: vi.fn().mockResolvedValue([raw]),
    } as unknown as SessionKeyManager;

    const [entry] = await listAuthorizations({ evm });

    expect(entry.spent).toEqual({
      [`eip155:1/erc20:${TOKEN}`]: 75n,
      "eip155:1/slip44:60": 25n,
    });
  });

  it("flags legacy unrestricted recipients and non-expressible EVM scope without inventing grants", async () => {
    const base = {
      id: "legacy",
      publicKey: `0x${"11".repeat(33)}`,
      status: "revoked" as const,
      createdAt: 0,
      expiresAt: NOW * 1_000,
      useCount: 0,
      signerAddress: EVM_OWNER as `0x${string}`,
      scope: {
        expiry: NOW,
        allowedChainIds: [1],
        allowedContracts: [TOKEN as `0x${string}`],
        allowedMethods: ["0x095ea7b3"],
        mode: "offchain" as const,
      },
    };
    const evm = {
      listSessions: vi.fn().mockResolvedValue([base]),
    } as unknown as SessionKeyManager;
    const [entry] = await listAuthorizations({ evm });
    expect(entry).toMatchObject({
      status: "revoked",
      grants: [],
      flags: ["unrestricted-recipient-legacy", "not-expressible"],
    });
  });

  it.each([
    [
      "an arbitrary method",
      {
        allowedContracts: [TOKEN],
        allowedMethods: ["0xa9059cbb", "0x095ea7b3"],
        tokenAllowances: { [TOKEN]: 1_000n },
      },
      1,
    ],
    [
      "a contract permission without a token limit",
      { allowedContracts: [TOKEN], allowedMethods: ["0xa9059cbb"] },
      0,
    ],
  ])("flags %s and returns only exact grants", async (_name, extra, count) => {
    const raw = {
      id: "broader-evm",
      publicKey: `0x${"11".repeat(33)}`,
      status: "active" as const,
      createdAt: 0,
      expiresAt: NOW * 1_000,
      useCount: 0,
      signerAddress: EVM_OWNER as `0x${string}`,
      scope: {
        expiry: NOW,
        allowedChainIds: [1],
        allowedRecipients: [EVM_PAYEE as `0x${string}`],
        maxValuePerTx: 0n,
        maxTotalValue: 0n,
        mode: "offchain" as const,
        ...extra,
      },
    };
    const evm = {
      listSessions: vi.fn().mockResolvedValue([raw]),
    } as unknown as SessionKeyManager;
    const [entry] = await listAuthorizations({ evm });
    expect(entry?.flags).toEqual(["not-expressible"]);
    expect(entry?.grants).toHaveLength(count);
    if (count === 1) {
      expect(entry?.grants[0]).toEqual({
        asset: `eip155:1/erc20:${TOKEN}`,
        recipients: [EVM_PAYEE],
        maxPerPayment: 1_000n,
        maxTotal: 1_000n,
        rails: ["transfer", "x402-exact"],
      });
    }
  });

  it("normalizes expired manager records and preserves exactly stated grants", async () => {
    const raw = {
      id: "expired-solana",
      address: SOL_PAYEE,
      owner: PAYER,
      scope: {
        cluster: SOLANA_MAINNET,
        mint: MINT,
        budget: 1_000n,
        maxPerPayment: 400n,
        allowedRecipients: [SOL_PAYEE],
        expiry: NOW - 1,
      },
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      decimals: 6,
      status: "expired" as const,
      spent: 12n,
      useCount: 1,
      createdAt: 0,
    } satisfies SolanaSessionKeyInfo;
    const solana = {
      listSessions: vi.fn().mockResolvedValue([raw]),
    } as unknown as SolanaSessionKeyManager;
    await expect(listAuthorizations({ solana })).resolves.toMatchObject([
      {
        status: "expired",
        spent: { [`${SOLANA_MAINNET}/token:${MINT}`]: 12n },
      },
    ]);
  });

  it.each([
    ["evm-session", "revokeSession", false],
    ["solana-session", "revoke", true],
    ["mpp-voucher", "revoke", false],
  ] as const)(
    "revokes only the %s manager",
    async (enforcer, method, onChain) => {
      const evmRevoke = vi.fn().mockResolvedValue(undefined);
      const solanaRevoke = vi.fn().mockResolvedValue(undefined);
      const voucherRevoke = vi.fn().mockResolvedValue(undefined);
      const managers = {
        evm: { revokeSession: evmRevoke } as unknown as SessionKeyManager,
        solana: { revoke: solanaRevoke } as unknown as SolanaSessionKeyManager,
        mppVoucher: {
          revoke: voucherRevoke,
        } as unknown as ChannelVoucherKeyManager,
      };
      const raw = { id: "key" } as SolanaSessionKeyInfo | ChannelVoucherKeyInfo;
      const entry = {
        enforcer,
        keyId: "key",
        status: "active",
        expiresAt: NOW,
        grants: [],
        flags: [],
        raw,
      } as ListedAuthorization;
      await expect(revokeListedAuthorization(managers, entry)).resolves.toEqual(
        {
          onChainRevocationRequired: onChain,
        },
      );
      expect(evmRevoke).toHaveBeenCalledTimes(
        method === "revokeSession" ? 1 : 0,
      );
      expect(solanaRevoke).toHaveBeenCalledTimes(
        enforcer === "solana-session" ? 1 : 0,
      );
      expect(voucherRevoke).toHaveBeenCalledTimes(
        enforcer === "mpp-voucher" ? 1 : 0,
      );
    },
  );
});

function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function erc20Transfer(recipient: string, amount: bigint): string {
  return `0xa9059cbb${recipient.slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
}

function erc20Call(
  selector: string,
  recipient: string,
  amount: bigint,
): string {
  return `${selector}${recipient.slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
}

describe("differential enforcer checks", () => {
  it("creates the compiled EVM key with defaults, refuses out-of-model calls, and signs x402 exact typed data", async () => {
    vi.setSystemTime(new Date(NOW * 1_000));
    const compiled = compileEvmSessionScope(
      evmAuthorization({ notBefore: undefined }),
      1,
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.scope.maxGasPerTx).toBeUndefined();
    expect(compiled.scope.maxTotalGas).toBeUndefined();
    const manager = new SessionKeyManager(
      undefined,
      new MemoryStorageAdapter(),
    );
    const info = await manager.createSessionKey(compiled.scope, EVM_OWNER);
    await manager.setAuthorization(info.id, {
      signerAddress: EVM_OWNER,
      type: "offchain",
      rawSignature: `0x${"12".repeat(65)}`,
      message: "authorization compiler test",
    });
    const transfer = erc20Transfer(EVM_PAYEE, 10n);
    const refused = [
      { to: TOKEN, value: "1", data: transfer, chainId: 1 },
      { to: OTHER_TOKEN, value: "0", data: transfer, chainId: 1 },
      {
        to: TOKEN,
        value: "0",
        data: erc20Call("0x095ea7b3", EVM_PAYEE, 10n),
        chainId: 1,
      },
      {
        to: TOKEN,
        value: "0",
        data: erc20Call("0x23b872dd", EVM_PAYEE, 10n),
        chainId: 1,
      },
      {
        to: TOKEN,
        value: "0",
        data: erc20Call("0x39509351", EVM_PAYEE, 10n),
        chainId: 1,
      },
      { to: OTHER_TOKEN, value: "0", data: transfer, chainId: 1 },
      {
        to: TOKEN,
        value: "0",
        data: erc20Transfer(OTHER_EVM, 10n),
        chainId: 1,
      },
      { to: TOKEN, value: "0", data: transfer, chainId: 2 },
    ];
    for (const tx of refused) {
      await expect(
        manager.checkSessionScope(info.id, tx),
      ).resolves.toMatchObject({ valid: false });
    }

    const typedData: SessionKeyTypedDataRequest = {
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 1,
        verifyingContract: TOKEN,
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: sessionKeyAddress(info.publicKey),
        to: EVM_PAYEE,
        value: "10",
        validAfter: "0",
        validBefore: String(NOW + 50),
        nonce: `0x${"ab".repeat(32)}`,
      },
    };
    await expect(
      manager.signTypedDataWithSessionKey(info.id, typedData),
    ).resolves.toMatch(/^0x[0-9a-f]{130}$/);

    const nativeCompiled = compileEvmSessionScope(
      evmAuthorization({
        notBefore: undefined,
        grants: [
          {
            asset: "eip155:1/slip44:60",
            recipients: [EVM_PAYEE],
            maxPerPayment: 25n,
            maxTotal: 100n,
            maxCount: 5,
            rails: ["transfer"],
          },
        ],
      }),
      1,
    );
    expect(nativeCompiled.ok).toBe(true);
    if (!nativeCompiled.ok) return;
    const nativeInfo = await manager.createSessionKey(
      nativeCompiled.scope,
      EVM_OWNER,
    );
    const nativeRefused = [
      { to: EVM_PAYEE, value: "1", data: "0x12345678", chainId: 1 },
      { to: OTHER_EVM, value: "1", chainId: 1 },
      { to: TOKEN, value: "0", data: transfer, chainId: 1 },
      {
        to: TOKEN,
        value: "0",
        data: erc20Call("0x095ea7b3", EVM_PAYEE, 10n),
        chainId: 1,
      },
      {
        to: TOKEN,
        value: "0",
        data: erc20Call("0x23b872dd", EVM_PAYEE, 10n),
        chainId: 1,
      },
      {
        to: TOKEN,
        value: "0",
        data: erc20Call("0x39509351", EVM_PAYEE, 10n),
        chainId: 1,
      },
      { to: EVM_PAYEE, value: "1", chainId: 2 },
    ];
    for (const tx of nativeRefused) {
      await expect(
        manager.checkSessionScope(nativeInfo.id, tx),
      ).resolves.toMatchObject({ valid: false });
    }
    vi.useRealTimers();
  });

  it("matches ERC-20 per-payment and total limits for 500 seeded requests", () => {
    const authorization = evmAuthorization({
      notBefore: undefined,
      grants: [
        {
          ...evmAuthorization().grants[0],
          maxPerPayment: 400n,
          maxTotal: 1_000n,
        },
      ],
    });
    const compiled = compileEvmSessionScope(authorization, 1);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const manager = new SessionKeyManager({ forbiddenMethods: [] });
    const check = (
      manager as unknown as {
        checkScopeAgainstTx(
          scope: SessionKeyScope,
          count: number,
          tx: SessionKeyTransaction,
          value: bigint,
          gas: bigint,
          token: Record<`0x${string}`, bigint>,
        ): { valid: boolean };
      }
    ).checkScopeAgainstTx.bind(manager);
    const random = lcg(0x20c0);
    for (let index = 0; index < 500; index++) {
      const amount = BigInt(Math.floor(random() * 600) + 1);
      const spent = BigInt(Math.floor(random() * 1_100));
      const count = Math.floor(random() * 8);
      const request = {
        asset: `eip155:1/erc20:${TOKEN}`,
        recipient: EVM_PAYEE,
        amount,
        rail: "transfer" as const,
        at: NOW,
        spentSoFar: spent,
        countSoFar: count,
      };
      const actual = check(
        compiled.scope,
        count,
        {
          to: TOKEN,
          value: "0",
          data: erc20Transfer(EVM_PAYEE, amount),
          chainId: 1,
        },
        0n,
        0n,
        { [TOKEN]: spent },
      ).valid;
      expect(actual, `ERC-20 differential case ${index}`).toBe(
        evaluateSpend(authorization, request).allow,
      );
    }
  });

  it("matches native per-payment and total limits for 500 seeded requests", () => {
    const authorization = evmAuthorization({
      notBefore: undefined,
      grants: [
        {
          asset: "eip155:1/slip44:60",
          recipients: [EVM_PAYEE],
          maxPerPayment: 400n,
          maxTotal: 1_000n,
          maxCount: 5,
          rails: ["transfer"],
        },
      ],
    });
    const compiled = compileEvmSessionScope(authorization, 1);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const manager = new SessionKeyManager({ forbiddenMethods: [] });
    const check = (
      manager as unknown as {
        checkScopeAgainstTx(
          scope: SessionKeyScope,
          count: number,
          tx: SessionKeyTransaction,
          value: bigint,
          gas: bigint,
          token: Record<`0x${string}`, bigint>,
        ): { valid: boolean };
      }
    ).checkScopeAgainstTx.bind(manager);
    const random = lcg(0xa711);
    for (let index = 0; index < 500; index++) {
      const amount = BigInt(Math.floor(random() * 600) + 1);
      const spent = BigInt(Math.floor(random() * 1_100));
      const count = Math.floor(random() * 8);
      const request = {
        asset: "eip155:1/slip44:60",
        recipient: EVM_PAYEE,
        amount,
        rail: "transfer" as const,
        at: NOW,
        spentSoFar: spent,
        countSoFar: count,
      };
      const actual = check(
        compiled.scope,
        count,
        { to: EVM_PAYEE, value: amount.toString(), chainId: 1 },
        spent,
        0n,
        {},
      ).valid;
      expect(actual, `native differential case ${index}`).toBe(
        evaluateSpend(authorization, request).allow,
      );
    }
  });

  it("matches the EVM scope checker for 500 seeded requests", () => {
    const authorization = evmAuthorization({ notBefore: undefined });
    const compiled = compileEvmSessionScope(authorization, 1);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const manager = new SessionKeyManager({ forbiddenMethods: [] });
    const check = (
      manager as unknown as {
        checkScopeAgainstTx(
          scope: SessionKeyScope,
          count: number,
          tx: SessionKeyTransaction,
          value: bigint,
          gas: bigint,
          token: Record<`0x${string}`, bigint>,
        ): { valid: boolean };
      }
    ).checkScopeAgainstTx.bind(manager);
    const random = lcg(0xe11e);
    for (let index = 0; index < 500; index++) {
      const amount = BigInt(Math.floor(random() * 1_500) + 1);
      const spent = BigInt(Math.floor(random() * 1_200));
      const count = Math.floor(random() * 8);
      const kind = Math.floor(random() * 5);
      const recipient = kind === 2 ? OTHER_EVM : EVM_PAYEE;
      const requestAsset =
        kind === 0
          ? `eip155:1/erc20:${OTHER_TOKEN}`
          : kind === 1
            ? "eip155:1/slip44:60"
            : `eip155:1/erc20:${TOKEN}`;
      const requestChain = kind === 3 ? 2 : 1;
      const request = {
        asset: requestAsset,
        recipient,
        amount,
        rail: "transfer" as const,
        at: NOW,
        spentSoFar: spent,
        countSoFar: count,
      };
      const tx = {
        to: kind === 0 ? OTHER_TOKEN : TOKEN,
        value: kind === 1 ? amount.toString() : "0",
        data: erc20Transfer(recipient, amount),
        chainId: requestChain,
      };
      const actual = check(compiled.scope, count, tx, 0n, 0n, {
        [TOKEN]: spent,
      }).valid;
      expect(
        actual,
        JSON.stringify({ index, ...request }, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      ).toBe(kind < 4 ? false : evaluateSpend(authorization, request).allow);
    }
  });

  it("matches the Solana manager check for 500 seeded requests", () => {
    const compiled = compileSolanaSessionScope(
      solanaAuthorization(),
      SOLANA_MAINNET,
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const manager = new SolanaSessionKeyManager(
      { encryptionKey: "test" },
      new MemoryStorageAdapter(),
    );
    const check = (
      manager as unknown as { check(key: unknown, payment: unknown): void }
    ).check.bind(manager);
    vi.setSystemTime(new Date(NOW * 1_000));
    const random = lcg(0x501a);
    for (let index = 0; index < 500; index++) {
      const amount = BigInt(Math.floor(random() * 600) + 1);
      const spent = BigInt(Math.floor(random() * 1_100));
      const count = Math.floor(random() * 8);
      const recipient = random() < 0.8 ? SOL_PAYEE : OTHER_SOL;
      const request = {
        asset: `${SOLANA_MAINNET}/token:${MINT}`,
        recipient,
        amount,
        rail: "transfer" as const,
        at: NOW,
        spentSoFar: spent,
        countSoFar: count,
      };
      let actual = true;
      try {
        check(
          { status: "active", scope: compiled.scope, spent, useCount: count },
          { recipient, amount, feePayer: PAYER, memo: null },
        );
      } catch {
        actual = false;
      }
      expect(
        actual,
        JSON.stringify({ index, ...request }, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      ).toBe(evaluateSpend(solanaAuthorization(), request).allow);
    }
    vi.useRealTimers();
  });

  it.each(["evm", "solana"] as const)(
    "matches the %s device period enforcer across boundaries",
    (target) => {
      const period = { amount: 100n, seconds: 10, start: NOW };
      const authorization =
        target === "evm"
          ? evmAuthorization({
              notBefore: undefined,
              grants: [
                {
                  ...evmAuthorization().grants[0],
                  maxPerPayment: 100n,
                  period,
                },
              ],
            })
          : solanaAuthorization({
              grants: [
                {
                  ...solanaAuthorization().grants[0],
                  maxPerPayment: 100n,
                  period,
                },
              ],
            });
      const times = [NOW - 1, NOW, NOW + 9, NOW + 10];
      for (const at of times) {
        for (const periodSpent of [0n, 99n, 100n]) {
          const amount = 1n;
          const request = {
            asset:
              target === "evm"
                ? `eip155:1/erc20:${TOKEN}`
                : `${SOLANA_MAINNET}/token:${MINT}`,
            recipient: target === "evm" ? EVM_PAYEE : SOL_PAYEE,
            amount,
            rail: "transfer" as const,
            at,
            spentSoFar: 0n,
            countSoFar: 0,
            periodSpentSoFar: periodSpent,
          };
          vi.setSystemTime(new Date(at * 1_000));
          let actual = true;
          if (target === "evm") {
            const compiled = compileEvmSessionScope(authorization, 1);
            expect(compiled.ok).toBe(true);
            if (!compiled.ok) continue;
            const manager = new SessionKeyManager({ forbiddenMethods: [] });
            const check = (
              manager as unknown as {
                checkScopeAgainstTx(
                  scope: SessionKeyScope,
                  count: number,
                  tx: SessionKeyTransaction,
                  value: bigint,
                  gas: bigint,
                  token: Record<string, bigint>,
                  periods: Record<
                    string,
                    { periodIndex: number; periodSpent: bigint }
                  >,
                ): { valid: boolean };
              }
            ).checkScopeAgainstTx.bind(manager);
            const index = at < NOW ? 0 : Math.floor((at - NOW) / 10);
            actual = check(
              compiled.scope,
              0,
              {
                to: TOKEN,
                value: "0",
                data: erc20Transfer(EVM_PAYEE, amount),
                chainId: 1,
              },
              0n,
              0n,
              {},
              { [TOKEN]: { periodIndex: index, periodSpent } },
            ).valid;
          } else {
            const compiled = compileSolanaSessionScope(
              authorization,
              SOLANA_MAINNET,
            );
            expect(compiled.ok).toBe(true);
            if (!compiled.ok) continue;
            const manager = new SolanaSessionKeyManager(
              { encryptionKey: "test" },
              new MemoryStorageAdapter(),
            );
            const check = (
              manager as unknown as {
                check(key: unknown, payment: unknown): void;
              }
            ).check.bind(manager);
            try {
              const index = at < NOW ? 0 : Math.floor((at - NOW) / 10);
              check(
                {
                  status: "active",
                  scope: compiled.scope,
                  spent: 0n,
                  useCount: 0,
                  periodIndex: index,
                  periodSpent,
                },
                { recipient: SOL_PAYEE, amount, feePayer: PAYER, memo: null },
              );
            } catch {
              actual = false;
            }
          }
          expect(actual, `${target} at=${at} spent=${periodSpent}`).toBe(
            evaluateSpend(authorization, request).allow,
          );
        }
      }
      vi.useRealTimers();
    },
  );

  it("matches signVoucher limits for 500 seeded requests", async () => {
    vi.setSystemTime(new Date(NOW * 1_000));
    const authorization = mppAuthorization();
    const compiled = compileMppSession(
      authorization,
      SOLANA_MAINNET,
      context(),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const random = lcg(0x4d5050);
    for (let index = 0; index < 500; index++) {
      const amount = BigInt(Math.floor(random() * 600) + 1);
      const spent = BigInt(Math.floor(random() * 1_100));
      const manager = new ChannelVoucherKeyManager(
        { encryptionKey: "test" },
        new MemoryStorageAdapter(),
      );
      const seed = new Uint8Array(32).fill(7);
      const key = {
        status: "active",
        policy: compiled.scope.voucher,
        channel: { channelId: PAYER, deposit: 1_000n, maxCumulative: 1_000n },
        lastCumulative: spent,
        address: base58.encode(ed25519.getPublicKey(seed)),
      };
      const internals = manager as unknown as {
        update<T>(id: string, change: (stored: typeof key) => T): Promise<T>;
        open(stored: typeof key): Uint8Array;
      };
      internals.update = async (_id, change) => change(key);
      internals.open = () => seed.slice();
      let actual = true;
      try {
        await manager.signVoucher("id", { channelId: PAYER, units: amount });
      } catch {
        actual = false;
      }
      const request = {
        asset: `${SOLANA_MAINNET}/token:${MINT}`,
        recipient: SOL_PAYEE,
        amount,
        rail: "mpp-session" as const,
        at: NOW,
        spentSoFar: spent,
        countSoFar: 0,
      };
      expect(
        actual,
        JSON.stringify({ index, ...request }, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      ).toBe(evaluateSpend(authorization, request).allow);
    }
    vi.useRealTimers();
  });
});

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import { SOLANA_MAINNET } from "../constants";
import { ChannelVoucherKeyManager } from "../session-keys/channel-voucher-keys";
import { SessionKeyManager } from "../session-keys/SessionKeyManager";
import { SolanaSessionKeyManager } from "../session-keys/solana-session-keys";
import {
  type SessionKeyTypedDataRequest,
  sessionKeyAddress,
} from "../session-keys/typed-data";
import type {
  SessionKeyScope,
  SessionKeyTransaction,
} from "../session-keys/types";
import { MemoryStorageAdapter } from "../storage";
import {
  type Authorization,
  compileEvmSessionScope,
  compileMppSession,
  compileSolanaSessionScope,
  evaluateSpend,
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

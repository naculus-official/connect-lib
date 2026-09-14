/**
 * Tests for SmartAccountManager
 *
 * Tests focus on:
 * - Address computation logic
 * - Chain AA support detection
 * - Gas limit encoding/decoding
 * - Error handling for unsupported chains and invalid input
 *
 * Full RPC-dependent tests are skipped unless INTEGRATION_TEST=true.
 */

import { ADDRESSES } from "@naculus/test-utils/test-constants";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountAbstractionError, isAAError } from "../errors";
import {
  decodeGasLimits,
  SmartAccountManager,
  type SmartAccountManagerConfig,
} from "../SmartAccountManager";
import {
  AA_SUPPORTED_CHAINS,
  type Address,
  type Call,
  DEFAULT_ENTRY_POINT,
  ENTRY_POINT_V0_6,
  ENTRY_POINT_V0_7,
  type Hex,
  SIMPLE_ACCOUNT_FACTORY_V06,
  SIMPLE_ACCOUNT_FACTORY_V07,
  type SmartAccountConfig,
  type UserOperation,
} from "../types";
import { encodeGasLimits } from "../user-operation";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";

// ─── Fixtures ──────────────────────────────────────────────────────────

const TEST_OWNER = "0x1234567890123456789012345678901234567890" as Address;
const TEST_ENTRY_POINT =
  "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
const TEST_ENTRY_POINT_V06 =
  "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789" as Address;
const TEST_USER_OP_HASH = `0x${"ab".repeat(32)}` as Hex;
const OTHER_USER_OP_HASH = `0x${"cd".repeat(32)}` as Hex;
const TEST_TRANSACTION_HASH = `0x${"ef".repeat(32)}` as Hex;

function createTestConfig(
  overrides: Partial<SmartAccountManagerConfig> = {},
): SmartAccountManagerConfig {
  return {
    rpcUrl: "https://eth.llamarpc.com",
    bundlerClient: { url: "https://api.pimlico.io/v2/1/rpc?apikey=test" },
    chainId: "eip155:1",
    signer: vi.fn(async () => ("0x" + "ab".repeat(65)) as Hex),
    ...overrides,
  };
}

function createAccountConfig(
  overrides: Partial<SmartAccountConfig> = {},
): SmartAccountConfig {
  return {
    owner: TEST_OWNER,
    accountType: "simple",
    entryPoint: TEST_ENTRY_POINT,
    chainId: "eip155:1",
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("SmartAccountManager", () => {
  /**
   * A SimpleAccountFactory hard-codes the EntryPoint into the account
   * implementation it deploys, so a mismatched pair produces accounts whose
   * UserOperations the configured EntryPoint cannot validate — and nothing
   * fails until a real deployment is attempted on chain.
   *
   * Asserted over the whole table rather than chain by chain. The previous
   * version listed six explicit expectations, which meant moving a chain
   * between EntryPoint versions looked like a test that needed updating
   * rather than an invariant to check, and a chain added later was not
   * covered at all.
   */
  it("keeps each SimpleAccount factory coupled to its EntryPoint version", () => {
    const pairing = {
      "0.6": {
        entryPoint: ENTRY_POINT_V0_6,
        factory: SIMPLE_ACCOUNT_FACTORY_V06,
      },
      "0.7": {
        entryPoint: ENTRY_POINT_V0_7,
        factory: SIMPLE_ACCOUNT_FACTORY_V07,
      },
    } as const;

    const entries = Object.entries(AA_SUPPORTED_CHAINS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [chainId, info] of entries) {
      expect({
        chainId,
        entryPoint: info.entryPoint,
        factory: info.factory,
      }).toEqual({ chainId, ...pairing[info.version] });
    }
  });

  describe("isAASupported", () => {
    it("returns true for supported chains", () => {
      const manager = new SmartAccountManager(createTestConfig());
      expect(manager.isAASupported("eip155:1")).toBe(true);
      expect(manager.isAASupported("eip155:137")).toBe(true);
      expect(manager.isAASupported("eip155:10")).toBe(true);
      expect(manager.isAASupported("eip155:42161")).toBe(true);
      expect(manager.isAASupported("eip155:8453")).toBe(true);
      expect(manager.isAASupported("eip155:11155111")).toBe(true);
    });

    it("returns false for unsupported chains", () => {
      const manager = new SmartAccountManager(createTestConfig());
      expect(manager.isAASupported("eip155:56")).toBe(false); // BSC
      expect(manager.isAASupported("eip155:43114")).toBe(false); // Avalanche
      expect(
        manager.isAASupported("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"),
      ).toBe(false);
      expect(manager.isAASupported("unknown:123")).toBe(false);
    });

    it("uses configured chain ID when no argument given", () => {
      const manager = new SmartAccountManager(
        createTestConfig({ chainId: "eip155:137" }),
      );
      expect(manager.isAASupported()).toBe(true);
    });

    it("returns false for unsupported configured chain", () => {
      const manager = new SmartAccountManager(
        createTestConfig({ chainId: "eip155:56" }),
      );
      expect(manager.isAASupported()).toBe(false);
    });
  });

  describe("createAccount validation", () => {
    it("throws AAError for invalid owner address", async () => {
      const manager = new SmartAccountManager(createTestConfig());
      const invalidConfig = createAccountConfig({
        owner: "0xinvalid" as Address,
      });

      await expect(manager.createAccount(invalidConfig)).rejects.toThrow(
        AccountAbstractionError,
      );
      await expect(manager.createAccount(invalidConfig)).rejects.toHaveProperty(
        "code",
        "aa_invalid_owner",
      );
    });

    it("throws AAError for null owner", async () => {
      const manager = new SmartAccountManager(createTestConfig());
      const config = createAccountConfig({
        owner: "0x" as Address,
      });

      await expect(manager.createAccount(config)).rejects.toThrow(
        AccountAbstractionError,
      );
    });

    it("throws AAError when owner is empty", async () => {
      const manager = new SmartAccountManager(createTestConfig());
      const config = createAccountConfig({
        owner: "0x0" as Address,
      });

      await expect(manager.createAccount(config)).rejects.toThrow(
        AccountAbstractionError,
      );
    });

    it("accepts valid owner address for createAccount", async () => {
      const manager = new SmartAccountManager(createTestConfig());
      const config = createAccountConfig();

      // This will try to do an RPC call and likely fail, but that's OK
      // We're testing the validation doesn't reject before the RPC call
      await expect(manager.createAccount(config)).rejects.toThrow();
      // Should NOT throw aa_invalid_owner
      const error = await manager.createAccount(config).catch((e) => e);
      expect(error.code).not.toBe("aa_invalid_owner");
    });
  });

  describe("sendUserOperation validation", () => {
    it("throws AAError for empty calls array", async () => {
      const manager = new SmartAccountManager(createTestConfig());
      const config = createAccountConfig();

      await expect(manager.sendUserOperation(config, [])).rejects.toThrow(
        AccountAbstractionError,
      );
      await expect(
        manager.sendUserOperation(config, []),
      ).rejects.toHaveProperty("code", "aa_no_calls");
    });
  });

  describe("getBaseFee", () => {
    it("fails closed when RPC fails", async () => {
      const manager = new SmartAccountManager(
        createTestConfig({ rpcUrl: "https://invalid.rpc.url" }),
      );
      await expect(manager.getBaseFee()).rejects.toMatchObject({
        code: "aa_rpc_error",
      });
    });
  });

  describe("getPriorityFee", () => {
    it("fails closed when RPC fails", async () => {
      const manager = new SmartAccountManager(
        createTestConfig({ rpcUrl: "https://invalid.rpc.url" }),
      );
      await expect(manager.getPriorityFee()).rejects.toMatchObject({
        code: "aa_rpc_error",
      });
    });
  });
});

// ─── encodeGasLimits / decodeGasLimits ─────────────────────────────────

describe("encodeGasLimits / decodeGasLimits", () => {
  it("encodes verification and call gas limits into a single hex value", () => {
    const encoded = encodeGasLimits(50_000n, 100_000n);
    // 50_000 = 0xc350, 100_000 = 0x186a0
    // padStart(32) -> 32 hex chars each
    const expected =
      "0x" +
      "0000000000000000000000000000c350" +
      "000000000000000000000000000186a0";
    expect(encoded).toBe(expected);
  });

  it("round-trips correctly", () => {
    const vgl = 75_000n;
    const cgl = 120_000n;
    const encoded = encodeGasLimits(vgl, cgl);
    const decoded = decodeGasLimits(encoded);
    expect(decoded.verificationGasLimit).toBe(vgl);
    expect(decoded.callGasLimit).toBe(cgl);
  });

  it("handles small values", () => {
    const vgl = 1n;
    const cgl = 1n;
    const encoded = encodeGasLimits(vgl, cgl);
    const decoded = decodeGasLimits(encoded);
    expect(decoded.verificationGasLimit).toBe(1n);
    expect(decoded.callGasLimit).toBe(1n);
  });

  it("handles large values", () => {
    const vgl = 10_000_000n;
    const cgl = 20_000_000n;
    const encoded = encodeGasLimits(vgl, cgl);
    const decoded = decodeGasLimits(encoded);
    expect(decoded.verificationGasLimit).toBe(vgl);
    expect(decoded.callGasLimit).toBe(cgl);
  });

  it("produces a 66-character hex string (0x + 64 hex chars)", () => {
    const encoded = encodeGasLimits(100_000n, 200_000n);
    expect(encoded.length).toBe(66); // 0x + 64 hex chars
  });

  it("decodes correctly with known values", () => {
    // padStart(32) -> 32 hex chars each
    const hex = ("0x" +
      "00000000000000000000000000000005" +
      "0000000000000000000000000000000a") as Hex;
    const decoded = decodeGasLimits(hex);
    expect(decoded.verificationGasLimit).toBe(5n);
    expect(decoded.callGasLimit).toBe(10n);
  });
});

// ─── Error Types ───────────────────────────────────────────────────────

describe("AccountAbstractionError", () => {
  it("has correct error code", () => {
    const error = new AccountAbstractionError("aa_unsupported_chain");
    expect(error.code).toBe("aa_unsupported_chain");
    expect(error.name).toBe("AccountAbstractionError");
  });

  it("includes default message", () => {
    const error = new AccountAbstractionError("aa_unsupported_chain");
    expect(error.message).toBe(
      "Chain does not support ERC-4337 account abstraction.",
    );
  });

  it("includes custom message when provided", () => {
    const error = new AccountAbstractionError(
      "aa_no_bundler",
      "Custom bundler message",
    );
    expect(error.message).toBe("Custom bundler message");
  });

  it("hasCode returns true for matching code", () => {
    const error = new AccountAbstractionError("aa_no_calls");
    expect(error.hasCode("aa_no_calls")).toBe(true);
    expect(error.hasCode("aa_no_bundler")).toBe(false);
  });

  it("isAAError type guard works", () => {
    const aaError = new AccountAbstractionError("aa_no_bundler");
    const regularError = new Error("regular");

    expect(isAAError(aaError)).toBe(true);
    expect(isAAError(regularError)).toBe(false);
    expect(isAAError(null)).toBe(false);
    expect(isAAError(undefined)).toBe(false);
    expect(isAAError({})).toBe(false);
  });
});

// ─── Chain Support Constants ───────────────────────────────────────────

describe("AA_SUPPORTED_CHAINS", () => {
  it("includes Ethereum mainnet", () => {
    expect(AA_SUPPORTED_CHAINS["eip155:1"]).toBeDefined();
    expect(AA_SUPPORTED_CHAINS["eip155:1"].entryPoint).toBeTruthy();
    expect(AA_SUPPORTED_CHAINS["eip155:1"].factory).toBeTruthy();
  });

  it("includes Polygon", () => {
    expect(AA_SUPPORTED_CHAINS["eip155:137"]).toBeDefined();
  });

  it("includes Base", () => {
    expect(AA_SUPPORTED_CHAINS["eip155:8453"]).toBeDefined();
  });

  it("includes Sepolia", () => {
    expect(AA_SUPPORTED_CHAINS["eip155:11155111"]).toBeDefined();
  });

  it("each entry has entryPoint and factory", () => {
    for (const [chainId, info] of Object.entries(AA_SUPPORTED_CHAINS)) {
      expect(info.entryPoint).toBeTruthy();
      expect(info.entryPoint.startsWith("0x")).toBe(true);
      expect(info.entryPoint.length).toBe(42);
      expect(info.factory).toBeTruthy();
      expect(info.factory.startsWith("0x")).toBe(true);
      expect(info.factory.length).toBe(42);
    }
  });
});

// ─── getAccountAddress ──────────────────────────────────────────

describe("getAccountAddress", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("extracts address from factory eth_call result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            result:
              "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          }),
      }),
    );
    const manager = new SmartAccountManager(createTestConfig());
    const address = await manager.getAccountAddress(createAccountConfig());
    expect(address).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("encodes salt in the RPC call data", async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          result:
            "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }),
    });
    vi.stubGlobal("fetch", spy);
    const manager = new SmartAccountManager(createTestConfig());
    await manager.getAccountAddress(createAccountConfig({ salt: 42n }));
    const body = JSON.parse(spy.mock.calls[0][1].body);
    const data = body.params[0].data as string;
    // salt = 0x2a padded to 64 hex chars
    expect(data).toContain(
      "000000000000000000000000000000000000000000000000000000000000002a",
    );
  });
});

// ─── createAccount (full flow) ──────────────────────────────────

describe("createAccount (full flow)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns deployed=true and correct address when contract exists", async () => {
    const results: unknown[] = [
      "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0x6080604052",
    ];
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => ({
        ok: true,
        json: () => Promise.resolve({ result: results[i++] }),
      })),
    );
    const info = await new SmartAccountManager(
      createTestConfig(),
    ).createAccount(createAccountConfig());
    expect(info.isDeployed).toBe(true);
    expect(info.address).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("returns deployed=false when contract not deployed", async () => {
    const results: unknown[] = [
      "0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "0x",
    ];
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => ({
        ok: true,
        json: () => Promise.resolve({ result: results[i++] }),
      })),
    );
    const info = await new SmartAccountManager(
      createTestConfig(),
    ).createAccount(createAccountConfig());
    expect(info.isDeployed).toBe(false);
    expect(info.address).toBe("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("sets owner and accountType in returned info", async () => {
    const results: unknown[] = [
      "0x000000000000000000000000cccccccccccccccccccccccccccccccccccccccc",
      "0x",
    ];
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => ({
        ok: true,
        json: () => Promise.resolve({ result: results[i++] }),
      })),
    );
    const info = await new SmartAccountManager(
      createTestConfig(),
    ).createAccount(createAccountConfig());
    expect(info.owner).toBe(TEST_OWNER);
    expect(info.accountType).toBe("simple");
  });
});

// ─── deployAccount ──────────────────────────────────────────────

describe("deployAccount", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns address when account is already deployed", async () => {
    const results: unknown[] = [
      "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0x6080604052",
    ];
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => ({
        ok: true,
        json: () => Promise.resolve({ result: results[i++] }),
      })),
    );
    const result = await new SmartAccountManager(
      createTestConfig(),
    ).deployAccount(createAccountConfig());
    expect(result).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("throws aa_account_not_deployed when not deployed", async () => {
    const results: unknown[] = [
      "0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "0x",
    ];
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => ({
        ok: true,
        json: () => Promise.resolve({ result: results[i++] }),
      })),
    );
    await expect(
      new SmartAccountManager(createTestConfig()).deployAccount(
        createAccountConfig(),
      ),
    ).rejects.toHaveProperty("code", "aa_account_not_deployed");
  });
});

// ─── getDeployCallData ──────────────────────────────────────────

describe("getDeployCallData", () => {
  it("returns factory address as to, encoded data, and zero value", async () => {
    const manager = new SmartAccountManager(createTestConfig());
    const result = await manager.getDeployCallData(createAccountConfig());
    expect(result.to).toBe("0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985");
    expect(result.data).toContain("0x5fbfb9cf");
    expect(result.value).toBe(0n);
  });

  /**
   * Derive the selector instead of asserting a literal.
   *
   * The previous value (0xcf7aba77) matched no factory signature, and the
   * tests hard-coded it — they were written against the implementation rather
   * than the ABI, so they locked the defect in instead of catching it. A
   * selector is a pure function of its signature, so compute it.
   */
  it("uses the selector derived from createAccount(address,uint256)", async () => {
    const expected = `0x${bytesToHex(
      keccak_256(new TextEncoder().encode("createAccount(address,uint256)")),
    ).slice(0, 8)}`;
    const manager = new SmartAccountManager(createTestConfig());
    const result = await manager.getDeployCallData(createAccountConfig());
    expect(result.data.slice(0, 10)).toBe(expected);
  });

  it("encodes owner and custom salt in data", async () => {
    const manager = new SmartAccountManager(createTestConfig());
    const result = await manager.getDeployCallData(
      createAccountConfig({ salt: 7n }),
    );
    const ownerPadded = TEST_OWNER.toLowerCase()
      .replace("0x", "")
      .padStart(64, "0");
    expect(result.data).toBe(
      `0x5fbfb9cf${ownerPadded}0000000000000000000000000000000000000000000000000000000000000007`,
    );
  });
});

// ─── sendUserOperation (full flow) ──────────────────────────────

describe("sendUserOperation (full flow)", () => {
  const RPC_URL = "https://eth.llamarpc.com";
  const BUNDLER_URL = "https://api.pimlico.io/v2/1/rpc?apikey=test";
  const TEST_CALL: Call = {
    to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address,
    value: 0n,
    data: "0x",
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockSequential(
    rpcResults: unknown[],
    bundlerResult: unknown,
    injectExtra = true,
  ) {
    let rpcIdx = 0;
    let bundlerCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === BUNDLER_URL) {
          bundlerCalled = true;
          const body = init?.body ? JSON.parse(init.body as string) : {};
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                result:
                  body.method === "eth_sendUserOperation"
                    ? TEST_USER_OP_HASH
                    : bundlerResult,
              }),
          };
        }
        // RPC URL
        if (rpcIdx < rpcResults.length) {
          return {
            ok: true,
            json: () => Promise.resolve({ result: rpcResults[rpcIdx++] }),
          };
        }
        // If more RPC calls expected than results, return fallback
        if (injectExtra) {
          return { ok: true, json: () => Promise.resolve({ result: "0x0" }) };
        }
        throw new Error(`Unexpected RPC call at index ${rpcIdx}`);
      }),
    );
  }

  it("sends a single call with deployed account", async () => {
    mockSequential(
      [
        "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "0x6080604052",
        "0x05",
        { baseFeePerGas: "0x9502f900" },
        "0x3b9aca00",
      ],
      {
        callGasLimit: "0x186a0",
        verificationGasLimit: "0x186a0",
        preVerificationGas: "0xc350",
      },
    );
    const response = await new SmartAccountManager(
      createTestConfig(),
    ).sendUserOperation(createAccountConfig(), [TEST_CALL]);
    expect(response.sender).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(response.nonce).toBe(5n);

    const bundlerCall = vi
      .mocked(fetch)
      .mock.calls.map(([, init]) =>
        init?.body ? JSON.parse(init.body as string) : null,
      )
      .find((body) => body?.method === "eth_sendUserOperation");
    const callData = bundlerCall?.params?.[0]?.callData;
    const target = TEST_CALL.to.slice(2).padStart(64, "0");
    expect(callData).toBe(
      `0xb61d27f6${target}${"0".repeat(64)}${"0".repeat(62)}60${"0".repeat(64)}`,
    );
  });

  it("handles batch calls with multiple entries", async () => {
    mockSequential(
      [
        "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "0x6080604052",
        "0x01",
        { baseFeePerGas: "0x9502f900" },
        "0x3b9aca00",
      ],
      {
        callGasLimit: "0x186a0",
        verificationGasLimit: "0x186a0",
        preVerificationGas: "0xc350",
      },
    );
    const response = await new SmartAccountManager(
      createTestConfig(),
    ).sendUserOperation(createAccountConfig(), [
      {
        to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address,
        value: 1n,
        data: "0x",
      },
      {
        to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address,
        value: 2n,
        data: "0x",
      },
    ]);
    expect(response.nonce).toBe(1n);
  });

  it("uses the v0.6 SimpleAccount batch ABI on v0.6 chains", async () => {
    const bundlerRequests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
        const body = options?.body ? JSON.parse(options.body as string) : {};
        if (url === BUNDLER_URL) {
          bundlerRequests.push(body);
          if (body.method === "eth_estimateUserOperationGas") {
            return {
              ok: true,
              json: () =>
                Promise.resolve({
                  result: {
                    callGasLimit: "0x186a0",
                    verificationGasLimit: "0x186a0",
                    preVerificationGas: "0xc350",
                  },
                }),
            };
          }
          return {
            ok: true,
            json: () => Promise.resolve({ result: "0x" + "ab".repeat(32) }),
          };
        }
        if (body.method === "eth_call") {
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                result: body.params[0].data.startsWith("0x5fbfb9cf")
                  ? "0x" + "0".repeat(24) + "aa".repeat(20)
                  : "0x01",
              }),
          };
        }
        if (body.method === "eth_getCode") {
          return {
            ok: true,
            json: () => Promise.resolve({ result: "0x6080" }),
          };
        }
        if (body.method === "eth_getBlockByNumber") {
          return {
            ok: true,
            json: () => Promise.resolve({ result: { baseFeePerGas: "0x1" } }),
          };
        }
        if (body.method === "eth_maxPriorityFeePerGas") {
          return { ok: true, json: () => Promise.resolve({ result: "0x1" }) };
        }
        throw new Error(`Unexpected RPC method ${body.method}`);
      }),
    );

    await new SmartAccountManager(
      createTestConfig({ chainId: "eip155:137" }),
    ).sendUserOperation(
      createAccountConfig({
        chainId: "eip155:137",
        entryPoint: TEST_ENTRY_POINT_V06,
      }),
      [
        { ...TEST_CALL, value: 0n },
        {
          to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address,
          value: 0n,
          data: "0x1234",
        },
      ],
      { skipDeploy: true },
    );

    const estimate = bundlerRequests.find(
      (request) => request.method === "eth_estimateUserOperationGas",
    );
    if (!estimate) throw new Error("missing estimate request");
    expect(
      (estimate.params as Array<Record<string, string>>)[0].callData,
    ).toMatch(/^0x18dfb3c7/);
    const send = bundlerRequests.find(
      (request) => request.method === "eth_sendUserOperation",
    );
    if (!send) throw new Error("missing send request");
    expect((send.params as Array<Record<string, string>>)[0].callData).toMatch(
      /^0x18dfb3c7/,
    );
  });

  it("generates initCode when account not deployed", async () => {
    mockSequential(
      [
        "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "0x",
        "0x02",
        { baseFeePerGas: "0x9502f900" },
        "0x3b9aca00",
      ],
      {
        callGasLimit: "0x186a0",
        verificationGasLimit: "0x186a0",
        preVerificationGas: "0xc350",
      },
    );
    const response = await new SmartAccountManager(
      createTestConfig(),
    ).sendUserOperation(createAccountConfig(), [TEST_CALL]);
    expect(response.sender).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("skips deploy check when skipDeploy option is true", async () => {
    // With skipDeploy, no eth_getCode is called
    mockSequential(
      [
        "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "0x03",
        { baseFeePerGas: "0x9502f900" },
        "0x3b9aca00",
      ],
      {
        callGasLimit: "0x186a0",
        verificationGasLimit: "0x186a0",
        preVerificationGas: "0xc350",
      },
    );
    const response = await new SmartAccountManager(
      createTestConfig(),
    ).sendUserOperation(createAccountConfig(), [TEST_CALL], {
      skipDeploy: true,
    });
    expect(response.sender).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("uses gas overrides when provided", async () => {
    mockSequential(
      [
        "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "0x03",
      ],
      {
        callGasLimit: "0x186a0",
        verificationGasLimit: "0x186a0",
        preVerificationGas: "0xc350",
      },
    );
    const response = await new SmartAccountManager(
      createTestConfig(),
    ).sendUserOperation(createAccountConfig(), [TEST_CALL], {
      skipDeploy: true,
      gasOverrides: {
        callGasLimit: 200_000n,
        verificationGasLimit: 150_000n,
        maxFeePerGas: 50_000_000_000n,
        maxPriorityFeePerGas: 2_000_000_000n,
      },
    });
    expect(response.sender).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("falls back to default gas when estimation fails", async () => {
    let rpcIdx = 0;
    const allowedRpcs: unknown[] = [
      "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0x03",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (url === BUNDLER_URL) {
          return { ok: false, json: () => Promise.resolve({}) };
        }
        return {
          ok: true,
          json: () => Promise.resolve({ result: allowedRpcs[rpcIdx++] }),
        };
      }),
    );
    await expect(
      new SmartAccountManager(createTestConfig()).sendUserOperation(
        createAccountConfig(),
        [TEST_CALL],
        {
          skipDeploy: true,
          gasOverrides: { maxFeePerGas: 50_000_000_000n },
        },
      ),
    ).rejects.toThrow();
  });

  it("rejects an explicit max fee below the chain priority fee", async () => {
    let rpcIdx = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, opts: RequestInit) => {
        const body = JSON.parse(opts.body as string) as { method: string };
        if (url === BUNDLER_URL) {
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                result: {
                  callGasLimit: "0x186a0",
                  verificationGasLimit: "0x186a0",
                  preVerificationGas: "0xc350",
                },
              }),
          };
        }
        if (body.method === "eth_maxPriorityFeePerGas") {
          return {
            ok: true,
            json: () => Promise.resolve({ result: "0x2" }),
          };
        }
        const results = [
          "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "0x0",
        ];
        return {
          ok: true,
          json: () => Promise.resolve({ result: results[rpcIdx++] }),
        };
      }),
    );
    await expect(
      new SmartAccountManager(createTestConfig()).sendUserOperation(
        createAccountConfig(),
        [TEST_CALL],
        { skipDeploy: true, gasOverrides: { maxFeePerGas: 1n } },
      ),
    ).rejects.toHaveProperty("code", "aa_invalid_input");
  });

  it("integrates with paymaster when paymaster config provided", async () => {
    const rpcResults: unknown[] = [
      "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0x6080604052",
      "0x04",
    ];
    let rpcIdx = 0;
    const userOpMethods: string[] = [];
    const userOpBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, opts: RequestInit) => {
        const body = JSON.parse(opts.body as string);
        userOpMethods.push(body.method);
        // ERC-7677 paymaster RPC
        if (body.method === "pm_getPaymasterStubData") {
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                result: {
                  paymaster: "0x2222222222222222222222222222222222222222",
                  paymasterData: "0xdeadbeef",
                  paymasterVerificationGasLimit: "0x1000",
                  paymasterPostOpGasLimit: "0x2000",
                  isFinal: false,
                },
              }),
          };
        }
        if (body.method === "pm_getPaymasterData") {
          userOpBodies.push(body.params[0]);
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                result: {
                  paymaster: "0x2222222222222222222222222222222222222222",
                  paymasterData: "0xcafebabe",
                },
              }),
          };
        }
        // Bundler RPC
        if (url === BUNDLER_URL) {
          userOpBodies.push(body.params[0]);
          if (body.method === "eth_sendUserOperation") {
            return {
              ok: true,
              json: () => Promise.resolve({ result: `0x${"11".repeat(32)}` }),
            };
          }
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                result: {
                  callGasLimit: "0x186a0",
                  verificationGasLimit: "0x186a0",
                  preVerificationGas: "0xc350",
                  paymasterVerificationGasLimit: "0x3000",
                },
              }),
          };
        }
        // RPC URL
        return {
          ok: true,
          json: () => Promise.resolve({ result: rpcResults[rpcIdx++] }),
        };
      }),
    );
    const response = await new SmartAccountManager(
      createTestConfig(),
    ).sendUserOperation(createAccountConfig(), [TEST_CALL], {
      skipDeploy: true,
      paymaster: { type: "sponsor", url: "https://paymaster.test" },
      gasOverrides: { maxFeePerGas: 50_000_000_000n },
    });
    expect(response.sender).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(userOpMethods).toEqual(
      expect.arrayContaining([
        "pm_getPaymasterStubData",
        "eth_estimateUserOperationGas",
        "pm_getPaymasterData",
        "eth_sendUserOperation",
      ]),
    );
    expect(userOpMethods.indexOf("pm_getPaymasterStubData")).toBeLessThan(
      userOpMethods.indexOf("eth_estimateUserOperationGas"),
    );
    expect(userOpMethods.indexOf("eth_estimateUserOperationGas")).toBeLessThan(
      userOpMethods.indexOf("pm_getPaymasterData"),
    );
    const estimateBody = userOpBodies[0];
    expect(estimateBody).toMatchObject({
      paymaster: "0x2222222222222222222222222222222222222222",
      paymasterVerificationGasLimit: "0x1000",
      paymasterPostOpGasLimit: "0x2000",
      paymasterData: "0xdeadbeef",
    });
    const finalBody = userOpBodies[1];
    expect(finalBody).toMatchObject({
      paymasterVerificationGasLimit: "0x3000",
      paymasterPostOpGasLimit: "0x2000",
    });
    const sendBody = userOpBodies[2];
    expect(sendBody).toMatchObject({
      paymasterVerificationGasLimit: "0x3000",
      paymasterPostOpGasLimit: "0x2000",
      paymasterData: "0xcafebabe",
    });
  });
});

// ─── sendBatch ──────────────────────────────────────────────────

describe("sendBatch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delegates to sendUserOperation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: "0x" }),
      }),
    );
    const manager = new SmartAccountManager(createTestConfig());
    const spy = vi.spyOn(manager, "sendUserOperation");
    await manager.sendBatch(createAccountConfig(), []).catch(() => {});
    expect(spy).toHaveBeenCalledOnce();
  });
});

// ─── getNonce ───────────────────────────────────────────────────

describe("getNonce", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns BigInt from eth_call result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: "0x0a" }),
      }),
    );
    const nonce = await new SmartAccountManager(createTestConfig()).getNonce(
      TEST_ENTRY_POINT,
      TEST_OWNER,
    );
    expect(nonce).toBe(10n);
  });

  it("encodes sender and key in call data", async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: "0x00" }),
    });
    vi.stubGlobal("fetch", spy);
    await new SmartAccountManager(createTestConfig()).getNonce(
      TEST_ENTRY_POINT,
      TEST_OWNER,
    );
    const body = JSON.parse(spy.mock.calls[0][1].body);
    const callData = body.params[0].data as string;
    expect(callData).toContain("0x35567e1a");
    expect(callData).toContain(
      TEST_OWNER.toLowerCase().replace("0x", "").padStart(64, "0"),
    );
  });
});

// ─── estimateUserOperationGas ───────────────────────────────────

describe("estimateUserOperationGas", () => {
  const BUNDLER_URL = "https://api.pimlico.io/v2/1/rpc?apikey=test";

  beforeEach(() => {
    // Source code passes BigInt defaults to JSON.stringify via rpcCall.
    // Override JSON.stringify to support BigInt so we can test the
    // response-parsing logic directly.
    const origStringify = JSON.stringify.bind(JSON);
    vi.stubGlobal("JSON", {
      parse: JSON.parse,
      stringify(value: unknown, replacer?: unknown, space?: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (origStringify as any)(
          value,
          (key: string, val: unknown) => {
            if (typeof val === "bigint") return `0x${val.toString(16)}`;
            return typeof replacer === "function"
              ? (replacer as (key: string, val: unknown) => unknown)(key, val)
              : val;
          },
          space,
        );
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed gas estimates from bundler response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            result: {
              callGasLimit: "0x186a0",
              verificationGasLimit: "0x186a0",
              preVerificationGas: "0xc350",
            },
          }),
      }),
    );
    const result = await new SmartAccountManager(
      createTestConfig(),
    ).estimateUserOperationGas(TEST_ENTRY_POINT, {
      sender: TEST_OWNER,
      callData: "0x1234",
    });
    expect(result.callGasLimit).toBe(100_000n);
    expect(result.verificationGasLimit).toBe(100_000n);
    expect(result.preVerificationGas).toBe(50_000n);
  });

  it("serializes v0.6 gas fields separately", async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          result: {
            callGasLimit: "0x10",
            verificationGasLimit: "0x20",
            preVerificationGas: "0x30",
          },
        }),
    });
    vi.stubGlobal("fetch", spy);

    const result = await new SmartAccountManager(
      createTestConfig({ chainId: "eip155:137" }),
    ).estimateUserOperationGas(
      "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789" as `0x${string}`,
      {
        accountGasLimits: encodeGasLimits(32n, 16n),
        maxFeePerGas: 100n,
        maxPriorityFeePerGas: 2n,
      },
      "0.6",
    );

    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body.params[0]).toMatchObject({
      callGasLimit: "0x10",
      verificationGasLimit: "0x20",
      maxFeePerGas: "0x64",
      maxPriorityFeePerGas: "0x2",
    });
    expect(body.params[0].accountGasLimits).toBeUndefined();
    expect(body.params[0].gasFees).toBeUndefined();
    expect(result.callGasLimit).toBe(16n);
    expect(result.verificationGasLimit).toBe(32n);
  });

  it("fails closed when result fields are missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: {} }),
      }),
    );
    await expect(
      new SmartAccountManager(createTestConfig()).estimateUserOperationGas(
        TEST_ENTRY_POINT,
        {},
      ),
    ).rejects.toMatchObject({ code: "aa_estimation_failed" });
  });

  it("fills default values for undefined partialUserOp fields in RPC call", async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { callGasLimit: "0x186a0" } }),
    });
    vi.stubGlobal("fetch", spy);
    await expect(
      new SmartAccountManager(createTestConfig()).estimateUserOperationGas(
        TEST_ENTRY_POINT,
        {},
      ),
    ).rejects.toMatchObject({ code: "aa_estimation_failed" });
    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body.params[0].sender).toBe(
      "0x0000000000000000000000000000000000000000",
    );
    expect(body.params[0].nonce).toBe("0x0");
    expect(body.params[0].initCode).toBeUndefined();
    expect(body.params[0].factory).toBeUndefined();
    expect(body.params[0].callGasLimit).toBe("0x0");
    expect(body.params[0].verificationGasLimit).toBe("0x0");
    expect(body.params[0].accountGasLimits).toBeUndefined();
  });

  it("handles v0.7 accountGasLimits in bundler response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            result: {
              accountGasLimits:
                "0x000000000000000000000000000186a0000000000000000000000000000186a0",
              preVerificationGas: "0xc350",
            },
          }),
      }),
    );
    const result = await new SmartAccountManager(
      createTestConfig(),
    ).estimateUserOperationGas(TEST_ENTRY_POINT, {});
    expect(result.accountGasLimits).toBeDefined();
    expect(result.preVerificationGas).toBe(50_000n);
  });
});

// ─── sendUserOpToBundler ────────────────────────────────────────

describe("sendUserOpToBundler", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const USER_OP: UserOperation = {
    sender: TEST_OWNER,
    nonce: 5n,
    initCode: "0x",
    callData: "0x1234",
    accountGasLimits:
      "0x000000000000000000000000000186a0000000000000000000000000000186a0",
    preVerificationGas: 50_000n,
    maxFeePerGas: 50_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    paymasterAndData: "0x",
    signature: "0x",
  };

  it("returns userOpHash from bundler", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: TEST_USER_OP_HASH }),
      }),
    );
    const hash = await new SmartAccountManager(
      createTestConfig(),
    ).sendUserOpToBundler(USER_OP);
    expect(hash).toBe(TEST_USER_OP_HASH);
  });

  it("serializes bigint fields to hex strings", async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: TEST_USER_OP_HASH }),
    });
    vi.stubGlobal("fetch", spy);
    await new SmartAccountManager(createTestConfig()).sendUserOpToBundler(
      USER_OP,
    );
    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body.params[0].nonce).toBe("0x5");
    expect(body.params[0].preVerificationGas).toBe("0xc350");
    expect(body.params[0].callGasLimit).toBe("0x186a0");
    expect(body.params[0].verificationGasLimit).toBe("0x186a0");
    expect(body.params[0].maxFeePerGas).toBe("0xba43b7400");
    expect(body.params[0].maxPriorityFeePerGas).toBe("0x3b9aca00");
    expect(body.params[0].accountGasLimits).toBeUndefined();
    expect(body.params[0].gasFees).toBeUndefined();
  });

  it("splits v0.7 factory and paymaster fields for the bundler RPC", async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: TEST_USER_OP_HASH }),
    });
    vi.stubGlobal("fetch", spy);
    const factoryData = "0x1234";
    const paymasterData = "abcd";
    const userOp: UserOperation = {
      ...USER_OP,
      initCode: `${TEST_OWNER}${factoryData.slice(2)}` as Hex,
      paymasterAndData:
        `${TEST_OWNER}${"10".padStart(32, "0")}${"20".padStart(32, "0")}${paymasterData}` as Hex,
    };

    await new SmartAccountManager(createTestConfig()).sendUserOpToBundler(
      userOp,
    );
    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body.params[0]).toMatchObject({
      factory: TEST_OWNER,
      factoryData,
      paymaster: TEST_OWNER,
      paymasterVerificationGasLimit: "0x10",
      paymasterPostOpGasLimit: "0x20",
      paymasterData: `0x${paymasterData}`,
    });
    expect(body.params[0].initCode).toBeUndefined();
    expect(body.params[0].paymasterAndData).toBeUndefined();
  });

  it("throws aa_no_bundler when bundler URL is empty", async () => {
    const manager = new SmartAccountManager(
      createTestConfig({ bundlerClient: { url: "" } }),
    );
    await expect(manager.sendUserOpToBundler(USER_OP)).rejects.toHaveProperty(
      "code",
      "aa_no_bundler",
    );
  });

  it("rejects an EntryPoint/version pair that does not match the manager chain", async () => {
    const manager = new SmartAccountManager(createTestConfig());
    await expect(
      manager.sendUserOpToBundler(USER_OP, TEST_ENTRY_POINT_V06, "0.6"),
    ).rejects.toHaveProperty("code", "aa_invalid_input");
  });

  it("rejects a malformed hash returned by the bundler", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: "0x1234" }),
      }),
    );
    await expect(
      new SmartAccountManager(createTestConfig()).sendUserOpToBundler(USER_OP),
    ).rejects.toMatchObject({ code: "aa_rpc_error" });
  });
});

// ─── getUserOperationReceipt ────────────────────────────────────

describe("getUserOperationReceipt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const RECEIPT_RESULT = {
    userOpHash: TEST_USER_OP_HASH,
    entryPoint: TEST_ENTRY_POINT,
    sender: TEST_OWNER,
    nonce: "0x5",
    paymaster: ADDRESSES.ZERO as Address,
    actualGasUsed: "0x186a0",
    actualGasCost: "0x1",
    success: true,
    transactionHash: TEST_TRANSACTION_HASH,
    logs: [
      {
        address: TEST_OWNER as Address,
        topics: [] as Hex[],
        data: "0x" as Hex,
      },
    ],
  };

  it("returns receipt when bundler returns a result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: RECEIPT_RESULT }),
      }),
    );
    const receipt = await new SmartAccountManager(
      createTestConfig(),
    ).getUserOperationReceipt(TEST_USER_OP_HASH);
    expect(receipt).not.toBeNull();
    expect(receipt!.success).toBe(true);
    expect(receipt!.userOpHash).toBe(TEST_USER_OP_HASH);
    expect(receipt!.nonce).toBe(5n);
    expect(receipt!.actualGasUsed).toBe(100_000n);
  });

  it("throws after maxAttempts when result is null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: null }),
      }),
    );
    await expect(
      new SmartAccountManager(createTestConfig()).getUserOperationReceipt(
        TEST_USER_OP_HASH,
        2,
        5,
      ),
    ).rejects.toHaveProperty("code", "aa_receipt_timeout");
  });

  it("continues polling when RPC throws", async () => {
    let failures = 1;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        if (failures-- > 0) throw new Error("RPC error");
        return {
          ok: true,
          json: () => Promise.resolve({ result: RECEIPT_RESULT }),
        };
      }),
    );
    const receipt = await new SmartAccountManager(
      createTestConfig(),
    ).getUserOperationReceipt(TEST_USER_OP_HASH, 3, 5);
    expect(receipt).not.toBeNull();
    expect(receipt!.success).toBe(true);
  });

  it("rejects a receipt for a different UserOperation hash", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          result: { ...RECEIPT_RESULT, userOpHash: OTHER_USER_OP_HASH },
        }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      new SmartAccountManager(createTestConfig()).getUserOperationReceipt(
        TEST_USER_OP_HASH,
        3,
        0,
      ),
    ).rejects.toMatchObject({ code: "aa_rpc_error" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a receipt from a different EntryPoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            result: { ...RECEIPT_RESULT, entryPoint: TEST_ENTRY_POINT_V06 },
          }),
      }),
    );

    await expect(
      new SmartAccountManager(createTestConfig()).getUserOperationReceipt(
        TEST_USER_OP_HASH,
      ),
    ).rejects.toMatchObject({ code: "aa_rpc_error" });
  });

  it("rejects malformed receipt fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            result: { ...RECEIPT_RESULT, transactionHash: "0x1234" },
          }),
      }),
    );

    await expect(
      new SmartAccountManager(createTestConfig()).getUserOperationReceipt(
        TEST_USER_OP_HASH,
      ),
    ).rejects.toMatchObject({ code: "aa_rpc_error" });
  });

  it("rejects missing bundler configuration before polling", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      new SmartAccountManager(
        createTestConfig({ bundlerClient: { url: "" } }),
      ).getUserOperationReceipt(TEST_USER_OP_HASH),
    ).rejects.toMatchObject({ code: "aa_no_bundler" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed requested hashes before polling", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      new SmartAccountManager(createTestConfig()).getUserOperationReceipt(
        "0x1234" as Hex,
      ),
    ).rejects.toMatchObject({ code: "aa_invalid_input" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─── getBaseFee (success path) ──────────────────────────────────

describe("getBaseFee (success path)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed base fee from eth_getBlockByNumber", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ result: { baseFeePerGas: "0x9502f900" } }),
      }),
    );
    const fee = await new SmartAccountManager(createTestConfig()).getBaseFee();
    expect(fee).toBe(2_500_000_000n);
  });
});

// ─── getPriorityFee (success path) ──────────────────────────────

describe("getPriorityFee (success path)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed priority fee from eth_maxPriorityFeePerGas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: "0x3b9aca00" }),
      }),
    );
    const fee = await new SmartAccountManager(
      createTestConfig(),
    ).getPriorityFee();
    expect(fee).toBe(1_000_000_000n);
  });
});

// ─── Error paths through private helpers ────────────────────────

describe("AA errors from private helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws aa_no_entry_point for unsupported chain when entryPoint not provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: "0x" }),
      }),
    );
    const config = createAccountConfig({
      chainId: "eip155:56",
      entryPoint: undefined as unknown as Address,
    });
    await expect(
      new SmartAccountManager(createTestConfig()).createAccount(config),
    ).rejects.toHaveProperty("code", "aa_no_entry_point");
  });

  it("rejects an account chain that does not match the manager transport", async () => {
    await expect(
      new SmartAccountManager(createTestConfig()).createAccount(
        createAccountConfig({ chainId: "eip155:137" }),
      ),
    ).rejects.toHaveProperty("code", "aa_invalid_input");
  });

  it("getEntryPoint resolves entryPoint from AA_SUPPORTED_CHAINS when not provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("eth_getCode")) {
          return { ok: true, json: () => Promise.resolve({ result: "0x" }) };
        }
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              result:
                "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            }),
        };
      }),
    );
    const config = createAccountConfig({
      entryPoint: undefined as unknown as Address,
    });
    const info = await new SmartAccountManager(
      createTestConfig(),
    ).createAccount(config);
    // getEntryPoint was called internally and returned the entryPoint for eip155:1
    expect(info.address).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("throws aa_rpc_error when RPC returns an error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            error: { code: -32000, message: "execution reverted" },
          }),
      }),
    );
    const manager = new SmartAccountManager(createTestConfig());
    await expect(
      manager.getNonce(TEST_ENTRY_POINT, TEST_OWNER),
    ).rejects.toHaveProperty("code", "aa_rpc_error");
  });
});

describe("chain support boundary", () => {
  /**
   * Account abstraction is EVM-only by construction, so the question is not
   * whether other chains work but whether they are refused clearly. Two layers
   * do it: validateAccountConfig rejects a chain with no EntryPoint, and the
   * factory lookup no longer falls back to the default v0.7 address for a
   * chain the registry does not know. The second layer is unreachable while
   * the first holds — which is the point of having it.
   */
  it("refuses an unregistered EVM chain", async () => {
    const manager = new SmartAccountManager(createTestConfig());
    await expect(
      manager.getAccountAddress(
        createAccountConfig({ chainId: "eip155:999999" }),
      ),
    ).rejects.toHaveProperty("code", "aa_no_entry_point");
  });

  it("refuses a non-EVM chain rather than coercing it into a BigInt", async () => {
    // BigInt("5eykt4Us…") throws an opaque SyntaxError; the caller should be
    // told the chain is unsupported instead.
    const manager = new SmartAccountManager(createTestConfig());
    await expect(
      manager.getAccountAddress(
        createAccountConfig({
          chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        }),
      ),
    ).rejects.toHaveProperty("code", "aa_no_entry_point");
  });

  it("still names the account type when that is what is unsupported", async () => {
    const manager = new SmartAccountManager(createTestConfig());
    await expect(
      manager.getAccountAddress(
        createAccountConfig({ accountType: "kernel" as never }),
      ),
    ).rejects.toHaveProperty("code", "aa_unknown_account_type");
  });
});

describe("bundler configuration", () => {
  /**
   * sendUserOperation refused an unconfigured bundler with aa_no_bundler;
   * estimateUserOperationGas read the same empty URL and went straight to the
   * RPC call, so the caller saw a fetch failure against "" rather than being
   * told which piece of configuration was missing. appkit's useSmartAccount
   * passes `bundlerUrl ?? ""`, so an omitted URL reaches here routinely.
   */
  const noBundler = () =>
    new SmartAccountManager({
      ...createTestConfig(),
      bundlerClient: { url: "" },
    } as never);

  it("names the missing bundler when estimating gas", async () => {
    const manager = noBundler();
    const entryPoint = (
      manager as unknown as { getEntryPoint(c: string): string }
    ).getEntryPoint(createTestConfig().chainId as string);
    await expect(
      manager.estimateUserOperationGas(
        entryPoint as never,
        {
          sender: `0x${"11".repeat(20)}`,
        } as never,
      ),
    ).rejects.toHaveProperty("code", "aa_no_bundler");
  });
});

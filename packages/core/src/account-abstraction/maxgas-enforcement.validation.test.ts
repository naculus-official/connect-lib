import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SmartAccountManager,
  type SmartAccountManagerConfig,
} from "./SmartAccountManager";
import type { Address, Call, Hex, SmartAccountConfig } from "./types";

const RPC_URL = "https://rpc.invalid";
const BUNDLER_URL = "https://bundler.invalid";
const PAYMASTER_URL = "https://paymaster.invalid";
const OWNER = "0x1234567890123456789012345678901234567890" as Address;
const ACCOUNT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const PAYMASTER = "0x2222222222222222222222222222222222222222" as Address;
const MAX_GAS = 100_000n;
const OVER_MAX_GAS = 100_001n;
const SIGNATURE = `0x${"ab".repeat(65)}` as Hex;
const USER_OP_HASH = `0x${"cd".repeat(32)}` as Hex;
const CALL: Call = {
  to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address,
  value: 0n,
  data: "0x",
};

interface HarnessResult {
  signer: ReturnType<typeof vi.fn>;
  submittedUserOps: Array<Record<string, string>>;
  run: () => Promise<unknown>;
}

interface HarnessOptions {
  callGas?: bigint;
  finalPaymasterVerificationGas?: bigint;
  maxGas?: unknown;
}

function createHarness(
  version: "0.6" | "0.7",
  {
    callGas = OVER_MAX_GAS,
    finalPaymasterVerificationGas,
    maxGas = MAX_GAS,
  }: HarnessOptions = {},
): HarnessResult {
  const signer = vi.fn(async () => SIGNATURE);
  const submittedUserOps: Array<Record<string, string>> = [];
  const chainId = version === "0.6" ? "eip155:137" : "eip155:1";
  const entryPoint =
    version === "0.6"
      ? ("0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789" as Address)
      : ("0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body
        ? (JSON.parse(init.body as string) as {
            method: string;
            params: Array<Record<string, string>>;
          })
        : { method: "", params: [] };

      if (url === BUNDLER_URL) {
        if (body.method === "eth_estimateUserOperationGas") {
          return {
            ok: true,
            json: async () => ({
              result: {
                callGasLimit: `0x${callGas.toString(16)}`,
                verificationGasLimit: "0x1000",
                preVerificationGas: "0x1000",
                ...(finalPaymasterVerificationGas === undefined
                  ? {}
                  : {
                      paymasterVerificationGasLimit: `0x${finalPaymasterVerificationGas.toString(16)}`,
                    }),
              },
            }),
          };
        }
        if (body.method === "eth_sendUserOperation") {
          submittedUserOps.push(body.params[0]);
          return { ok: true, json: async () => ({ result: USER_OP_HASH }) };
        }
      }

      if (url === PAYMASTER_URL) {
        const isStub = body.method === "pm_getPaymasterStubData";
        return {
          ok: true,
          json: async () => ({
            result:
              version === "0.6"
                ? {
                    paymasterAndData: `${PAYMASTER}${isStub ? "deadbeef" : "cafebabe"}`,
                    isFinal: !isStub,
                  }
                : {
                    paymaster: PAYMASTER,
                    paymasterData: isStub ? "0xdeadbeef" : "0xcafebabe",
                    paymasterVerificationGasLimit: isStub
                      ? "0x1000"
                      : `0x${finalPaymasterVerificationGas?.toString(16) ?? "1000"}`,
                    paymasterPostOpGasLimit: "0x2000",
                    isFinal: !isStub,
                  },
          }),
        };
      }

      if (url === RPC_URL && body.method === "eth_call") {
        const data = body.params[0]?.data;
        return {
          ok: true,
          json: async () => ({
            result: data?.startsWith("0x5fbfb9cf")
              ? `0x${"0".repeat(24)}${ACCOUNT.slice(2)}`
              : "0x0",
          }),
        };
      }

      throw new Error(`Unexpected mocked request: ${url} ${body.method}`);
    }),
  );

  const managerConfig: SmartAccountManagerConfig = {
    rpcUrl: RPC_URL,
    bundlerClient: { url: BUNDLER_URL },
    chainId,
    signer,
  };
  const accountConfig: SmartAccountConfig = {
    owner: OWNER,
    accountType: "simple",
    entryPoint,
    chainId,
  };

  return {
    signer,
    submittedUserOps,
    run: () =>
      new SmartAccountManager(managerConfig).sendUserOperation(
        accountConfig,
        [CALL],
        {
          skipDeploy: true,
          paymaster: {
            type: "sponsor",
            url: PAYMASTER_URL,
            policy: { maxGasPerUserOp: maxGas as bigint },
          },
          gasOverrides: {
            maxFeePerGas: 2n,
            maxPriorityFeePerGas: 1n,
          },
        },
      ),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("maxGasPerUserOp enforcement validation (run without OS sandbox)", () => {
  // maxGasPerUserOp bounds the SUM of callGasLimit, verificationGasLimit,
  // preVerificationGas and (v0.7) both paymaster gas limits.
  // Fingerprint: core/account-abstraction/paymaster/maxGasPerUserOp-unenforced
  it("rejects an over-limit v0.6 callGasLimit before signing", async () => {
    const harness = createHarness("0.6");
    await expect(harness.run()).rejects.toThrow(
      /total gas \d+ exceeds paymaster\.policy\.maxGasPerUserOp 100000/,
    );

    expect(harness.signer).not.toHaveBeenCalled();
    expect(harness.submittedUserOps).toHaveLength(0);
  });

  // Fingerprint: core/account-abstraction/paymaster/maxGasPerUserOp-unenforced
  it("rejects an over-limit v0.7 callGasLimit before signing", async () => {
    const harness = createHarness("0.7");
    await expect(harness.run()).rejects.toThrow(
      /total gas \d+ exceeds paymaster\.policy\.maxGasPerUserOp 100000/,
    );

    expect(harness.signer).not.toHaveBeenCalled();
    expect(harness.submittedUserOps).toHaveLength(0);
  });

  // Fingerprint: core/account-abstraction/paymaster/maxGasPerUserOp-unenforced
  it("rejects an over-limit final paymaster gas field before signing", async () => {
    const harness = createHarness("0.7", {
      callGas: 0x1000n,
      finalPaymasterVerificationGas: OVER_MAX_GAS,
    });
    await expect(harness.run()).rejects.toThrow(
      /total gas \d+ exceeds paymaster\.policy\.maxGasPerUserOp 100000/,
    );

    expect(harness.signer).not.toHaveBeenCalled();
    expect(harness.submittedUserOps).toHaveLength(0);
  });

  // Every field is under the maximum, but 30000 + 4096 + 4096 + 60000 + 8192
  // = 106384 is over it.
  // Fingerprint: core/account-abstraction/paymaster/maxGasPerUserOp-unenforced
  it("rejects a v0.7 operation whose fields are each under the max but sum over it", async () => {
    const harness = createHarness("0.7", {
      callGas: 30_000n,
      finalPaymasterVerificationGas: 60_000n,
    });
    await expect(harness.run()).rejects.toThrow(
      /total gas 106384 exceeds paymaster\.policy\.maxGasPerUserOp 100000/,
    );

    expect(harness.signer).not.toHaveBeenCalled();
    expect(harness.submittedUserOps).toHaveLength(0);
  });

  it.each([
    ["a negative bigint", -1n],
    ["a number", 100_000],
  ])(
    "rejects maxGasPerUserOp given as %s before signing",
    async (_label, maxGas) => {
      const harness = createHarness("0.7", { callGas: 0x1000n, maxGas });
      await expect(harness.run()).rejects.toThrow(
        /maxGasPerUserOp must be a non-negative bigint/,
      );

      expect(harness.signer).not.toHaveBeenCalled();
      expect(harness.submittedUserOps).toHaveLength(0);
    },
  );

  // Total 4096 * 4 + 8192 = 24576, under the maximum.
  it("still signs a v0.7 operation whose total gas is within the limit", async () => {
    const harness = createHarness("0.7", { callGas: 0x1000n });
    await expect(harness.run()).resolves.toBeDefined();

    expect(harness.signer).toHaveBeenCalledTimes(1);
    expect(harness.submittedUserOps).toHaveLength(1);
  });

  // Total 4096 * 3 = 12288, under the maximum.
  it("still signs a v0.6 operation whose total gas is within the limit", async () => {
    const harness = createHarness("0.6", { callGas: 0x1000n });
    await expect(harness.run()).resolves.toBeDefined();

    expect(harness.signer).toHaveBeenCalledTimes(1);
    expect(harness.submittedUserOps).toHaveLength(1);
  });
});

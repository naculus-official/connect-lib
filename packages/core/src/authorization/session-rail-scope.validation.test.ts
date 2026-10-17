import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { SOLANA_MAINNET } from "../constants";
import { SessionKeyManager } from "../session-keys/SessionKeyManager";
import {
  type SessionKeyTypedDataRequest,
  sessionKeyAddress,
} from "../session-keys/typed-data";
import type { SessionKeyScope } from "../session-keys/types";
import { MemoryStorageAdapter } from "../storage";
import {
  type Authorization,
  compileEvmSessionScope,
  compileSolanaSessionScope,
  evaluateSpend,
} from ".";

const OWNER_KEY = new Uint8Array(32).fill(0x42);
const OWNER = sessionKeyAddress(
  `0x${bytesToHex(secp256k1.getPublicKey(OWNER_KEY))}`,
);
const TOKEN = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const PAYEE = "0x1111111111111111111111111111111111111111";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_PAYEE = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const EXPIRES_AT = Math.floor(Date.now() / 1000) + 3_600;

type Rails = Authorization["grants"][number]["rails"];

function authorization(rails: Rails, maxPerPayment = 10n): Authorization {
  return {
    version: 1,
    principal: `eip155:1:${OWNER}`,
    grants: [
      {
        asset: `eip155:1/erc20:${TOKEN}`,
        recipients: [PAYEE],
        maxPerPayment,
        maxTotal: 100n,
        rails,
      },
    ],
    expiresAt: EXPIRES_AT,
  };
}

function solanaAuthorization(rails: Rails): Authorization {
  return {
    version: 1,
    principal: `${SOLANA_MAINNET}:9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu`,
    grants: [
      {
        asset: `${SOLANA_MAINNET}/token:${MINT}`,
        recipients: [SOL_PAYEE],
        maxPerPayment: 10n,
        maxTotal: 100n,
        rails,
      },
    ],
    expiresAt: EXPIRES_AT,
  };
}

function newManager(): SessionKeyManager {
  return new SessionKeyManager(
    {
      pbkdf2Iterations: 10,
      unsafeAllowWeakKdf: true,
      encryptionKey: "validation-only",
    },
    new MemoryStorageAdapter(),
  );
}

/** Create an owner-authorized key for `scope` and sign one EIP-3009 transfer. */
async function signEip3009(scope: SessionKeyScope): Promise<string> {
  const manager = new SessionKeyManager(
    {
      pbkdf2Iterations: 10,
      unsafeAllowWeakKdf: true,
      encryptionKey: "validation-only",
    },
    new MemoryStorageAdapter(),
  );
  const info = await manager.createSessionKey(scope, OWNER);
  const message = "validation-only owner authorization";
  const digest = sha256(new TextEncoder().encode(message));
  const signature = secp256k1.sign(digest, OWNER_KEY, {
    prehash: false,
    format: "recovered",
  });
  const rawSignature =
    `0x${bytesToHex(signature.subarray(1))}${((signature[0] as number) + 27).toString(16)}` as const;
  await manager.setAuthorization(info.id, {
    signerAddress: OWNER,
    type: "offchain",
    rawSignature,
    message,
  });
  const request: SessionKeyTypedDataRequest = {
    domain: {
      name: "Dummy Token",
      version: "1",
      chainId: 1,
      verifyingContract: TOKEN,
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: sessionKeyAddress(info.publicKey),
      to: PAYEE,
      value: "10",
      validAfter: "0",
      validBefore: String(EXPIRES_AT - 60),
      nonce: `0x${"ab".repeat(32)}`,
    },
  };
  return manager.signTypedDataWithVerifiedOffchainAuthorization(
    info.id,
    () => message,
    async () => true,
    request,
  );
}

describe("session rail scope validation", () => {
  it("evaluateSpend denies x402-exact under a transfer-only owner grant", () => {
    expect(
      evaluateSpend(authorization(["transfer"]), {
        asset: `eip155:1/erc20:${TOKEN}`,
        recipient: PAYEE,
        amount: 10n,
        rail: "x402-exact",
        at: EXPIRES_AT - 60,
        spentSoFar: 0n,
        countSoFar: 0,
      }),
    ).toEqual({ allow: false, reason: "rail-not-allowed" });
  });

  // Fingerprint core/authorization/compile-session-scope/rail-erasure:
  // a transfer-only owner grant compiles for both device and on-chain use;
  // the scope records the rail, and the key refuses EIP-3009 when it signs.
  it("refuses EIP-3009 signing for a transfer-only grant at signing time", async () => {
    const offchain = compileEvmSessionScope(authorization(["transfer"]), 1);
    const onchain = compileEvmSessionScope(
      authorization(["transfer"], 100n),
      1,
      { mode: "eip7702" },
    );
    expect(offchain).toMatchObject({
      ok: true,
      enforcement: "device",
      scope: { rails: ["transfer"] },
    });
    expect(onchain).toMatchObject({
      ok: true,
      enforcement: "on-chain",
      scope: { rails: ["transfer"] },
    });
    if (!offchain.ok) return;
    await expect(signEip3009(offchain.scope)).rejects.toThrow(
      "TransferWithAuthorization needs an x402-exact or mpp-charge rail",
    );
  });

  it("still signs EIP-3009 for a transfer+x402 grant", async () => {
    const compiled = compileEvmSessionScope(
      authorization(["transfer", "x402-exact"]),
      1,
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    await expect(signEip3009(compiled.scope)).resolves.toMatch(
      /^0x[0-9a-fA-F]{130}$/,
    );
  });

  // A scope without the field (written before it existed, or by hand) names
  // no EIP-3009 rail, so it fails closed.
  it("refuses EIP-3009 signing for a scope that names no rail", async () => {
    const compiled = compileEvmSessionScope(
      authorization(["transfer", "x402-exact"]),
      1,
    );
    if (!compiled.ok) throw new Error(compiled.reason);
    const { rails: _rails, ...legacy } = compiled.scope;
    await expect(signEip3009(legacy)).rejects.toThrow(
      "TransferWithAuthorization needs an x402-exact or mpp-charge rail",
    );
  });

  // The Solana scope signs the same TransferChecked for every rail it
  // covers, so a rail subset grants no extra power and still compiles.
  it("compiles a Solana rail subset", () => {
    expect(
      compileSolanaSessionScope(
        solanaAuthorization(["transfer"]),
        SOLANA_MAINNET,
      ),
    ).toMatchObject({ ok: true, enforcement: "device" });
    expect(
      compileSolanaSessionScope(
        solanaAuthorization(["transfer", "x402-exact"]),
        SOLANA_MAINNET,
      ),
    ).toMatchObject({ ok: true, enforcement: "device" });
  });

  it("refuses a raw digest and the raw key while rails is set", async () => {
    const manager = newManager();
    const info = await manager.createSessionKey(
      { expiry: EXPIRES_AT, allowedContracts: [TOKEN], rails: ["transfer"] },
      OWNER,
    );
    const refusal = {
      code: "session_key_scope_exceeded",
      details:
        "This session key limits rails; a raw digest cannot be bound to a rail. Use signTypedDataWithSessionKey.",
    };
    await expect(manager.getSessionBundle(info.id)).rejects.toMatchObject(
      refusal,
    );
    await expect(
      manager.signWithSessionKey(info.id, `0x${"11".repeat(32)}`),
    ).rejects.toMatchObject(refusal);
  });

  it("refuses a delegation and its redemption without the transfer rail", async () => {
    const compiled = compileEvmSessionScope(
      authorization(["transfer"], 100n),
      1,
      { mode: "eip7702" },
    );
    if (!compiled.ok) throw new Error(compiled.reason);
    const manager = newManager();
    const info = await manager.createSessionKey(
      { ...compiled.scope, rails: ["x402-exact"] },
      OWNER,
    );
    await expect(manager.prepareDelegation(info.id, 1)).rejects.toMatchObject({
      code: "session_key_invalid_input",
      details:
        "Cannot express this scope as an EIP-7702 delegation: rails does not include transfer",
    });
    await expect(
      manager.signDelegationRedemption(
        info.id,
        `0x${"11".repeat(32)}`,
        { chainId: 1, value: "0", data: "0x" },
        { target: TOKEN, value: 0n, callData: "0x" },
      ),
    ).rejects.toMatchObject({
      code: "session_key_scope_exceeded",
      details:
        "A delegation redemption needs the transfer rail in the session scope",
    });
  });

  it("rejects an empty, duplicated or unknown rails list", async () => {
    const manager = newManager();
    for (const rails of [[], ["transfer", "transfer"], ["bogus"]]) {
      await expect(
        manager.createSessionKey({
          expiry: EXPIRES_AT,
          rails: rails as SessionKeyScope["rails"],
        }),
      ).rejects.toMatchObject({
        code: "session_key_invalid_input",
        details:
          "rails must list distinct values from transfer, x402-exact, mpp-charge",
      });
    }
  });

  it("refuses token grants whose rail sets differ", () => {
    const value = authorization(["transfer"]);
    value.grants.push({
      ...value.grants[0],
      asset: "eip155:1/erc20:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      rails: ["transfer", "x402-exact"],
    });
    expect(compileEvmSessionScope(value, 1)).toEqual({
      ok: false,
      reason: "token grant rail sets differ",
    });
  });
});

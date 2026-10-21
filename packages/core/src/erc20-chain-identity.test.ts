import { describe, expect, it } from "vitest";
import type { TransactionRequest } from "../../wallet-engine/src/signers/types";
import type { StorageAdapter } from "../../wallet-engine/src/storage/types";
import type { WalletData } from "../../wallet-engine/src/wallet";
import { PocketWallet } from "../../wallet-engine/src/wallet";
import { ERC20TokenHelper } from "./token/ERC20TokenHelper";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TEST_PASSPHRASE = "test-passphrase-only";
const TOKEN = `0x${"11".repeat(20)}` as `0x${string}`;
const OWNER = `0x${"22".repeat(20)}` as `0x${string}`;
const RECIPIENT = `0x${"33".repeat(20)}` as `0x${string}`;
const SPENDER = `0x${"44".repeat(20)}` as `0x${string}`;

class MemoryStorage implements StorageAdapter {
  readonly type = "memory" as const;
  private data: WalletData | null = null;

  isAvailable() {
    return true;
  }

  async load() {
    return this.data;
  }

  async save(data: WalletData) {
    this.data = data;
  }

  async clear() {
    this.data = null;
  }
}

type Operation = "transfer" | "approve" | "transferFrom";

function readLength(bytes: Uint8Array, offset: number, size: number) {
  let length = 0;
  for (let index = 0; index < size; index += 1) {
    length = length * 256 + bytes[offset + index];
  }
  return length;
}

function decodeLegacyFields(signature: `0x${string}`) {
  const bytes = Uint8Array.from(
    signature.slice(2).match(/.{2}/g) ?? [],
    (byte) => Number.parseInt(byte, 16),
  );
  const prefix = bytes[0];
  const lengthSize = prefix - 0xf7;
  let offset = prefix <= 0xf7 ? 1 : 1 + lengthSize;
  const fields: Uint8Array[] = [];

  while (offset < bytes.length) {
    const itemPrefix = bytes[offset];
    if (itemPrefix <= 0x7f) {
      fields.push(bytes.slice(offset, offset + 1));
      offset += 1;
    } else if (itemPrefix <= 0xb7) {
      const length = itemPrefix - 0x80;
      fields.push(bytes.slice(offset + 1, offset + 1 + length));
      offset += 1 + length;
    } else {
      const itemLengthSize = itemPrefix - 0xb7;
      const length = readLength(bytes, offset + 1, itemLengthSize);
      fields.push(
        bytes.slice(
          offset + 1 + itemLengthSize,
          offset + 1 + itemLengthSize + length,
        ),
      );
      offset += 1 + itemLengthSize + length;
    }
  }
  return fields;
}

function decodeEip155ChainId(signature: `0x${string}`) {
  const vBytes = decodeLegacyFields(signature)[6];
  const v = vBytes.reduce((value, byte) => value * 256 + byte, 0);
  return Math.floor((v - 35) / 2);
}

async function buildRequest(operation: Operation): Promise<TransactionRequest> {
  const token = { address: TOKEN, chainId: 1 };
  const request =
    operation === "transfer"
      ? await ERC20TokenHelper.buildTransferTx(
          { token, from: OWNER, to: RECIPIENT, amount: 1n },
          0,
        )
      : operation === "approve"
        ? await ERC20TokenHelper.buildApproveTx(
            { token, owner: OWNER, spender: SPENDER, amount: 1n },
            0,
          )
        : await ERC20TokenHelper.buildTransferFromTx(
            { token, from: OWNER, to: RECIPIENT, amount: 1n },
            0,
          );

  return {
    ...request,
    nonce: "0x1",
    gas: "0x10000",
    gasPrice: "0x1",
  };
}

async function createWallet(chainId = "eip155:10") {
  const wallet = new PocketWallet({
    encryptionPassphrase: async () => TEST_PASSPHRASE,
    chainId,
    storage: new MemoryStorage(),
    autoSave: false,
  });
  await wallet.importMnemonic(MNEMONIC);
  return wallet;
}

describe("core ERC-20 builder chain identity validation", () => {
  it.each(["transfer", "approve", "transferFrom"] as const)(
    "%s preserves token chain 1 at the signing boundary",
    async (operation) => {
      // Fingerprint core/ERC20TokenHelper:builder-drops-token-chain.
      // A chain-10 wallet must not sign a request built for chain 1.
      const wallet = await createWallet();
      const request = await buildRequest(operation);
      expect(request.chainId).toBe(1);
      await expect(wallet.signTransaction(request)).rejects.toMatchObject({
        code: "chain_mismatch",
      });
    },
  );

  it.each(["transfer", "approve", "transferFrom"] as const)(
    "%s signs on the token chain when the wallet chain matches",
    async (operation) => {
      const wallet = await createWallet("eip155:1");
      const request = await buildRequest(operation);
      const { signature } = await wallet.signTransaction(request);
      expect(decodeEip155ChainId(signature)).toBe(1);
    },
  );

  it.each(["transfer", "approve", "transferFrom"] as const)(
    "%s rejects an explicitly restored token chain before signing",
    async (operation) => {
      const wallet = await createWallet();
      const request = await buildRequest(operation);

      await expect(
        wallet.signTransaction({ ...request, chainId: 1 }),
      ).rejects.toMatchObject({ code: "chain_mismatch" });
    },
  );
});

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { toSolanaPrivateKeyBase58 } from "./derivation/key-formats";
import { PocketWallet } from "./wallet";

/**
 * Signing follows the active namespace, and importing follows the key.
 *
 * Using the EVM signer for a Solana account does not fail loudly. It produces
 * a well-formed signature over an EIP-191-wrapped message that verifies
 * against nothing — the worst shape of wrong for a signing path, because
 * everything looks like it worked. So these check the signature against the
 * account's own public key rather than merely checking that one came back.
 */

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const EVM_KEY = `0x${"11".repeat(32)}` as const;
const SOL_SEED = hexToBytes("22".repeat(32));

describe("signing routes by active namespace", () => {
  it("signs for Solana with ed25519, verifiable against the account address", async () => {
    const wallet = new PocketWallet({ autoSave: false });
    await wallet.importMnemonic(MNEMONIC);
    wallet.setActiveNamespace("solana");

    const message = "sign in to naculus";
    const { signature } = await wallet.signMessage(message);

    // Verified against the address a user would see in Phantom.
    const address = wallet.account("solana")!.address;
    expect(
      ed25519.verify(
        hexToBytes(signature.slice(2)),
        new TextEncoder().encode(message),
        base58.decode(address),
      ),
    ).toBe(true);
  });

  it("signs for EVM with secp256k1 and EIP-191, recovering the account", async () => {
    const wallet = new PocketWallet({ autoSave: false });
    await wallet.importMnemonic(MNEMONIC);

    const message = "hello";
    const { signature } = await wallet.signMessage(message);

    const body = new TextEncoder().encode(message);
    const prefix = new TextEncoder().encode(
      `\x19Ethereum Signed Message:\n${body.length}`,
    );
    const payload = new Uint8Array(prefix.length + body.length);
    payload.set(prefix);
    payload.set(body, prefix.length);
    const digest = keccak_256(payload);

    const raw = signature.slice(2);
    const sig = new secp256k1.Signature(
      BigInt(`0x${raw.slice(0, 64)}`),
      BigInt(`0x${raw.slice(64, 128)}`),
    ).addRecoveryBit(Number.parseInt(raw.slice(128, 130), 16) - 27);
    const recovered = sig.recoverPublicKey(digest).toBytes(false);
    const address = `0x${bytesToHex(keccak_256(recovered.slice(1)).slice(-20))}`;

    expect(address.toLowerCase()).toBe(
      wallet.account("eip155")!.address.toLowerCase(),
    );
  });

  it("produces different signatures for the two namespaces", async () => {
    // The check that would fail if one signer served both.
    const wallet = new PocketWallet({ autoSave: false });
    await wallet.importMnemonic(MNEMONIC);
    const evm = await wallet.signMessage("same message");
    wallet.setActiveNamespace("solana");
    const sol = await wallet.signMessage("same message");
    expect(evm.signature).not.toBe(sol.signature);
    // ed25519 is 64 bytes; secp256k1 with a recovery byte is 65.
    expect(sol.signature).toHaveLength(2 + 128);
    expect(evm.signature).toHaveLength(2 + 130);
  });

  it("refuses typed data on Solana rather than signing something else", async () => {
    // EIP-712 is an Ethereum construction. There is no Solana equivalent to
    // silently substitute.
    const wallet = new PocketWallet({ autoSave: false });
    await wallet.importMnemonic(MNEMONIC);
    wallet.setActiveNamespace("solana");
    await expect(wallet.signTypedData("{}")).rejects.toThrow(/not supported/i);
  });

  it("refuses a raw digest on Solana, naming the signer", async () => {
    const wallet = new PocketWallet({ autoSave: false });
    await wallet.importMnemonic(MNEMONIC);
    wallet.setActiveNamespace("solana");
    await expect(wallet.signHash(`0x${"ab".repeat(32)}`)).rejects.toThrow(
      /solana signer cannot sign a raw digest/,
    );
  });
});

describe("importPrivateKey follows the key's own chain", () => {
  it("imports a Phantom key as a Solana wallet", async () => {
    const wallet = new PocketWallet({ autoSave: false });
    const data = await wallet.importPrivateKey(
      toSolanaPrivateKeyBase58(SOL_SEED),
    );

    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0].namespace).toBe("solana");
    expect(data.activeNamespace).toBe("solana");
    expect(data.accounts[0].address).toBe(
      base58.encode(ed25519.getPublicKey(SOL_SEED)),
    );
  });

  it("imports a MetaMask key as an EVM wallet", async () => {
    const wallet = new PocketWallet({ autoSave: false });
    const data = await wallet.importPrivateKey(EVM_KEY);
    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0].namespace).toBe("eip155");
    expect(data.activeNamespace).toBe("eip155");
  });

  it("never enables the namespace the key does not belong to", async () => {
    const solWallet = new PocketWallet({ autoSave: false });
    await solWallet.importPrivateKey(toSolanaPrivateKeyBase58(SOL_SEED));
    expect(solWallet.account("eip155")).toBeNull();

    const evmWallet = new PocketWallet({ autoSave: false });
    await evmWallet.importPrivateKey(EVM_KEY);
    expect(evmWallet.account("solana")).toBeNull();
  });

  it("signs immediately after importing a Solana key", async () => {
    const wallet = new PocketWallet({ autoSave: false });
    await wallet.importPrivateKey(toSolanaPrivateKeyBase58(SOL_SEED));
    const { signature } = await wallet.signMessage("after import");
    expect(
      ed25519.verify(
        hexToBytes(signature.slice(2)),
        new TextEncoder().encode("after import"),
        ed25519.getPublicKey(SOL_SEED),
      ),
    ).toBe(true);
  });

  it("refuses a bare 32-byte hex rather than guessing a chain", async () => {
    // A Solana address has that exact shape, so accepting it would mostly
    // mean accepting a pasted address as a key.
    const wallet = new PocketWallet({ autoSave: false });
    await expect(
      wallet.importPrivateKey(
        "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
      ),
    ).rejects.toThrow(/does not say which chain/);
  });

  it("refuses a Solana address pasted where a key belongs", async () => {
    const wallet = new PocketWallet({ autoSave: false });
    const address = base58.encode(ed25519.getPublicKey(SOL_SEED));
    await expect(wallet.importPrivateKey(address)).rejects.toThrow(
      /does not say which chain/,
    );
  });

  it("refuses a 64-byte value whose halves do not pair", async () => {
    // The verification that makes Solana detection a proof rather than a
    // guess: these bytes are the right length and the wrong keypair.
    const wallet = new PocketWallet({ autoSave: false });
    await expect(wallet.importPrivateKey("11".repeat(32))).rejects.toThrow(
      /does not match its secret half/,
    );
  });

  it("round-trips a Solana key out and back in", async () => {
    const first = new PocketWallet({ autoSave: false });
    await first.importPrivateKey(toSolanaPrivateKeyBase58(SOL_SEED));
    const exported = toSolanaPrivateKeyBase58(
      hexToBytes(first.account("solana")!.privateKey.slice(2)),
    );

    const second = new PocketWallet({ autoSave: false });
    await second.importPrivateKey(exported);
    expect(second.account("solana")!.address).toBe(
      first.account("solana")!.address,
    );
  });
});

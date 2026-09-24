import type { SolanaRoles } from "@naculus/connector-solana";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createSignableMessage,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type KeyPairSigner,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
  type Transaction,
  verifySignature,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { toKitSigners } from "./index";

const CHAIN = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const OTHER_BLOCKHASH = "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn";
const MEMO = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** A transaction with the wallet as fee payer and an optional co-signer. */
function transfer(
  wallet: KeyPairSigner,
  cosigner?: KeyPairSigner,
  blockhash = BLOCKHASH,
): Transaction {
  return compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(wallet.address, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: blockhash as never, lastValidBlockHeight: 100n },
          m,
        ),
      (m) =>
        appendTransactionMessageInstruction(
          {
            programAddress: MEMO,
            accounts: cosigner
              ? [
                  {
                    address: cosigner.address,
                    role: AccountRole.READONLY_SIGNER,
                  },
                ]
              : [],
            data: new Uint8Array([1, 2, 3]),
          },
          m,
        ),
    ),
  );
}

const encode = (tx: Transaction) =>
  Uint8Array.from(getTransactionEncoder().encode(tx));
const decode = (bytes: Uint8Array) => getTransactionDecoder().decode(bytes);

/** A Wallet Standard wallet, simulated with a real Ed25519 key. */
function walletRoles(
  wallet: KeyPairSigner,
  options: {
    sign?: (bytes: Uint8Array) => Promise<Uint8Array>;
    signAll?: boolean;
    message?: boolean;
    payer?: (bytes: Uint8Array) => Promise<string>;
    chain?: string;
  } = {},
): SolanaRoles & { calls: string[] } {
  const calls: string[] = [];
  const sign =
    options.sign ??
    (async (bytes: Uint8Array) =>
      encode(await partiallySignTransaction([wallet.keyPair], decode(bytes))));
  const identity = { address: wallet.address, chain: options.chain ?? CHAIN };
  return {
    calls,
    identity,
    features: {
      signMessage: options.message !== false,
      signTransaction: true,
      signAllTransactions: options.signAll === true,
      signAndSendTransaction: options.payer !== undefined,
    },
    signer: {
      ...identity,
      signTransaction: async (bytes) => {
        calls.push("signTransaction");
        return sign(bytes);
      },
      ...(options.signAll
        ? {
            signAllTransactions: async (all: Uint8Array[]) => {
              calls.push("signAllTransactions");
              return Promise.all(all.map(sign));
            },
          }
        : {}),
      ...(options.message !== false
        ? {
            signMessage: async (content: Uint8Array) =>
              Uint8Array.from(
                await signBytes(wallet.keyPair.privateKey, content),
              ),
          }
        : {}),
    },
    payer: options.payer
      ? { ...identity, signAndSendTransaction: options.payer }
      : null,
  };
}

describe("toKitSigners — transaction signer", () => {
  it("returns a signed, verified transaction with its lifetime", async () => {
    const wallet = await generateKeyPairSigner();
    const { transactionSigner } = toKitSigners(walletRoles(wallet));
    const [signed] = await transactionSigner!.modifyAndSignTransactions([
      transfer(wallet),
    ]);
    const signature = signed!.signatures[wallet.address];
    expect(signature).toBeInstanceOf(Uint8Array);
    expect(
      await verifySignature(
        wallet.keyPair.publicKey,
        signature!,
        signed!.messageBytes,
      ),
    ).toBe(true);
    // The app's constraint, lastValidBlockHeight included, survives signing.
    expect(signed!.lifetimeConstraint).toEqual({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 100n,
    });
  });

  it("never fills another account's signature slot from the wallet", async () => {
    const wallet = await generateKeyPairSigner();
    const cosigner = await generateKeyPairSigner();
    const tx = transfer(wallet, cosigner);
    const roles = walletRoles(wallet, {
      sign: async (bytes) => {
        const signed = await partiallySignTransaction(
          [wallet.keyPair],
          decode(bytes),
        );
        return encode({
          ...signed,
          signatures: {
            ...signed.signatures,
            [cosigner.address]: new Uint8Array(64).fill(7) as never,
          },
        });
      },
    });
    const [signed] = await toKitSigners(
      roles,
    ).transactionSigner!.modifyAndSignTransactions([tx]);
    expect(signed!.signatures[cosigner.address]).toBeNull();
  });

  it("keeps a co-signer's signature when the wallet leaves the message alone", async () => {
    const wallet = await generateKeyPairSigner();
    const cosigner = await generateKeyPairSigner();
    const tx = await partiallySignTransaction(
      [cosigner.keyPair],
      transfer(wallet, cosigner),
    );
    // A wallet that returns only its own signature over the same message.
    const roles = walletRoles(wallet, {
      sign: async (bytes) => {
        const decoded = decode(bytes);
        const own = await partiallySignTransaction([wallet.keyPair], {
          ...decoded,
          signatures: { ...decoded.signatures, [cosigner.address]: null },
        });
        return encode(own);
      },
    });
    const [signed] = await toKitSigners(
      roles,
    ).transactionSigner!.modifyAndSignTransactions([tx]);
    expect(signed!.signatures[cosigner.address]).toEqual(
      tx.signatures[cosigner.address],
    );
  });

  it("surfaces a rewritten message as a new transaction with the new lifetime", async () => {
    const wallet = await generateKeyPairSigner();
    const cosigner = await generateKeyPairSigner();
    const tx = await partiallySignTransaction(
      [cosigner.keyPair],
      transfer(wallet, cosigner),
    );
    // The wallet refreshes the blockhash before signing.
    const roles = walletRoles(wallet, {
      sign: async () =>
        encode(
          await partiallySignTransaction(
            [wallet.keyPair],
            transfer(wallet, cosigner, OTHER_BLOCKHASH),
          ),
        ),
    });
    const [signed] = await toKitSigners(
      roles,
    ).transactionSigner!.modifyAndSignTransactions([tx]);
    expect(signed!.lifetimeConstraint).toMatchObject({
      blockhash: OTHER_BLOCKHASH,
    });
    // The co-signer signed the old message; that signature is not carried over.
    expect(signed!.signatures[cosigner.address]).toBeNull();
  });

  it("refuses a transaction signed by a different account", async () => {
    const wallet = await generateKeyPairSigner();
    const impostor = await generateKeyPairSigner();
    const roles = walletRoles(wallet, {
      sign: async (bytes) => {
        const decoded = decode(bytes);
        const forged = await signBytes(
          impostor.keyPair.privateKey,
          decoded.messageBytes,
        );
        return encode({
          ...decoded,
          signatures: { ...decoded.signatures, [wallet.address]: forged },
        });
      },
    });
    await expect(
      toKitSigners(roles).transactionSigner!.modifyAndSignTransactions([
        transfer(wallet),
      ]),
    ).rejects.toMatchObject({ code: "invalid_signature" });
  });

  it("refuses an unsigned or undecodable response", async () => {
    const wallet = await generateKeyPairSigner();
    const unsigned = walletRoles(wallet, { sign: async (bytes) => bytes });
    await expect(
      toKitSigners(unsigned).transactionSigner!.modifyAndSignTransactions([
        transfer(wallet),
      ]),
    ).rejects.toMatchObject({ code: "invalid_signature" });
    const garbage = walletRoles(wallet, {
      sign: async () => new Uint8Array([1, 2, 3]),
    });
    await expect(
      toKitSigners(garbage).transactionSigner!.modifyAndSignTransactions([
        transfer(wallet),
      ]),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("uses the batch feature for several transactions, and only then", async () => {
    const wallet = await generateKeyPairSigner();
    const batch = walletRoles(wallet, { signAll: true });
    await toKitSigners(batch).transactionSigner!.modifyAndSignTransactions([
      transfer(wallet),
      transfer(wallet, undefined, OTHER_BLOCKHASH),
    ]);
    expect(batch.calls).toEqual(["signAllTransactions"]);

    const single = walletRoles(wallet);
    await toKitSigners(single).transactionSigner!.modifyAndSignTransactions([
      transfer(wallet),
      transfer(wallet, undefined, OTHER_BLOCKHASH),
    ]);
    expect(single.calls).toEqual(["signTransaction", "signTransaction"]);
  });

  it("does not prompt once aborted", async () => {
    const wallet = await generateKeyPairSigner();
    const roles = walletRoles(wallet);
    const controller = new AbortController();
    controller.abort();
    await expect(
      toKitSigners(roles).transactionSigner!.modifyAndSignTransactions(
        [transfer(wallet)],
        { abortSignal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(roles.calls).toEqual([]);
  });
});

describe("toKitSigners — message and sending signers", () => {
  it("signs messages and verifies the signature", async () => {
    const wallet = await generateKeyPairSigner();
    const { messageSigner } = toKitSigners(walletRoles(wallet));
    const message = createSignableMessage("Sign in to example.com");
    const [dictionary] = await messageSigner!.signMessages([message]);
    expect(
      await verifySignature(
        wallet.keyPair.publicKey,
        dictionary![wallet.address]!,
        message.content,
      ),
    ).toBe(true);
  });

  it("refuses a message signature from another key", async () => {
    const wallet = await generateKeyPairSigner();
    const impostor = await generateKeyPairSigner();
    const roles = walletRoles(wallet);
    roles.signer!.signMessage = async (content) =>
      Uint8Array.from(await signBytes(impostor.keyPair.privateKey, content));
    await expect(
      toKitSigners(roles).messageSigner!.signMessages([
        createSignableMessage("hi"),
      ]),
    ).rejects.toMatchObject({ code: "invalid_signature" });
  });

  it("decodes the base58 signature a sending wallet returns", async () => {
    const wallet = await generateKeyPairSigner();
    const signature = new Uint8Array(64).fill(7);
    const sent: Uint8Array[] = [];
    const roles = walletRoles(wallet, {
      payer: async (bytes) => {
        sent.push(bytes);
        return getBase58Decoder().decode(signature);
      },
    });
    const tx = transfer(wallet);
    const [result] = await toKitSigners(
      roles,
    ).sendingSigner!.signAndSendTransactions([tx]);
    expect(Uint8Array.from(result!)).toEqual(signature);
    expect(sent[0]).toEqual(encode(tx));
  });

  it("refuses a sending signature that is not 64 bytes", async () => {
    const wallet = await generateKeyPairSigner();
    const roles = walletRoles(wallet, { payer: async () => "3yZe7d" });
    await expect(
      toKitSigners(roles).sendingSigner!.signAndSendTransactions([
        transfer(wallet),
      ]),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("toKitSigners — capabilities and identity", () => {
  it("exposes no signer the wallet cannot back", async () => {
    const wallet = await generateKeyPairSigner();
    const roles = walletRoles(wallet, { message: false });
    const signers = toKitSigners({ ...roles, signer: null, payer: null });
    expect(signers.transactionSigner).toBeNull();
    expect(signers.messageSigner).toBeNull();
    expect(signers.sendingSigner).toBeNull();
    expect(toKitSigners(roles).messageSigner).toBeNull();
    expect(signers.identity).toEqual({ address: wallet.address, chain: CHAIN });
  });

  it.each(["solana:0", "eip155:1", "solana:devnet"])(
    "refuses chain %s",
    async (chain) => {
      const wallet = await generateKeyPairSigner();
      expect(() => toKitSigners(walletRoles(wallet, { chain }))).toThrow(
        expect.objectContaining({ code: "invalid_identity" }),
      );
    },
  );

  it("refuses roles that belong to different accounts", async () => {
    const wallet = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const roles = walletRoles(wallet);
    expect(() =>
      toKitSigners({
        ...roles,
        signer: { ...roles.signer!, address: other.address },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_identity" }));
  });
});

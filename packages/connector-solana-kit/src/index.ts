/**
 * Naculus Solana wallet roles as `@solana/kit` (v8) signers.
 *
 * `connector-solana` splits a connected wallet into identity / signer / payer
 * roles that speak wire bytes. Kit's transaction builders speak `Transaction`
 * objects and signer interfaces. This package is only the bridge between the
 * two: it encodes what Kit hands it, passes the bytes to the wallet, and
 * decodes what the wallet returns. It never constructs signing bytes itself.
 *
 * Mapping (docs/design/solana-kit-interop.md):
 * - `signer.signTransaction` → `TransactionModifyingSigner`: Wallet Standard
 *   returns whole transaction bytes and a wallet may rewrite the message
 *   (fee payer, blockhash, priority fee), so the result is a new transaction,
 *   never a signature pasted onto the old one.
 * - `signer.signMessage` → `MessagePartialSigner`: the wallet signs the bytes
 *   it is given and returns only a signature.
 * - `payer.signAndSendTransaction` → `TransactionSendingSigner`.
 *
 * A wallet without a feature yields `null` for that signer rather than a stub
 * that throws later. The account's own signature is verified against its
 * address before it is handed to Kit, and nothing a wallet returns fills
 * another account's signature slot.
 */
import type {
  SolanaIdentity,
  SolanaPayer,
  SolanaRoles,
  SolanaSigner,
} from "@naculus/connector-solana";
import {
  type Address,
  address as asAddress,
  assertIsTransactionWithinSizeLimit,
  getBase58Encoder,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  getTransactionLifetimeConstraintFromCompiledTransactionMessage,
  type MessagePartialSigner,
  type SignableMessage,
  type SignatureBytes,
  type SignatureDictionary,
  type Transaction,
  type TransactionModifyingSigner,
  type TransactionSendingSigner,
  type TransactionWithinSizeLimit,
  type TransactionWithLifetime,
  verifySignature,
} from "@solana/kit";

export type SolanaKitAdapterErrorCode =
  | "invalid_identity"
  | "invalid_signature"
  | "invalid_response"
  | "aborted";

export class SolanaKitAdapterError extends Error {
  override name = "SolanaKitAdapterError";
  constructor(
    readonly code: SolanaKitAdapterErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: SolanaKitAdapterErrorCode, message: string): never {
  throw new SolanaKitAdapterError(code, message);
}

export interface KitSigners {
  /** The account's address and the CAIP-2 chain it is being used on. */
  identity: { address: Address; chain: string };
  /** Present only when the wallet can sign a transaction without sending it. */
  transactionSigner: TransactionModifyingSigner | null;
  /** Present only when the wallet can sign an off-chain message. */
  messageSigner: MessagePartialSigner | null;
  /** Present only when the wallet can sign and send through its own RPC. */
  sendingSigner: TransactionSendingSigner | null;
}

/** CAIP-2 Solana chain: the 32-character genesis-hash prefix, never `solana:0`. */
const SOLANA_CHAIN = /^solana:[1-9A-HJ-NP-Za-km-z]{32}$/;

type KitTransaction = Transaction | (Transaction & TransactionWithLifetime);
type SignedKitTransaction = Transaction &
  TransactionWithinSizeLimit &
  TransactionWithLifetime;

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) fail("aborted", "Signing was aborted.");
}

function sameAccount(role: SolanaIdentity, identity: Address): void {
  if (role.address !== identity) {
    fail(
      "invalid_identity",
      `Role address ${role.address} does not match the identity ${identity}.`,
    );
  }
}

async function assertSignedBy(
  signer: Address,
  signature: Uint8Array | null | undefined,
  signed: Uint8Array,
  what: string,
): Promise<SignatureBytes> {
  if (!(signature instanceof Uint8Array) || signature.length !== 64) {
    fail(
      "invalid_signature",
      `Wallet returned no 64-byte signature for the ${what}.`,
    );
  }
  const key = await getPublicKeyFromAddress(signer);
  if (!(await verifySignature(key, signature as SignatureBytes, signed))) {
    fail(
      "invalid_signature",
      `The ${what} signature does not verify for ${signer}.`,
    );
  }
  return signature as SignatureBytes;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function transactionSigner(
  role: SolanaSigner,
  identity: Address,
): TransactionModifyingSigner {
  const encoder = getTransactionEncoder();
  const decoder = getTransactionDecoder();
  const messageDecoder = getCompiledTransactionMessageDecoder();

  const fromWallet = async (
    input: KitTransaction,
    wire: Uint8Array,
  ): Promise<SignedKitTransaction> => {
    let decoded: Transaction;
    try {
      decoded = decoder.decode(wire);
    } catch {
      fail(
        "invalid_response",
        "Wallet returned bytes that are not a transaction.",
      );
    }
    await assertSignedBy(
      identity,
      decoded.signatures[identity],
      Uint8Array.from(decoded.messageBytes),
      "transaction",
    );
    // Only the identity's signature is taken from the wallet, and it was just
    // verified. A slot for any other account is never filled from the
    // wallet's response: unverified bytes there would make Kit treat the
    // transaction as fully signed (independent review, 2026-09-25). When the
    // message is unchanged, signatures other signers already added still
    // verify and are kept; a rewritten message voids them.
    const unchanged = sameBytes(
      Uint8Array.from(input.messageBytes),
      Uint8Array.from(decoded.messageBytes),
    );
    const prior = input.signatures as Record<string, SignatureBytes | null>;
    const signatures: Record<string, SignatureBytes | null> = {};
    for (const account of Object.keys(decoded.signatures)) {
      signatures[account] =
        account === identity
          ? (decoded.signatures[identity] as SignatureBytes)
          : unchanged
            ? (prior[account] ?? null)
            : null;
    }
    // The lifetime comes from the message the wallet actually signed. The
    // compiled message has no lastValidBlockHeight, so when the blockhash is
    // the one the app supplied, keep the app's constraint: without it Kit
    // could never detect expiry while confirming.
    let lifetimeConstraint: TransactionWithLifetime["lifetimeConstraint"];
    try {
      const derived =
        await getTransactionLifetimeConstraintFromCompiledTransactionMessage(
          messageDecoder.decode(decoded.messageBytes) as Parameters<
            typeof getTransactionLifetimeConstraintFromCompiledTransactionMessage
          >[0],
        );
      const supplied = (input as Partial<TransactionWithLifetime>)
        .lifetimeConstraint;
      lifetimeConstraint =
        supplied &&
        "blockhash" in supplied &&
        "blockhash" in derived &&
        supplied.blockhash === derived.blockhash
          ? supplied
          : derived;
    } catch {
      fail(
        "invalid_response",
        "Wallet returned a transaction whose message has no readable lifetime.",
      );
    }
    const result = Object.freeze({
      ...decoded,
      signatures: Object.freeze(signatures),
      lifetimeConstraint,
    }) as unknown as Transaction & TransactionWithLifetime;
    assertIsTransactionWithinSizeLimit(result);
    return result;
  };

  return Object.freeze({
    address: identity,
    async modifyAndSignTransactions(transactions, config) {
      checkAborted(config?.abortSignal);
      const wire = transactions.map((tx) =>
        Uint8Array.from(encoder.encode(tx)),
      );
      let signed: Uint8Array[];
      if (wire.length > 1 && role.signAllTransactions) {
        signed = await role.signAllTransactions(wire);
      } else {
        signed = [];
        for (const bytes of wire) {
          checkAborted(config?.abortSignal);
          signed.push(await role.signTransaction(bytes));
        }
      }
      if (!Array.isArray(signed) || signed.length !== transactions.length) {
        fail(
          "invalid_response",
          `Wallet returned ${Array.isArray(signed) ? signed.length : "no"} transactions for ${transactions.length}.`,
        );
      }
      const out: SignedKitTransaction[] = [];
      for (let i = 0; i < transactions.length; i++) {
        out.push(
          await fromWallet(
            transactions[i] as KitTransaction,
            signed[i] as Uint8Array,
          ),
        );
      }
      return Object.freeze(out);
    },
  });
}

function messageSigner(
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
  identity: Address,
): MessagePartialSigner {
  return Object.freeze({
    address: identity,
    async signMessages(messages: readonly SignableMessage[], config) {
      const out: SignatureDictionary[] = [];
      for (const message of messages) {
        checkAborted(config?.abortSignal);
        const content = Uint8Array.from(message.content);
        const signature = await assertSignedBy(
          identity,
          await signMessage(content),
          content,
          "message",
        );
        out.push(
          Object.freeze({ [identity]: signature }) as SignatureDictionary,
        );
      }
      return Object.freeze(out);
    },
  });
}

function sendingSigner(
  role: SolanaPayer,
  identity: Address,
): TransactionSendingSigner {
  const encoder = getTransactionEncoder();
  const base58 = getBase58Encoder();
  return Object.freeze({
    address: identity,
    async signAndSendTransactions(transactions, config) {
      const out: SignatureBytes[] = [];
      for (const tx of transactions) {
        checkAborted(config?.abortSignal);
        const signature = await role.signAndSendTransaction(
          Uint8Array.from(encoder.encode(tx)),
        );
        let bytes: Uint8Array;
        try {
          bytes = Uint8Array.from(base58.encode(signature));
        } catch {
          fail(
            "invalid_response",
            "Wallet returned a signature that is not base58.",
          );
        }
        if (bytes.length !== 64) {
          fail(
            "invalid_response",
            "Wallet returned a signature that is not 64 bytes.",
          );
        }
        out.push(bytes as SignatureBytes);
      }
      return Object.freeze(out);
    },
  });
}

/**
 * Kit signers for the roles a connected Solana account can fill
 * (`connector.getSolanaRoles()` / `solanaRoles(...)`).
 */
export function toKitSigners(roles: SolanaRoles): KitSigners {
  const { identity: role, signer, payer } = roles;
  if (!SOLANA_CHAIN.test(role.chain)) {
    fail(
      "invalid_identity",
      `Identity chain ${role.chain} is not a CAIP-2 Solana chain.`,
    );
  }
  let identity: Address;
  try {
    identity = asAddress(role.address);
  } catch {
    fail(
      "invalid_identity",
      `Identity address ${role.address} is not a Solana address.`,
    );
  }
  if (signer) sameAccount(signer, identity);
  if (payer) sameAccount(payer, identity);

  return {
    identity: { address: identity, chain: role.chain },
    transactionSigner: signer ? transactionSigner(signer, identity) : null,
    messageSigner: signer?.signMessage
      ? messageSigner(signer.signMessage, identity)
      : null,
    sendingSigner: payer ? sendingSigner(payer, identity) : null,
  };
}

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base58, base64 } from "@scure/base";
import { WalletError } from "./errors";

/**
 * One SPL token payment as a Solana transaction, built and checked byte by
 * byte: the shape both x402 `exact` on SVM (coinbase/x402
 * `specs/schemes/exact/scheme_exact_svm.md`) and MPP `solana` charge
 * (tempoxyz/mpp-specs `draft-solana-charge-00`, pull mode) ask a payer to
 * sign.
 *
 * A v0 message with no address lookup tables and exactly these instructions:
 * ComputeBudget SetComputeUnitLimit, SetComputeUnitPrice, one
 * TransferChecked into the recipient's associated token account, and an
 * optional Memo. The fee payer may be someone else (a facilitator), in which
 * case the payer's signature leaves the transaction partially signed.
 *
 * `verifySignedSplTransfer` checks what a wallet returns before it is sent
 * anywhere: the same fee payer, blockhash and instructions, optionally
 * Lighthouse assertions added (Phantom and Solflare inject them; x402 allows
 * them, MPP does not), and a valid signature from the payer over the message
 * it returned.
 */

export const SOLANA_PROGRAMS = {
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  associatedToken: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  computeBudget: "ComputeBudget111111111111111111111111111111",
  memo: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  lighthouse: "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95",
} as const;

/** The Solana packet limit, in bytes of the serialized transaction. */
export const SOLANA_TRANSACTION_LIMIT = 1232;
/** Default compute budget: enough for TransferChecked and a memo. */
export const SPL_PAYMENT_COMPUTE_UNIT_LIMIT = 40_000;
/** Default price in micro-lamports per unit (x402 caps it at 5 lamports). */
export const SPL_PAYMENT_COMPUTE_UNIT_PRICE = 1n;

const U64_MAX = (1n << 64n) - 1n;
const PDA_MARKER = utf8ToBytes("ProgramDerivedAddress");
const MAX_INSTRUCTIONS = 6;

export interface SplTransferPayment {
  /** Pays the fee and signs first; a facilitator, or `authority` itself. */
  feePayer: string;
  /** The payer: owner of the source token account, signs the transfer. */
  authority: string;
  mint: string;
  /** `SOLANA_PROGRAMS.token` or `SOLANA_PROGRAMS.token2022`. */
  tokenProgram: string;
  decimals: number;
  /** Owner of the destination token account (not the account itself). */
  recipient: string;
  /** Token base units. */
  amount: bigint;
  /** UTF-8 memo, or null for none. */
  memo: string | null;
  recentBlockhash: string;
  computeUnitLimit?: number;
  /** Micro-lamports per compute unit. */
  computeUnitPrice?: bigint;
}

function fail(message: string): never {
  throw new WalletError("invalid_input", message);
}

function key(address: string, what: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(address);
  } catch {
    fail(`${what} is not a base58 address.`);
  }
  if (bytes.length !== 32) fail(`${what} is not a 32-byte address.`);
  return bytes;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** Associated token account of `owner` for `mint` under `tokenProgram`. */
export function associatedTokenAddress(
  owner: string,
  mint: string,
  tokenProgram: string,
): string {
  const seeds = [
    key(owner, "owner"),
    key(tokenProgram, "token program"),
    key(mint, "mint"),
  ];
  const program = key(SOLANA_PROGRAMS.associatedToken, "program");
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(
      concatBytes(...seeds, new Uint8Array([bump]), program, PDA_MARKER),
    );
    // A PDA must be off the curve; construction throws for such a point.
    try {
      ed25519.Point.fromBytes(hash);
    } catch {
      return base58.encode(hash);
    }
  }
  return fail("No associated token address exists for these seeds.");
}

/**
 * The token program and decimals of a mint, from its account's owner and
 * data. Refuses anything that is not an initialized SPL Token or Token-2022
 * mint.
 */
export function readMint(
  owner: string,
  data: Uint8Array,
): { tokenProgram: string; decimals: number } {
  if (owner !== SOLANA_PROGRAMS.token && owner !== SOLANA_PROGRAMS.token2022) {
    fail(`The mint is owned by ${owner}, not a token program.`);
  }
  // Mint layout: COption<authority> 36, supply 8, decimals 1, initialized 1.
  if (data.length < 82 || data[45] !== 1) {
    fail("The mint account is not an initialized mint.");
  }
  return { tokenProgram: owner, decimals: data[44] as number };
}

// ── Wire encoding ───────────────────────────────────────────────────

function shortVec(n: number): Uint8Array {
  const out: number[] = [];
  let rest = n;
  for (;;) {
    const byte = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) {
      out.push(byte);
      return new Uint8Array(out);
    }
    out.push(byte | 0x80);
  }
}

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

function u64(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
}

interface Instruction {
  program: string;
  /** Account addresses in instruction order. */
  accounts: string[];
  data: Uint8Array;
}

function checkPayment(p: SplTransferPayment): {
  computeUnitLimit: number;
  computeUnitPrice: bigint;
} {
  if (
    p.tokenProgram !== SOLANA_PROGRAMS.token &&
    p.tokenProgram !== SOLANA_PROGRAMS.token2022
  ) {
    fail("tokenProgram is not SPL Token or Token-2022.");
  }
  if (!Number.isInteger(p.decimals) || p.decimals < 0 || p.decimals > 255) {
    fail("decimals is not a byte.");
  }
  if (p.amount <= 0n || p.amount > U64_MAX) {
    fail("amount is not a positive u64.");
  }
  if (p.recipient === p.authority) fail("The payer cannot pay itself.");
  const computeUnitLimit = p.computeUnitLimit ?? SPL_PAYMENT_COMPUTE_UNIT_LIMIT;
  const computeUnitPrice = p.computeUnitPrice ?? SPL_PAYMENT_COMPUTE_UNIT_PRICE;
  if (
    !Number.isInteger(computeUnitLimit) ||
    computeUnitLimit <= 0 ||
    computeUnitLimit > 1_400_000
  ) {
    fail("computeUnitLimit is out of range.");
  }
  if (computeUnitPrice < 0n || computeUnitPrice > U64_MAX) {
    fail("computeUnitPrice is not a u64.");
  }
  for (const [what, value] of [
    ["feePayer", p.feePayer],
    ["authority", p.authority],
    ["mint", p.mint],
    ["recipient", p.recipient],
    ["recentBlockhash", p.recentBlockhash],
  ] as const) {
    key(value, what);
  }
  return { computeUnitLimit, computeUnitPrice };
}

function paymentInstructions(p: SplTransferPayment): Instruction[] {
  const { computeUnitLimit, computeUnitPrice } = checkPayment(p);
  const source = associatedTokenAddress(p.authority, p.mint, p.tokenProgram);
  const destination = associatedTokenAddress(
    p.recipient,
    p.mint,
    p.tokenProgram,
  );
  const instructions: Instruction[] = [
    {
      program: SOLANA_PROGRAMS.computeBudget,
      accounts: [],
      data: concatBytes(new Uint8Array([2]), u32(computeUnitLimit)),
    },
    {
      program: SOLANA_PROGRAMS.computeBudget,
      accounts: [],
      data: concatBytes(new Uint8Array([3]), u64(computeUnitPrice)),
    },
    {
      program: p.tokenProgram,
      accounts: [source, p.mint, destination, p.authority],
      data: concatBytes(
        new Uint8Array([12]),
        u64(p.amount),
        new Uint8Array([p.decimals]),
      ),
    },
  ];
  if (p.memo !== null) {
    const memo = utf8ToBytes(p.memo);
    if (memo.length === 0 || memo.length > 566) {
      fail("memo must be 1 to 566 bytes.");
    }
    instructions.push({
      program: SOLANA_PROGRAMS.memo,
      accounts: [],
      data: memo,
    });
  }
  return instructions;
}

/**
 * The unsigned wire transaction for `p`: a v0 message, with one zeroed
 * signature slot per required signer (fee payer first).
 */
export function buildSplTransferTransaction(p: SplTransferPayment): Uint8Array {
  const instructions = paymentInstructions(p);
  const [, , transfer] = instructions as [
    Instruction,
    Instruction,
    Instruction,
  ];
  const [source, , destination] = transfer.accounts as [string, string, string];
  const selfFunded = p.feePayer === p.authority;
  const signers = selfFunded ? [p.feePayer] : [p.feePayer, p.authority];
  const readonlyUnsigned = [
    p.mint,
    p.tokenProgram,
    SOLANA_PROGRAMS.computeBudget,
    ...(p.memo !== null ? [SOLANA_PROGRAMS.memo] : []),
  ];
  const keys = [...signers, source, destination, ...readonlyUnsigned];
  if (new Set(keys).size !== keys.length) {
    fail("The payment's accounts overlap (fee payer, payer, token accounts).");
  }
  const index = (address: string) => keys.indexOf(address);
  const message = concatBytes(
    new Uint8Array([
      0x80, // v0
      signers.length,
      selfFunded ? 0 : 1, // the payer signs read-only
      readonlyUnsigned.length,
    ]),
    shortVec(keys.length),
    ...keys.map((k) => key(k, "account")),
    key(p.recentBlockhash, "recentBlockhash"),
    shortVec(instructions.length),
    ...instructions.map((ix) =>
      concatBytes(
        new Uint8Array([index(ix.program)]),
        shortVec(ix.accounts.length),
        new Uint8Array(ix.accounts.map(index)),
        shortVec(ix.data.length),
        ix.data,
      ),
    ),
    shortVec(0), // no address lookup tables
  );
  const wire = concatBytes(
    shortVec(signers.length),
    new Uint8Array(64 * signers.length),
    message,
  );
  if (wire.length > SOLANA_TRANSACTION_LIMIT) {
    fail("The payment transaction exceeds the Solana size limit.");
  }
  return wire;
}

// ── Parsing ─────────────────────────────────────────────────────────

export interface ParsedSolanaTransaction {
  signatures: Uint8Array[];
  /** The signed message bytes. */
  message: Uint8Array;
  version: 0;
  numRequiredSignatures: number;
  numReadonlySigned: number;
  numReadonlyUnsigned: number;
  accountKeys: string[];
  recentBlockhash: string;
  instructions: { program: string; accounts: string[]; data: Uint8Array }[];
}

class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  byte(): number {
    if (this.offset >= this.bytes.length) fail("Transaction is truncated.");
    return this.bytes[this.offset++] as number;
  }
  take(n: number): Uint8Array {
    if (this.offset + n > this.bytes.length) fail("Transaction is truncated.");
    const out = this.bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  shortVec(): number {
    let value = 0;
    for (let i = 0; i < 3; i++) {
      const byte = this.byte();
      value |= (byte & 0x7f) << (7 * i);
      if ((byte & 0x80) === 0) {
        // Canonical: no trailing zero continuation byte.
        if (i > 0 && byte === 0) fail("Non-canonical length prefix.");
        return value;
      }
    }
    return fail("Length prefix is too long.");
  }
}

/**
 * Parse a v0 wire transaction without address lookup tables. Legacy
 * messages and lookup tables are refused: nothing here builds them, so a
 * wallet returning one returned something else.
 */
export function parseSolanaTransaction(
  wire: Uint8Array,
): ParsedSolanaTransaction {
  if (wire.length > SOLANA_TRANSACTION_LIMIT) {
    fail("Transaction exceeds the Solana size limit.");
  }
  const r = new Reader(wire);
  const signatureCount = r.shortVec();
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < signatureCount; i++) signatures.push(r.take(64));
  const messageStart = r.offset;
  if (r.byte() !== 0x80) fail("Transaction is not a v0 message.");
  const numRequiredSignatures = r.byte();
  const numReadonlySigned = r.byte();
  const numReadonlyUnsigned = r.byte();
  const keyCount = r.shortVec();
  const accountKeys: string[] = [];
  for (let i = 0; i < keyCount; i++)
    accountKeys.push(base58.encode(r.take(32)));
  if (
    numRequiredSignatures === 0 ||
    numRequiredSignatures !== signatureCount ||
    numReadonlySigned >= numRequiredSignatures ||
    numRequiredSignatures + numReadonlyUnsigned > keyCount
  ) {
    fail("Transaction header does not match its signatures and accounts.");
  }
  const recentBlockhash = base58.encode(r.take(32));
  const instructionCount = r.shortVec();
  const instructions: ParsedSolanaTransaction["instructions"] = [];
  const at = (i: number) => {
    const k = accountKeys[i];
    if (k === undefined) fail("Instruction names an account out of range.");
    return k;
  };
  for (let i = 0; i < instructionCount; i++) {
    const program = at(r.byte());
    const accountCount = r.shortVec();
    const accounts: string[] = [];
    for (let j = 0; j < accountCount; j++) accounts.push(at(r.byte()));
    const data = r.take(r.shortVec());
    instructions.push({ program, accounts, data });
  }
  if (r.shortVec() !== 0) fail("Address lookup tables are not accepted.");
  if (r.offset !== wire.length) fail("Transaction has trailing bytes.");
  return {
    signatures,
    message: wire.slice(messageStart),
    version: 0,
    numRequiredSignatures,
    numReadonlySigned,
    numReadonlyUnsigned,
    accountKeys,
    recentBlockhash,
    instructions,
  };
}

function isWritable(tx: ParsedSolanaTransaction, address: string): boolean {
  const i = tx.accountKeys.indexOf(address);
  if (i < 0) return false;
  if (i < tx.numRequiredSignatures) {
    return i < tx.numRequiredSignatures - tx.numReadonlySigned;
  }
  return i < tx.accountKeys.length - tx.numReadonlyUnsigned;
}

function isSigner(tx: ParsedSolanaTransaction, address: string): boolean {
  const i = tx.accountKeys.indexOf(address);
  return i >= 0 && i < tx.numRequiredSignatures;
}

/**
 * Check a wallet-signed transaction against the payment it was built for,
 * and return it base64-encoded for the wire. Throws on any difference.
 *
 * Accepted changes are only those wallets make for the user: Lighthouse
 * assertion instructions after the transfer, unless `allowLighthouse` is
 * false. The payer's signature must
 * verify over the returned message; the fee payer's slot may be empty
 * (a facilitator signs it later) unless the payer pays its own fee.
 */
export function verifySignedSplTransfer(
  wire: Uint8Array,
  p: SplTransferPayment,
  options: { allowLighthouse?: boolean } = {},
): string {
  const allowLighthouse = options.allowLighthouse ?? true;
  const expected = paymentInstructions(p);
  const tx = parseSolanaTransaction(wire);
  if (tx.accountKeys[0] !== p.feePayer) {
    fail("The wallet changed the fee payer.");
  }
  if (tx.recentBlockhash !== p.recentBlockhash) {
    fail("The wallet changed the blockhash.");
  }
  if (tx.instructions.length > MAX_INSTRUCTIONS) {
    fail("The wallet added too many instructions.");
  }
  // The compute budget and the transfer: first, in order, unchanged.
  for (let i = 0; i < 3; i++) {
    const got = tx.instructions[i];
    const want = expected[i] as Instruction;
    if (
      !got ||
      got.program !== want.program ||
      got.accounts.length !== want.accounts.length ||
      got.accounts.some((a, j) => a !== want.accounts[j]) ||
      !equal(got.data, want.data)
    ) {
      fail("The wallet changed the payment instructions.");
    }
  }
  const [source, , destination] = (expected[2] as Instruction).accounts as [
    string,
    string,
    string,
  ];
  if (
    !isWritable(tx, source) ||
    !isWritable(tx, destination) ||
    !isSigner(tx, p.authority)
  ) {
    fail("The transfer's account permissions changed.");
  }
  // After it: our memo exactly once, and otherwise only Lighthouse.
  const memo = expected[3];
  let memos = 0;
  for (const ix of tx.instructions.slice(3)) {
    if (ix.program === SOLANA_PROGRAMS.memo) {
      memos++;
      if (!memo || ix.accounts.length !== 0 || !equal(ix.data, memo.data)) {
        fail("The wallet changed the memo.");
      }
    } else if (!allowLighthouse || ix.program !== SOLANA_PROGRAMS.lighthouse) {
      fail(`The wallet added an instruction for ${ix.program}.`);
    }
  }
  if (memos !== (memo ? 1 : 0)) fail("The wallet changed the memo.");

  // Signatures: the payer's must verify; the fee payer's too if it is us.
  const verify = (address: string) => {
    const i = tx.accountKeys.indexOf(address);
    const signature = tx.signatures[i] as Uint8Array;
    if (!ed25519.verify(signature, tx.message, key(address, "signer"))) {
      fail(`The transaction is not signed by ${address}.`);
    }
  };
  verify(p.authority);
  if (p.feePayer === p.authority && tx.numRequiredSignatures !== 1) {
    fail("A self-funded payment has exactly one signer.");
  }
  if (p.feePayer !== p.authority) {
    if (tx.numRequiredSignatures !== 2) {
      fail("The transaction must be signed by the fee payer and the payer.");
    }
  }
  return base64.encode(wire);
}

/**
 * Refuse unless `rpc` serves the cluster `network` (CAIP-2) names. A payer
 * signs with this RPC's blockhash; on another cluster than the challenge's,
 * the signature would be for a transfer the payer did not agree to.
 */
export async function assertSolanaCluster(
  rpc: SolanaPaymentRpc,
  network: string,
): Promise<void> {
  const genesis = await rpc.getGenesisHash();
  if (`solana:${genesis.slice(0, 32)}` !== network) {
    throw new WalletError(
      "chain_mismatch",
      `The Solana RPC serves solana:${genesis.slice(0, 32)}, not ${network}.`,
    );
  }
}

// ── RPC ─────────────────────────────────────────────────────────────

/** The two reads a payer needs, answerable by any Solana JSON-RPC node. */
export interface SolanaPaymentRpc {
  /** The cluster's genesis hash; its CAIP-2 id is `solana:` + its first 32 characters. */
  getGenesisHash(): Promise<string>;
  getLatestBlockhash(): Promise<string>;
  /** Owner program and data of an account, or null when it does not exist. */
  getAccountInfo(
    address: string,
  ): Promise<{ owner: string; data: Uint8Array } | null>;
}

/** A `SolanaPaymentRpc` over a JSON-RPC endpoint. */
export function solanaPaymentRpc(
  url: string,
  send: typeof fetch = globalThis.fetch.bind(globalThis),
): SolanaPaymentRpc {
  let id = 0;
  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    const response = await send(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!response.ok) {
      throw new WalletError("rpc_error", `Solana RPC ${method} failed.`);
    }
    const body = (await response.json()) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (body.error) {
      throw new WalletError(
        "rpc_error",
        `Solana RPC ${method}: ${body.error.message ?? "error"}`,
      );
    }
    return body.result;
  };
  return {
    async getGenesisHash() {
      const result = await call("getGenesisHash", []);
      if (typeof result !== "string") {
        throw new WalletError("rpc_error", "No genesis hash in the reply.");
      }
      return result;
    },
    async getLatestBlockhash() {
      const result = (await call("getLatestBlockhash", [
        { commitment: "confirmed" },
      ])) as { value?: { blockhash?: unknown } };
      const blockhash = result?.value?.blockhash;
      if (typeof blockhash !== "string") {
        throw new WalletError("rpc_error", "No blockhash in the reply.");
      }
      return blockhash;
    },
    async getAccountInfo(address) {
      const result = (await call("getAccountInfo", [
        address,
        { encoding: "base64", commitment: "confirmed" },
      ])) as { value?: { owner?: unknown; data?: unknown } | null };
      const value = result?.value;
      if (!value) return null;
      if (
        typeof value.owner !== "string" ||
        !Array.isArray(value.data) ||
        typeof value.data[0] !== "string"
      ) {
        throw new WalletError("rpc_error", "Unreadable account info.");
      }
      return { owner: value.owner, data: base64.decode(value.data[0]) };
    },
  };
}

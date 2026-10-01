import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base58, base64 } from "@scure/base";
import { SOLANA_DEVNET, SOLANA_MAINNET } from "./constants";
import { WalletError } from "./errors";
import {
  assertSolanaCluster,
  associatedTokenAddress,
  type ParsedSolanaTransaction,
  parseSolanaTransaction,
  readMint,
  SOLANA_PROGRAMS,
  type SolanaPaymentRpc,
  verifySolanaSignature,
} from "./solana-payment";
import { compileV0, equal, type Meta } from "./solana-wire";

/** The payment-channel deployment named by the MPP Solana session draft. */
export const SOLANA_CHANNEL_PROGRAM =
  "CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX";

const BPF_UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const RENT_ACCOUNT = "SysvarRent111111111111111111111111111111111";
const PDA_MARKER = utf8ToBytes("ProgramDerivedAddress");
const CHANNEL_SEED = utf8ToBytes("channel");
const EVENT_AUTHORITY_SEED = utf8ToBytes("event_authority");
const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const MAX_OPEN_INSTRUCTIONS = 6;

export interface TrustedChannelProgram {
  address: string;
  programData: string;
  lastDeployedSlot: bigint;
  upgradeAuthority: string;
}

/** Reviewed upgradeable-loader deployments. A redeploy requires an SDK update. */
export const TRUSTED_CHANNEL_PROGRAMS: Readonly<
  Record<string, TrustedChannelProgram>
> = {
  [SOLANA_MAINNET]: {
    address: SOLANA_CHANNEL_PROGRAM,
    programData: "CghQXkmw2F6p1exMETiZdNeUx9QGraWsNZ4eom1Cuiw1",
    lastDeployedSlot: 431_447_053n,
    upgradeAuthority: "DXtFpbPjcn2hxPnw79x1Pfoj35vXh5AsWBkS37YnXMVv",
  },
  [SOLANA_DEVNET]: {
    address: SOLANA_CHANNEL_PROGRAM,
    programData: "CghQXkmw2F6p1exMETiZdNeUx9QGraWsNZ4eom1Cuiw1",
    lastDeployedSlot: 480_232_051n,
    upgradeAuthority: "4zTeC5mVqWLruDexgU2mV66p9t5vCA9JyiZqdGDUspap",
  },
};

export interface ChannelPdaInput {
  programAddress?: string;
  payer: string;
  payee: string;
  mint: string;
  authorizedSigner: string;
  salt: bigint;
  openSlot: bigint;
}

export interface ChannelMintAccount {
  address: string;
  owner: string;
  data: Uint8Array;
}

export interface OpenChannelTransaction extends ChannelPdaInput {
  feePayer: string;
  mintAccount: ChannelMintAccount;
  deposit: bigint;
  gracePeriod: number;
  recentBlockhash: string;
}

export interface TopUpChannelTransaction {
  programAddress?: string;
  feePayer: string;
  payer: string;
  channelId: string;
  mintAccount: ChannelMintAccount;
  amount: bigint;
  recentBlockhash: string;
}

export interface RequestCloseChannelTransaction {
  programAddress?: string;
  feePayer: string;
  payer: string;
  channelId: string;
  recentBlockhash: string;
}

export interface SealChannelTransaction {
  programAddress?: string;
  feePayer: string;
  channelId: string;
  recentBlockhash: string;
}

export interface WithdrawPayerChannelTransaction {
  programAddress?: string;
  feePayer: string;
  payer: string;
  channelId: string;
  mintAccount: ChannelMintAccount;
  recentBlockhash: string;
}

export interface ChannelVoucher {
  channelId: string;
  cumulativeAmount: bigint;
  expiresAt: bigint;
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

function u32(value: number, what: string): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    fail(`${what} is not a u32.`);
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function u64(value: bigint, what: string): Uint8Array {
  if (value < 0n || value > U64_MAX) fail(`${what} is not a u64.`);
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function derivePda(
  seeds: readonly Uint8Array[],
  programAddress: string,
): { address: string; bump: number } {
  const program = key(programAddress, "programAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(
      concatBytes(...seeds, new Uint8Array([bump]), program, PDA_MARKER),
    );
    try {
      ed25519.Point.fromBytes(hash);
    } catch {
      return { address: base58.encode(hash), bump };
    }
  }
  return fail("No program-derived address exists for these seeds.");
}

/** Derive the channel PDA exactly as `@solana/mpp@0.7.0` does. */
export function deriveChannelPda(input: ChannelPdaInput): {
  channelId: string;
  bump: number;
} {
  const programAddress = input.programAddress ?? SOLANA_CHANNEL_PROGRAM;
  const derived = derivePda(
    [
      CHANNEL_SEED,
      key(input.payer, "payer"),
      key(input.payee, "payee"),
      key(input.mint, "mint"),
      key(input.authorizedSigner, "authorizedSigner"),
      u64(input.salt, "salt"),
      u64(input.openSlot, "openSlot"),
    ],
    programAddress,
  );
  return { channelId: derived.address, bump: derived.bump };
}

function programAddress(value: string | undefined): string {
  const address = value ?? SOLANA_CHANNEL_PROGRAM;
  key(address, "programAddress");
  return address;
}

function mintDetails(mint: ChannelMintAccount): { tokenProgram: string } {
  key(mint.address, "mint");
  return readMint(mint.owner, mint.data);
}

function instruction(
  program: string,
  accounts: Meta[],
  data: Uint8Array,
): { program: string; accounts: Meta[]; data: Uint8Array } {
  return { program, accounts, data };
}

/** Build the unsigned payer/operator-signed channel-open transaction. */
export function buildOpenChannelTransaction(
  input: OpenChannelTransaction,
): Uint8Array {
  if (input.mint !== input.mintAccount.address) {
    fail("mint does not match mintAccount.address.");
  }
  if (input.deposit <= 0n || input.deposit > U64_MAX) {
    fail("deposit is not a positive u64.");
  }
  const gracePeriod = u32(input.gracePeriod, "gracePeriod");
  const program = programAddress(input.programAddress);
  const { tokenProgram } = mintDetails(input.mintAccount);
  const { channelId } = deriveChannelPda({ ...input, programAddress: program });
  const eventAuthority = derivePda([EVENT_AUTHORITY_SEED], program).address;
  const payerTokenAccount = associatedTokenAddress(
    input.payer,
    input.mint,
    tokenProgram,
  );
  const channelTokenAccount = associatedTokenAddress(
    channelId,
    input.mint,
    tokenProgram,
  );
  const data = concatBytes(
    new Uint8Array([1]),
    u64(input.salt, "salt"),
    u64(input.deposit, "deposit"),
    gracePeriod,
    u64(input.openSlot, "openSlot"),
    u32(0, "recipients length"),
  );
  return compileV0(
    input.feePayer,
    [
      instruction(
        program,
        [
          { address: input.payer, signer: true, writable: true },
          { address: input.feePayer, signer: true, writable: true },
          { address: input.payee, signer: false, writable: false },
          { address: input.mint, signer: false, writable: false },
          {
            address: input.authorizedSigner,
            signer: false,
            writable: false,
          },
          { address: channelId, signer: false, writable: true },
          { address: payerTokenAccount, signer: false, writable: true },
          { address: channelTokenAccount, signer: false, writable: true },
          { address: tokenProgram, signer: false, writable: false },
          { address: SYSTEM_PROGRAM, signer: false, writable: false },
          { address: RENT_ACCOUNT, signer: false, writable: false },
          {
            address: SOLANA_PROGRAMS.associatedToken,
            signer: false,
            writable: false,
          },
          { address: eventAuthority, signer: false, writable: false },
          { address: program, signer: false, writable: false },
        ],
        data,
      ),
    ],
    input.recentBlockhash,
  );
}

/** Build the unsigned payer-signed transaction that adds to channel escrow. */
export function buildTopUpChannelTransaction(
  input: TopUpChannelTransaction,
): Uint8Array {
  if (input.amount <= 0n || input.amount > U64_MAX) {
    fail("amount is not a positive u64.");
  }
  const program = programAddress(input.programAddress);
  const { tokenProgram } = mintDetails(input.mintAccount);
  const payerTokenAccount = associatedTokenAddress(
    input.payer,
    input.mintAccount.address,
    tokenProgram,
  );
  const channelTokenAccount = associatedTokenAddress(
    input.channelId,
    input.mintAccount.address,
    tokenProgram,
  );
  return compileV0(
    input.feePayer,
    [
      instruction(
        program,
        [
          { address: input.payer, signer: true, writable: true },
          { address: input.channelId, signer: false, writable: true },
          { address: payerTokenAccount, signer: false, writable: true },
          { address: channelTokenAccount, signer: false, writable: true },
          {
            address: input.mintAccount.address,
            signer: false,
            writable: false,
          },
          { address: tokenProgram, signer: false, writable: false },
        ],
        concatBytes(new Uint8Array([3]), u64(input.amount, "amount")),
      ),
    ],
    input.recentBlockhash,
  );
}

/** Build the unsigned payer-signed request-close transaction. */
export function buildRequestCloseChannelTransaction(
  input: RequestCloseChannelTransaction,
): Uint8Array {
  const program = programAddress(input.programAddress);
  return compileV0(
    input.feePayer,
    [
      instruction(
        program,
        [
          { address: input.payer, signer: true, writable: false },
          { address: input.channelId, signer: false, writable: true },
        ],
        new Uint8Array([5]),
      ),
    ],
    input.recentBlockhash,
  );
}

/** Build the unsigned permissionless transaction that seals an elapsed closing channel. */
export function buildSealChannelTransaction(
  input: SealChannelTransaction,
): Uint8Array {
  const program = programAddress(input.programAddress);
  return compileV0(
    input.feePayer,
    [
      instruction(
        program,
        [{ address: input.channelId, signer: false, writable: true }],
        new Uint8Array([6]),
      ),
    ],
    input.recentBlockhash,
  );
}

/** Build the unsigned payer-signed post-grace-period withdrawal transaction. */
export function buildWithdrawPayerChannelTransaction(
  input: WithdrawPayerChannelTransaction,
): Uint8Array {
  const program = programAddress(input.programAddress);
  const { tokenProgram } = mintDetails(input.mintAccount);
  const channelTokenAccount = associatedTokenAddress(
    input.channelId,
    input.mintAccount.address,
    tokenProgram,
  );
  const payerTokenAccount = associatedTokenAddress(
    input.payer,
    input.mintAccount.address,
    tokenProgram,
  );
  return compileV0(
    input.feePayer,
    [
      instruction(
        program,
        [
          { address: input.payer, signer: true, writable: false },
          { address: input.channelId, signer: false, writable: true },
          { address: channelTokenAccount, signer: false, writable: true },
          { address: payerTokenAccount, signer: false, writable: true },
          {
            address: input.mintAccount.address,
            signer: false,
            writable: false,
          },
          { address: tokenProgram, signer: false, writable: false },
        ],
        new Uint8Array([8]),
      ),
    ],
    input.recentBlockhash,
  );
}

/** Canonical 50-byte payment-channel voucher message. */
export function encodeChannelVoucher(voucher: ChannelVoucher): Uint8Array {
  if (voucher.expiresAt < I64_MIN || voucher.expiresAt > I64_MAX) {
    fail("expiresAt is not an i64.");
  }
  const expiresAt = new Uint8Array(8);
  new DataView(expiresAt.buffer).setBigInt64(0, voucher.expiresAt, true);
  return concatBytes(
    new Uint8Array([0x56, 0x01]),
    key(voucher.channelId, "channelId"),
    u64(voucher.cumulativeAmount, "cumulativeAmount"),
    expiresAt,
  );
}

/** Sign only the voucher bytes encoded from the supplied structured fields. */
export function signVoucher(
  secretKey: Uint8Array,
  voucher: ChannelVoucher,
): Uint8Array {
  if (secretKey.length !== 32) fail("voucher secretKey must be 32 bytes.");
  return ed25519.sign(encodeChannelVoucher(voucher), secretKey);
}

/** Verify an ed25519 signature over the canonical voucher encoding. */
export function verifyVoucher(
  signature: Uint8Array,
  authorizedSigner: string,
  voucher: ChannelVoucher,
): boolean {
  try {
    return ed25519.verify(
      signature,
      encodeChannelVoucher(voucher),
      key(authorizedSigner, "authorizedSigner"),
    );
  } catch {
    return false;
  }
}

function readProgramDataAddress(data: Uint8Array): string {
  if (
    data.length !== 36 ||
    new DataView(data.buffer, data.byteOffset).getUint32(0, true) !== 2
  ) {
    fail("The channel program account is not upgradeable program data.");
  }
  return base58.encode(data.slice(4));
}

function readProgramData(data: Uint8Array): {
  slot: bigint;
  authority: string;
} {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 45 || view.getUint32(0, true) !== 3 || data[12] !== 1) {
    fail("The channel ProgramData account has no pinned upgrade authority.");
  }
  return {
    slot: view.getBigUint64(4, true),
    authority: base58.encode(data.slice(13, 45)),
  };
}

function transactionIsWritable(
  tx: ParsedSolanaTransaction,
  address: string,
): boolean {
  const index = tx.accountKeys.indexOf(address);
  if (index < 0) return false;
  return index < tx.numRequiredSignatures
    ? index < tx.numRequiredSignatures - tx.numReadonlySigned
    : index < tx.accountKeys.length - tx.numReadonlyUnsigned;
}

function transactionIsSigner(
  tx: ParsedSolanaTransaction,
  address: string,
): boolean {
  const index = tx.accountKeys.indexOf(address);
  return index >= 0 && index < tx.numRequiredSignatures;
}

/**
 * Refuse unless the RPC serves the named cluster and its channel program still
 * has the reviewed ProgramData address, deployment slot and upgrade authority.
 */
export async function assertTrustedChannelProgram(
  rpc: SolanaPaymentRpc,
  cluster: string,
  override?: TrustedChannelProgram,
): Promise<TrustedChannelProgram> {
  await assertSolanaCluster(rpc, cluster);
  const builtIn = TRUSTED_CHANNEL_PROGRAMS[cluster];
  if (!builtIn) fail(`No channel program is trusted for ${cluster}.`);
  const trusted = override ?? builtIn;
  key(trusted.address, "channel program");
  key(trusted.programData, "channel ProgramData");
  key(trusted.upgradeAuthority, "channel upgrade authority");

  const program = await rpc.getAccountInfo(trusted.address);
  if (!program) fail("The trusted channel program account is missing.");
  if (program.owner !== BPF_UPGRADEABLE_LOADER) {
    fail("The channel program is not owned by the upgradeable loader.");
  }
  if (readProgramDataAddress(program.data) !== trusted.programData) {
    fail("The channel program points to different ProgramData.");
  }

  const programData = await rpc.getAccountInfo(trusted.programData);
  if (!programData) fail("The trusted channel ProgramData account is missing.");
  if (programData.owner !== BPF_UPGRADEABLE_LOADER) {
    fail("The channel ProgramData is not owned by the upgradeable loader.");
  }
  const deployed = readProgramData(programData.data);
  if (deployed.slot !== trusted.lastDeployedSlot) {
    fail("The channel program was redeployed after it was reviewed.");
  }
  if (deployed.authority !== trusted.upgradeAuthority) {
    fail("The channel program upgrade authority changed.");
  }
  return trusted;
}

/**
 * Verify a wallet-returned open transaction. The canonical open instruction
 * must be unchanged and first; only trailing Lighthouse assertions are
 * accepted. The payer's signature must cover the returned message.
 */
export function verifySignedChannelOpen(
  signed: Uint8Array,
  expected: OpenChannelTransaction,
): string {
  const wanted = parseSolanaTransaction(buildOpenChannelTransaction(expected));
  const got = parseSolanaTransaction(signed);
  if (got.accountKeys[0] !== expected.feePayer) {
    fail("The wallet changed the fee payer.");
  }
  if (got.recentBlockhash !== expected.recentBlockhash) {
    fail("The wallet changed the blockhash.");
  }
  if (
    got.numRequiredSignatures !== wanted.numRequiredSignatures ||
    got.instructions.length === 0 ||
    got.instructions.length > MAX_OPEN_INSTRUCTIONS
  ) {
    fail("The wallet changed the open transaction shape.");
  }
  const wantOpen = wanted.instructions[0];
  const gotOpen = got.instructions[0];
  if (
    !wantOpen ||
    !gotOpen ||
    gotOpen.program !== wantOpen.program ||
    gotOpen.accounts.length !== wantOpen.accounts.length ||
    gotOpen.accounts.some(
      (address, index) => address !== wantOpen.accounts[index],
    ) ||
    !equal(gotOpen.data, wantOpen.data)
  ) {
    fail("The wallet changed the channel-open instruction.");
  }
  for (const address of wanted.accountKeys) {
    if (
      transactionIsSigner(got, address) !==
        transactionIsSigner(wanted, address) ||
      transactionIsWritable(got, address) !==
        transactionIsWritable(wanted, address)
    ) {
      fail("The wallet changed the open transaction's account permissions.");
    }
  }
  for (const added of got.instructions.slice(1)) {
    if (added.program !== SOLANA_PROGRAMS.lighthouse) {
      fail(`The wallet added an instruction for ${added.program}.`);
    }
  }
  if (!verifySolanaSignature(got, expected.payer)) {
    fail(`The transaction is not signed by ${expected.payer}.`);
  }
  return base64.encode(signed);
}
